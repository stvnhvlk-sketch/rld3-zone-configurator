/*
 * layout.js — the room layout model: mount + all zones + exclusions.
 *
 * This is the document the configurator saves/loads (§9 "local save/load of
 * room layouts, JSON, independent of device state") and the thing it turns
 * into an ordered sequence of Zigbee writes (§7/§8.3). It depends only on the
 * codecs, the geometry layer, and the attribute map — no transport, no UI.
 *
 * Frames:
 *   - Polygons (master, presence, entry/exit) are ROOM frame.
 *   - Exclusion rectangles are stored in SENSOR frame (their wire form). The UI
 *     authors them in room frame and reprojects via geometry.roomRectToSensorBBox
 *     before they land here; this model holds the canonical sensor-frame rect.
 */

import { encodePolygon, validatePolygon, DEFAULT_MAX_VERTICES } from './polygon_codec.js';
import { encodeExclusion } from './exclusion_codec.js';
import {
  ATTR_YAW_TENTHS, ATTR_INVERTED, ATTR_MOUNT_OFFSET_X_MM, ATTR_MOUNT_OFFSET_Y_MM,
  ATTR_POLY_MASTER, ATTR_POLY_PRES, ATTR_POLY_EZ,
  ATTR_EXCL, PRESENCE_ZONE_COUNT, ENTRY_EXIT_PAIRS, EXCLUSION_ZONE_COUNT,
  OCCUPANCY_ZONE_STYLE, isOccupancyZoneStyle, occupancyZoneStyleCode, attrZcfg,
} from './attributes.js';

/* Sensor room-space offset bound (mm) — mirrors mount_angle_nvs.c's
 * MOUNT_OFFSET_MM_MAX, the same ±10000 mm bound every position input in the
 * architecture already uses (3T-mounting.md §6). */
const MOUNT_OFFSET_MM_MAX = 10000;

export const LAYOUT_VERSION = 2;

/** A fresh, empty layout. Undefined zones are simply absent (not written). */
export function emptyLayout() {
  return {
    mount: { yawDeciDeg: 0, inverted: false, offsetXMm: 0, offsetYMm: 0 },
    master: null, // { vertices: [...] } or null
    presence: new Array(PRESENCE_ZONE_COUNT).fill(null),
    entryExit: new Array(ENTRY_EXIT_PAIRS).fill(null), // { inner:{vertices}, outer:{vertices} }
    exclusions: new Array(EXCLUSION_ZONE_COUNT).fill(null), // { x1,y1,x2,y2 } sensor frame
  };
}

/* ----------------------------------------------------------------------------
 * Validation — aggregates every polygon through the codec's rules.
 * ------------------------------------------------------------------------- */

function checkPoly(label, poly, maxVertices, errors) {
  if (poly == null) return;
  const { ok, errors: e } = validatePolygon(poly.vertices, { maxVertices });
  if (!ok) errors.push(`${label}: ${e.join('; ')}`);
}

export function validateLayout(layout, { maxVertices = DEFAULT_MAX_VERTICES } = {}) {
  const errors = [];

  const yaw = layout?.mount?.yawDeciDeg;
  if (!Number.isInteger(yaw) || yaw < -1800 || yaw > 1800) {
    errors.push(`mount.yawDeciDeg ${yaw} outside [-1800, 1800]`);
  }
  if (typeof layout?.mount?.inverted !== 'boolean') {
    errors.push('mount.inverted must be boolean');
  }
  // Absent is valid (defaults to 0, "disabled" — same convention every other
  // absence-means-default field in this codebase uses); a PRESENT value must
  // still be a valid in-range integer.
  for (const k of ['offsetXMm', 'offsetYMm']) {
    const v = layout?.mount?.[k];
    if (v !== undefined && (!Number.isInteger(v) || v < -MOUNT_OFFSET_MM_MAX || v > MOUNT_OFFSET_MM_MAX)) {
      errors.push(`mount.${k} ${v} outside [-${MOUNT_OFFSET_MM_MAX}, ${MOUNT_OFFSET_MM_MAX}]`);
    }
  }

  checkPoly('master', layout.master, maxVertices, errors);
  layout.presence?.forEach((p, i) => {
    checkPoly(`presence[${i}]`, p, maxVertices, errors);
    if (p != null && p.style !== undefined && !isOccupancyZoneStyle(p.style)) {
      errors.push(`presence[${i}].style ${p.style} is invalid`);
    }
  });
  layout.entryExit?.forEach((pair, i) => {
    if (pair == null) return;
    checkPoly(`entryExit[${i}].inner`, pair.inner, maxVertices, errors);
    checkPoly(`entryExit[${i}].outer`, pair.outer, maxVertices, errors);
  });
  layout.exclusions?.forEach((r, i) => {
    if (r == null) return;
    for (const k of ['x1', 'y1', 'x2', 'y2']) {
      if (!Number.isInteger(r[k]) || r[k] < -32768 || r[k] > 32767) {
        errors.push(`exclusion[${i}].${k} not int16 mm`);
      }
    }
  });

  return { ok: errors.length === 0, errors };
}

