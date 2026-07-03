/*
 * device_load.js — build a layout FROM the device's reported state (Phase 1,
 * "Load from Device"). The inverse of z2m_adapter.layoutToZ2mSets.
 *
 * The device is the source of truth for its own geometry; the configurator is a
 * consumer/editor of it (CLAUDE.md "Consuming another system's source of truth",
 * 3T-zone-configurator.md §12). The load must therefore distinguish, per zone:
 *
 *   loaded   — the device reported a valid blob; this is real, editable state.
 *   empty    — the device reported '' (octet len 0): NOT provisioned. Absence of
 *              a zone is NOT a zero-area zone. Never act on / write empty as real.
 *   invalid  — the device reported bytes that don't decode (bad length / CRC).
 *              Surfaced, never silently substituted with a plausible default.
 *   unknown  — the key was absent from the report (not yet read). Distinct from
 *              empty: we simply don't know yet. Never fabricate.
 *
 * Pure: no transport, no UI. Feed it the merged property object the converter
 * publishes (collect reports via z2m_adapter.subscribeReports). Returns a
 * layout (emptyLayout shape — only `loaded` zones are populated) plus a parallel
 * zoneStates map and any decode warnings.
 */

import { emptyLayout } from './layout.js';
import { decodePolygon, hexToBytes, DEFAULT_MAX_VERTICES } from './polygon_codec.js';
import { decodeExclusion } from './exclusion_codec.js';
import {
  POLY_KEY, EXCL_KEY, MOUNT_KEY,
} from './z2m_adapter.js';
import { PRESENCE_ZONE_COUNT, ENTRY_EXIT_PAIRS, EXCLUSION_ZONE_COUNT } from './attributes.js';

export const ZONE_STATE = Object.freeze({
  LOADED: 'loaded',
  EMPTY: 'empty',
  INVALID: 'invalid',
  UNKNOWN: 'unknown',
});

/** Classify one reported polygon value; never throws. */
function loadPoly(reports, key, maxVertices, warnings) {
  if (!(key in reports)) return { state: ZONE_STATE.UNKNOWN, poly: null };
  const value = reports[key];
  if (value === '' || value == null) return { state: ZONE_STATE.EMPTY, poly: null };
  try {
    const decoded = decodePolygon(hexToBytes(String(value)), { maxVertices });
    if (!decoded.crcValid) {
      warnings.push(`${key}: CRC mismatch — treated as invalid, not loaded`);
      return { state: ZONE_STATE.INVALID, poly: null };
    }
    return { state: ZONE_STATE.LOADED, poly: { vertices: decoded.vertices } };
  } catch (err) {
    warnings.push(`${key}: ${err.message}`);
    return { state: ZONE_STATE.INVALID, poly: null };
  }
}

/** Classify one reported exclusion value ("x1,y1,x2,y2" or hex octet); never throws. */
function loadExclusion(reports, key, warnings) {
  if (!(key in reports)) return { state: ZONE_STATE.UNKNOWN, rect: null };
  const value = reports[key];
  if (value === '' || value == null) return { state: ZONE_STATE.EMPTY, rect: null };
  try {
    // The converter may surface exclusions as raw octet hex or as a "x,y,x,y"
    // string; accept both so a firmware/converter change doesn't break load.
    if (typeof value === 'string' && value.includes(',')) {
      const parts = value.split(',').map((s) => Number.parseInt(s.trim(), 10));
      if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) {
        throw new Error('expected "x1,y1,x2,y2"');
      }
      const [x1, y1, x2, y2] = parts;
      return { state: ZONE_STATE.LOADED, rect: { x1, y1, x2, y2 } };
    }
    return { state: ZONE_STATE.LOADED, rect: decodeExclusion(hexToBytes(String(value))) };
  } catch (err) {
    warnings.push(`${key}: ${err.message}`);
    return { state: ZONE_STATE.INVALID, rect: null };
  }
}

