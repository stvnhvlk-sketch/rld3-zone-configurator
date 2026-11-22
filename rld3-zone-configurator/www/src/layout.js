/* Shared restart editor model and versioned local JSON helpers.
 * Polygons are in the room frame; native sensor masks stay in the sensor frame.
 * Legacy EZ input remains recognizable so it can be refused explicitly.
 */

import {validatePolygon,DEFAULT_MAX_VERTICES} from './polygon_codec.js';
import {ENTRY_EXIT_PAIRS,EXCLUSION_ZONE_COUNT,OCCUPANCY_ZONE_STYLE,isOccupancyZoneStyle,PRESENCE_ZONE_COUNT} from './attributes.js';

/* Sensor room-space offset bound (mm) — mirrors mount_angle_nvs.c's
 * MOUNT_OFFSET_MM_MAX, the same ±10000 mm bound every position input in the
 * architecture already uses (3T-mounting.md §6). */
const MOUNT_OFFSET_MM_MAX = 10000;

/* Mount height bound (mm) — mirrors MOUNT_HEIGHT_MM_MAX in mount_angle_nvs.c.
 * 0 means "not configured", which disables the elevation correction, exactly
 * as it does in the firmware. */
const MOUNT_HEIGHT_MM_MAX = 3000;

export const LAYOUT_VERSION = 2;

/** A fresh, empty layout. Undefined zones are simply absent (not written). */
export function emptyLayout() {
  return {
    mount: { yawDeciDeg: 0, inverted: false, offsetXMm: 0, offsetYMm: 0, heightMm: 0 },
    master: null, // { vertices: [...] } or null
    presence: new Array(12).fill(null),
    entryExit: new Array(ENTRY_EXIT_PAIRS).fill(null), // Legacy import refusal; never offered in the editor.
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
  // Height is unsigned and, unlike the offsets, is never written back.
  const h = layout?.mount?.heightMm;
  if (h !== undefined && (!Number.isInteger(h) || h < 0 || h > MOUNT_HEIGHT_MM_MAX)) {
    errors.push(`mount.heightMm ${h} outside [0, ${MOUNT_HEIGHT_MM_MAX}]`);
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

  return { ok: errors.length === 0, errors, warnings: [] };
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
