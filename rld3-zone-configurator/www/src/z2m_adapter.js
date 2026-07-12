/*
 * z2m_adapter.js — Zigbee2MQTT transport adapter (§7).
 *
 * Speaks the RLD3Target.mjs external converter's property keys over MQTT. The
 * converter is a thin pass-through: it takes a polygon as a 112-char hex string
 * (the RAW 56-byte polygon_t — zigbee-herdsman adds the ZCL octet length
 * prefix) and an exclusion zone as "x1,y1,x2,y2" sensor-frame mm. So this
 * adapter does the serialization (via the codecs) and the converter just
 * forwards the bytes. Matches _Zigbee2MQTT/RLD3Target.mjs.
 *
 * The network is injected as `transport` so message construction is unit-
 * testable without a broker:
 *   transport.publish(topic, payloadString)
 *   transport.subscribe(topic, (payloadString) => void)   // optional, for reports
 *
 * For a browser tool, transport wraps an MQTT-over-WebSocket client
 * (HA Mosquitto add-on: ws://<host>:1884). For Node/bench, raw MQTT (:1883).
 */

import { encodePolygon, bytesToHex, DEFAULT_MAX_VERTICES } from './polygon_codec.js';
import { validateLayout } from './layout.js';
import { PRESENCE_ZONE_COUNT } from './attributes.js';

/*
 * Converter property keys (mirror RLD3Target.mjs POLY_KEY_TO_ATTR / EXCL_KEY_TO_IDX).
 * Key STRINGS are 1-based (Phase N, 3T-zone-configurator.md §14) — installers never
 * see a "zone 0". Array/object INDICES here stay 0-based internals (presence[0] is
 * the first zone, ez[0] is the first pair) — only the string value each index maps
 * to has shifted by one. Everything downstream imports these constants, so no other
 * file needs to know the key text changed.
 */
export const POLY_KEY = {
  master: 'poly_master',
  presence: ['poly_pres_1', 'poly_pres_2', 'poly_pres_3', 'poly_pres_4',
             'poly_pres_5', 'poly_pres_6', 'poly_pres_7', 'poly_pres_8'],   // V2.1 Delta B
  ez: [
    { inner: 'poly_ez1_in', outer: 'poly_ez1_out' },
    { inner: 'poly_ez2_in', outer: 'poly_ez2_out' },
  ],
};
export const EXCL_KEY = ['excl_zone_1', 'excl_zone_2', 'excl_zone_3'];
export const MOUNT_KEY = { yaw: 'yaw_tenths', inverted: 'inverted' };

/**
 * Project a layout to the ordered list of Z2M converter {key, value} sets.
 * Pure — no MQTT. Mounting first, then defined polygons, then exclusions.
 * Undefined zones are skipped. Throws on an invalid layout.
 */
export function layoutToZ2mSets(layout, { maxVertices = DEFAULT_MAX_VERTICES } = {}) {
  const { ok, errors } = validateLayout(layout, { maxVertices });
  if (!ok) throw new Error(`invalid layout: ${errors.join('; ')}`);

  const sets = [];
  const polyHex = (vertices) => bytesToHex(encodePolygon(vertices, { maxVertices }));
  const addPoly = (key, p) => { if (p != null) sets.push({ key, value: polyHex(p.vertices) }); };

  sets.push({ key: MOUNT_KEY.yaw, value: layout.mount.yawDeciDeg });
  sets.push({ key: MOUNT_KEY.inverted, value: !!layout.mount.inverted });

  addPoly(POLY_KEY.master, layout.master);
  for (let n = 0; n < PRESENCE_ZONE_COUNT; n++) addPoly(POLY_KEY.presence[n], layout.presence?.[n]);
  layout.entryExit?.forEach((pair, i) => {
    if (pair == null) return;
    addPoly(POLY_KEY.ez[i].inner, pair.inner);
    addPoly(POLY_KEY.ez[i].outer, pair.outer);
  });
  layout.exclusions?.forEach((r, i) => {
    if (r == null) return;
    sets.push({ key: EXCL_KEY[i], value: `${r.x1},${r.y1},${r.x2},${r.y2}` });
  });

  return sets;
}

/**
 * Build a Z2M adapter bound to one device.
 * @param {object} opts
 * @param {{publish:Function, subscribe?:Function}} opts.transport
 * @param {string} opts.device   Z2M friendly name (or IEEE address)
 * @param {string} [opts.baseTopic='zigbee2mqtt']
 * @param {number} [opts.maxVertices]
 */
export function createZ2mAdapter({ transport, device, baseTopic = 'zigbee2mqtt', maxVertices = DEFAULT_MAX_VERTICES }) {
  if (!transport || typeof transport.publish !== 'function') {
    throw new TypeError('transport.publish is required');
  }
  if (!device) throw new TypeError('device (friendly name) is required');

  const setTopic = `${baseTopic}/${device}/set`;
  const getTopic = `${baseTopic}/${device}/get`;
  const stateTopic = `${baseTopic}/${device}`;

  /** Write a single converter key (state change request). */
  function setKey(key, value) {
    transport.publish(setTopic, JSON.stringify({ [key]: value }));
  }

  /** Request a read of one or more converter keys (device echoes on stateTopic). */
  function readKeys(keys) {
    const payload = {};
    for (const k of Array.isArray(keys) ? keys : [keys]) payload[k] = '';
    transport.publish(getTopic, JSON.stringify(payload));
  }

  /**
   * Provision a full layout. Publishes each set in order. Z2M serializes
   * per-device, so writes are applied sequentially; callers wanting explicit
   * confirmation should subscribe to reports and await the echoed state (§8.3).
   */
  function provision(layout) {
    const sets = layoutToZ2mSets(layout, { maxVertices });
    for (const { key, value } of sets) setKey(key, value);
    return sets.length;
  }

  /** Subscribe to the device's published state; parses JSON and forwards it. */
  function subscribeReports(cb) {
    if (typeof transport.subscribe !== 'function') {
      throw new Error('transport.subscribe is required for reports');
    }
    transport.subscribe(stateTopic, (payload) => {
      let obj;
      try { obj = JSON.parse(payload); } catch { return; }
      cb(obj);
    });
  }

  function deviceInfo() {
    return { device, baseTopic, setTopic, getTopic, stateTopic, maxVertices };
  }

  return { setKey, readKeys, provision, subscribeReports, deviceInfo };
}