/**
 * Build a layout + per-zone state from a merged device report object.
 *
 * @param {object} reports  Converter property keys → values (poly_* hex string
 *                          or '', yaw_tenths, inverted, excl_zone_* ).
 * @returns {{ layout, zoneStates, warnings }}
 */
export function layoutFromReports(reports = {}, { maxVertices = DEFAULT_MAX_VERTICES } = {}) {
  const layout = emptyLayout();
  const warnings = [];
  const zoneStates = {
    mount: ZONE_STATE.UNKNOWN,
    master: ZONE_STATE.UNKNOWN,
    presence: new Array(PRESENCE_ZONE_COUNT).fill(ZONE_STATE.UNKNOWN),
    entryExit: Array.from({ length: ENTRY_EXIT_PAIRS }, () => ({
      inner: ZONE_STATE.UNKNOWN, outer: ZONE_STATE.UNKNOWN,
    })),
    exclusions: new Array(EXCLUSION_ZONE_COUNT).fill(ZONE_STATE.UNKNOWN),
  };

  // Mount: only adopt the device's frame if it actually reported it. A missing
  // yaw/inverted stays at the emptyLayout default but is flagged UNKNOWN so the
  // UI never presents a fabricated 0°/upright as if read from the device.
  const hasYaw = MOUNT_KEY.yaw in reports;
  const hasInv = MOUNT_KEY.inverted in reports;
  if (hasYaw || hasInv) {
    if (hasYaw) layout.mount.yawDeciDeg = Number(reports[MOUNT_KEY.yaw]);
    if (hasInv) layout.mount.inverted = !!reports[MOUNT_KEY.inverted];
    zoneStates.mount = (hasYaw && hasInv) ? ZONE_STATE.LOADED : ZONE_STATE.UNKNOWN;
  }

  const master = loadPoly(reports, POLY_KEY.master, maxVertices, warnings);
  zoneStates.master = master.state;
  layout.master = master.poly;

  for (let n = 0; n < PRESENCE_ZONE_COUNT; n++) {
    const r = loadPoly(reports, POLY_KEY.presence[n], maxVertices, warnings);
    zoneStates.presence[n] = r.state;
    layout.presence[n] = r.poly;
  }

  for (let i = 0; i < ENTRY_EXIT_PAIRS; i++) {
    const inner = loadPoly(reports, POLY_KEY.ez[i].inner, maxVertices, warnings);
    const outer = loadPoly(reports, POLY_KEY.ez[i].outer, maxVertices, warnings);
    zoneStates.entryExit[i] = { inner: inner.state, outer: outer.state };
    // A pair is only a usable layout entry if at least one side loaded.
    if (inner.poly || outer.poly) {
      layout.entryExit[i] = { inner: inner.poly, outer: outer.poly };
    }
  }

  for (let i = 0; i < EXCLUSION_ZONE_COUNT; i++) {
    const r = loadExclusion(reports, EXCL_KEY[i], warnings);
    zoneStates.exclusions[i] = r.state;
    layout.exclusions[i] = r.rect;
  }

  return { layout, zoneStates, warnings };
}

/** The ordered set of converter keys a full "Read from device" should request. */
export function deviceReadKeys() {
  return [
    MOUNT_KEY.yaw, MOUNT_KEY.inverted,
    POLY_KEY.master,
    ...POLY_KEY.presence,
    ...POLY_KEY.ez.flatMap((p) => [p.inner, p.outer]),
    ...EXCL_KEY,
  ];
}

/** True if any zone in the loaded state map holds real, device-sourced geometry. */
export function hasLoadedGeometry(zoneStates) {
  const any = (s) => s === ZONE_STATE.LOADED;
  return (
    any(zoneStates.master) ||
    zoneStates.presence.some(any) ||
    zoneStates.entryExit.some((p) => any(p.inner) || any(p.outer)) ||
    zoneStates.exclusions.some(any)
  );
}