/* ----------------------------------------------------------------------------
 * JSON save / load (versioned envelope)
 * ------------------------------------------------------------------------- */

function withExplicitStyles(layout) {
  const out = JSON.parse(JSON.stringify({ ...emptyLayout(), ...layout }));
  out.presence = (out.presence ?? []).map((zone) => zone == null
    ? null
    : { ...zone, style: zone.style ?? OCCUPANCY_ZONE_STYLE.DEFAULT });
  while (out.presence.length < PRESENCE_ZONE_COUNT) out.presence.push(null);
  return out;
}

export function layoutToJSON(layout, { pretty = true } = {}) {
  const envelope = { version: LAYOUT_VERSION, layout: withExplicitStyles(layout) };
  return JSON.stringify(envelope, null, pretty ? 2 : 0);
}

export function layoutFromJSON(text) {
  const env = JSON.parse(text);
  if (env.version !== 1 && env.version !== LAYOUT_VERSION) {
    throw new Error(`unsupported layout version ${env.version} (expected 1 or ${LAYOUT_VERSION})`);
  }
  // Version 1 had geometry only. Upgrade in memory by assigning DEFAULT style
  // to every defined presence polygon; no device state is changed by import.
  return withExplicitStyles({ ...emptyLayout(), ...env.layout });
}

/* ----------------------------------------------------------------------------
 * Write plan — ordered list of attribute writes for a transport adapter.
 * ------------------------------------------------------------------------- */

/**
 * Produce the ordered writes that provision this layout. Each step is
 * { attrId, label, type, bytes|value }. The adapter executes them in order,
 * waiting for confirmation between steps (§8.3). Mount is written first so the
 * device's frame is correct before anything that depends on it; polygons and
 * exclusions follow. Undefined zones are skipped (not zeroed).
 *
 * Throws if the layout is invalid — never emit a write plan for a bad layout.
 */
export function layoutToWritePlan(layout, { maxVertices = DEFAULT_MAX_VERTICES } = {}) {
  const { ok, errors } = validateLayout(layout, { maxVertices });
  if (!ok) throw new Error(`invalid layout: ${errors.join('; ')}`);

  const steps = [];
  // `bytes` is the RAW polygon_t blob (56 B). The ZCL octet length prefix is
  // added by the transport (zigbee-herdsman / zigpy), not here — see the Z2M
  // converter, which writes the raw Buffer. Use toZclOctet() only for a
  // hand-rolled frame.
  const poly = (attrId, label, p) => {
    if (p == null) return;
    steps.push({
      attrId, label, type: 'octet',
      bytes: encodePolygon(p.vertices, { maxVertices }),
    });
  };

  // 1. Mounting — must precede frame-dependent verification. The offset is
  // part of "frame-dependent" too (2026-08-08): it changes what room frame
  // the polygons below are interpreted in, exactly like yaw/inverted do.
  steps.push({ attrId: ATTR_YAW_TENTHS, label: 'yaw', type: 'int16', value: layout.mount.yawDeciDeg });
  steps.push({ attrId: ATTR_INVERTED, label: 'inverted', type: 'bool', value: !!layout.mount.inverted });
  steps.push({ attrId: ATTR_MOUNT_OFFSET_X_MM, label: 'mount offset X', type: 'int16', value: layout.mount.offsetXMm ?? 0 });
  steps.push({ attrId: ATTR_MOUNT_OFFSET_Y_MM, label: 'mount offset Y', type: 'int16', value: layout.mount.offsetYMm ?? 0 });

  // 2. Polygons (room frame).
  poly(ATTR_POLY_MASTER, 'master', layout.master);
  layout.presence?.forEach((p, i) => {
    poly(ATTR_POLY_PRES[i], `presence[${i}]`, p);
    if (p != null) {
      const style = p.style ?? OCCUPANCY_ZONE_STYLE.DEFAULT;
      steps.push({
        attrId: attrZcfg(i, 'style'), label: `presence[${i}].style`,
        type: 'uint8', value: occupancyZoneStyleCode(style),
      });
    }
  });
  layout.entryExit?.forEach((pair, i) => {
    if (pair == null) return;
    poly(ATTR_POLY_EZ[i].inner, `entryExit[${i}].inner`, pair.inner);
    poly(ATTR_POLY_EZ[i].outer, `entryExit[${i}].outer`, pair.outer);
  });

  // 3. Exclusion zones (sensor frame, 8-byte octet).
  layout.exclusions?.forEach((r, i) => {
    if (r == null) return;
    steps.push({
      attrId: ATTR_EXCL[i], label: `exclusion[${i}]`, type: 'octet',
      bytes: encodeExclusion(r),
    });
  });

  return steps;
}
