/*
 * layout_codec.js — restart layout blob codec (mirror of rld3_layout.h).
 *
 * The C header restart/components/rld3_interface/include/rld3_layout.h is the
 * source of truth for the byte layout; this file follows it and
 * test/layout_codec.test.js pins the two together (constants parsed from the
 * header, and a reference blob hash emitted by the C host test).
 *
 * Schema 1, little-endian, fixed size LAYOUT_BYTES with a CRC-32 trailer over
 * the body. See the header comment in rld3_layout.h for the offset table.
 */

import { crc32 } from './polygon_codec.js';

export const LAYOUT_SCHEMA = 1;
export const LAYOUT_INTERFACE_REVISION = 1;
export const LAYOUT_MAX_VERTICES = 12;
export const LAYOUT_NAME_BYTES = 16;
export const LAYOUT_RECORD_COUNT = 12;
export const LAYOUT_NATIVE_ZONE_COUNT = 3;
export const LAYOUT_POLYGON_BYTES = 2 + 4 * LAYOUT_MAX_VERTICES;
export const LAYOUT_RECORD_BYTES = 6 + LAYOUT_NAME_BYTES + LAYOUT_POLYGON_BYTES;
export const LAYOUT_HEADER_BYTES = 12;
export const LAYOUT_POSE_BYTES = 12;
export const LAYOUT_NATIVE_BYTES = 2 + 8 * LAYOUT_NATIVE_ZONE_COUNT;
export const LAYOUT_BODY_BYTES = LAYOUT_HEADER_BYTES + LAYOUT_POSE_BYTES
  + LAYOUT_POLYGON_BYTES + LAYOUT_RECORD_COUNT * LAYOUT_RECORD_BYTES
  + LAYOUT_NATIVE_BYTES;
export const LAYOUT_BYTES = LAYOUT_BODY_BYTES + 4;

export const POLICY = Object.freeze({ normal: 0, transit_only: 1, impossible: 2 });
export const STYLE = Object.freeze({ none: 0, default: 1, chair: 2, table: 3, couch: 4, bed: 5 });
export const BOUNDARY = Object.freeze({ none: 0, source: 1, sink: 2, source_and_sink: 3 });
export const REFLECTION = Object.freeze({ none: 0, experimental: 1 });
export const NATIVE_MODE = Object.freeze({ disabled: 0, detection: 1, exclusion: 2 });

const FLAG_MASTER_ACTIVE = 0x01;
const FLAG_EXPERIMENTAL_REFLECTION = 0x02;
const FLAG_INVERTED = 0x04;
const FLAG_RECORD_ACTIVE = 0x01;

/** A layout object with every field present and defaulted. */
export function emptyLayout() {
  return {
    generation: 0,
    originXmm: 0, originYmm: 0, sensorHeightMm: 0, yawTenths: 0,
    inverted: false, scattererHeightMm: 0, geometryUncertaintyMm: 0,
    masterActive: false, experimentalReflection: false,
    master: [],
    records: Array.from({ length: LAYOUT_RECORD_COUNT }, () => ({
      spatialId: 0, active: false, policy: 0, style: 0, boundaryRole: 0,
      reflectionProfile: 0, name: '', polygon: [],
    })),
    nativeMode: 0,
    nativeZones: Array.from({ length: LAYOUT_NATIVE_ZONE_COUNT }, () => ({ x0: 0, y0: 0, x1: 0, y1: 0 })),
  };
}

class LayoutError extends Error {
  constructor(reason, detail) { super(`${reason}${detail === undefined ? '' : ` (${detail})`}`); this.reason = reason; this.detail = detail; }
}
export { LayoutError };

const i16ok = (v) => Number.isInteger(v) && v >= -32768 && v <= 32767;
const u16ok = (v) => Number.isInteger(v) && v >= 0 && v <= 65535;

function checkPolygon(polygon, required, which) {
  if (!required && polygon.length === 0) return;
  if (polygon.length < 3 || polygon.length > LAYOUT_MAX_VERTICES) throw new LayoutError('vertex_count', which);
  for (const [x, y] of polygon) {
    if (!i16ok(x) || !i16ok(y)) throw new LayoutError('coordinate', which);
  }
}

function checkName(name, which) {
  if (typeof name !== 'string' || name.length >= LAYOUT_NAME_BYTES) throw new LayoutError('name', which);
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    if (c < 0x20 || c > 0x7e) throw new LayoutError('name', which);
  }
}

/** Structural validation only; geometry validity (self-intersection, ids) is the device's spatial policy. */
export function validateLayout(l) {
  if (!u16ok(l.sensorHeightMm) || l.sensorHeightMm > 3000 || !u16ok(l.scattererHeightMm)
    || l.scattererHeightMm > l.sensorHeightMm || !Number.isInteger(l.yawTenths)
    || l.yawTenths < -1800 || l.yawTenths > 1800 || !i16ok(l.originXmm) || !i16ok(l.originYmm)
    || !u16ok(l.geometryUncertaintyMm)) throw new LayoutError('range', 0);
  if (!Number.isInteger(l.generation) || l.generation < 0 || l.generation > 0xffffffff) throw new LayoutError('range', 0);
  checkPolygon(l.master, l.masterActive, 'master');
  if (l.records.length !== LAYOUT_RECORD_COUNT) throw new LayoutError('records');
  l.records.forEach((r, i) => {
    if (![0, 1, 2].includes(r.policy) || ![0, 1, 2, 3, 4, 5].includes(r.style)
      || ![0, 1, 2, 3].includes(r.boundaryRole) || ![0, 1].includes(r.reflectionProfile)
      || !Number.isInteger(r.spatialId) || r.spatialId < 0 || r.spatialId > 255) throw new LayoutError('enum', i);
    if (r.boundaryRole && r.polygon.length === 2) {
      r.polygon.forEach(([x,y]) => { if (!i16ok(x)||!i16ok(y)) throw new LayoutError('coordinate',i); });
      if (!u16ok(r.doorToleranceMm ?? 0)) throw new LayoutError('range',i);
    } else checkPolygon(r.polygon, r.active, i);
    checkName(r.name, i);
  });
  if (![0, 1, 2].includes(l.nativeMode)) throw new LayoutError('enum', 'native');
  if (l.nativeZones.length !== LAYOUT_NATIVE_ZONE_COUNT) throw new LayoutError('records');
  for (const z of l.nativeZones) {
    if (![z.x0, z.y0, z.x1, z.y1].every(i16ok) || z.x0 > z.x1 || z.y0 > z.y1) throw new LayoutError('range', 1);
  }
}

function putPolygon(view, off, polygon) {
  view.setUint8(off, polygon.length);
  view.setUint8(off + 1, 0);
  polygon.forEach(([x, y], i) => {
    view.setInt16(off + 2 + 4 * i, x, true);
    view.setInt16(off + 4 + 4 * i, y, true);
  });
}

/** Encode a layout to a Uint8Array of LAYOUT_BYTES. Throws LayoutError. */
export function encodeLayout(l) {
  validateLayout(l);
  const buf = new Uint8Array(LAYOUT_BYTES);
  const view = new DataView(buf.buffer);
  view.setUint8(0, LAYOUT_SCHEMA);
  view.setUint8(1, (l.masterActive ? FLAG_MASTER_ACTIVE : 0)
    | (l.experimentalReflection ? FLAG_EXPERIMENTAL_REFLECTION : 0)
    | (l.inverted ? FLAG_INVERTED : 0));
  view.setUint16(2, LAYOUT_INTERFACE_REVISION, true);
  view.setUint32(4, l.generation, true);
  let off = LAYOUT_HEADER_BYTES;
  view.setInt16(off, l.originXmm, true);
  view.setInt16(off + 2, l.originYmm, true);
  view.setUint16(off + 4, l.sensorHeightMm, true);
  view.setInt16(off + 6, l.yawTenths, true);
  view.setUint16(off + 8, l.scattererHeightMm, true);
  view.setUint16(off + 10, l.geometryUncertaintyMm, true);
  off += LAYOUT_POSE_BYTES;
  putPolygon(view, off, l.master);
  off += LAYOUT_POLYGON_BYTES;
  for (const r of l.records) {
    view.setUint8(off, r.spatialId);
    view.setUint8(off + 1, r.active ? FLAG_RECORD_ACTIVE : 0);
    view.setUint8(off + 2, r.policy);
    view.setUint8(off + 3, r.style);
    view.setUint8(off + 4, r.boundaryRole);
    view.setUint8(off + 5, r.reflectionProfile);
    for (let i = 0; i < r.name.length; i++) view.setUint8(off + 6 + i, r.name.charCodeAt(i));
    putPolygon(view, off + 6 + LAYOUT_NAME_BYTES, r.polygon);
    if (r.boundaryRole && r.polygon.length === 2)
      view.setUint16(off + 6 + LAYOUT_NAME_BYTES + 10, r.doorToleranceMm ?? 0, true);
    off += LAYOUT_RECORD_BYTES;
  }
  view.setUint8(off, l.nativeMode);
  view.setUint8(off + 1, 0);
  l.nativeZones.forEach((z, i) => {
    view.setInt16(off + 2 + 8 * i, z.x0, true);
    view.setInt16(off + 4 + 8 * i, z.y0, true);
    view.setInt16(off + 6 + 8 * i, z.x1, true);
    view.setInt16(off + 8 + 8 * i, z.y1, true);
  });
  view.setUint32(LAYOUT_BODY_BYTES, crc32(buf.subarray(0, LAYOUT_BODY_BYTES)), true);
  return buf;
}

/** The hash the device reports for a blob: its CRC-32 trailer value. */
export function layoutHash(buf) {
  if (!(buf instanceof Uint8Array) || buf.length !== LAYOUT_BYTES) return 0;
  return crc32(buf.subarray(0, LAYOUT_BODY_BYTES));
}

function getPolygon(view, off, which, door = false) {
  const count = view.getUint8(off);
  if (view.getUint8(off + 1) !== 0) throw new LayoutError('reserved', which);
  if (count > LAYOUT_MAX_VERTICES) throw new LayoutError('vertex_count', which);
  const polygon = [];
  for (let i = 0; i < LAYOUT_MAX_VERTICES; i++) {
    const x = view.getInt16(off + 2 + 4 * i, true);
    const y = view.getInt16(off + 4 + 4 * i, true);
    if (i < count) polygon.push([x, y]);
    else if (door && count === 2 && i === 2 && y === 0) { /* tolerance field */ }
    else if (x !== 0 || y !== 0) throw new LayoutError('reserved', which);
  }
  return polygon;
}

/** Decode and validate a blob. Throws LayoutError with the same reasons as the C decoder. */
export function decodeLayout(buf) {
  if (!(buf instanceof Uint8Array) || buf.length !== LAYOUT_BYTES) throw new LayoutError('length');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint8(0) !== LAYOUT_SCHEMA) throw new LayoutError('schema_unknown', view.getUint8(0));
  if (view.getUint32(LAYOUT_BODY_BYTES, true) !== crc32(buf.subarray(0, LAYOUT_BODY_BYTES))) throw new LayoutError('hash');
  if (view.getUint16(2, true) !== LAYOUT_INTERFACE_REVISION) throw new LayoutError('revision', view.getUint8(2));
  const flags = view.getUint8(1);
  if ((flags & ~(FLAG_MASTER_ACTIVE | FLAG_EXPERIMENTAL_REFLECTION | FLAG_INVERTED)) !== 0
    || view.getUint32(8, true) !== 0) throw new LayoutError('reserved', 1);
  const l = emptyLayout();
  l.masterActive = (flags & FLAG_MASTER_ACTIVE) !== 0;
  l.experimentalReflection = (flags & FLAG_EXPERIMENTAL_REFLECTION) !== 0;
  l.inverted = (flags & FLAG_INVERTED) !== 0;
  l.generation = view.getUint32(4, true);
  let off = LAYOUT_HEADER_BYTES;
  l.originXmm = view.getInt16(off, true);
  l.originYmm = view.getInt16(off + 2, true);
  l.sensorHeightMm = view.getUint16(off + 4, true);
  l.yawTenths = view.getInt16(off + 6, true);
  l.scattererHeightMm = view.getUint16(off + 8, true);
  l.geometryUncertaintyMm = view.getUint16(off + 10, true);
  off += LAYOUT_POSE_BYTES;
  l.master = getPolygon(view, off, 'master');
  off += LAYOUT_POLYGON_BYTES;
  for (let i = 0; i < LAYOUT_RECORD_COUNT; i++) {
    const r = l.records[i];
    r.spatialId = view.getUint8(off);
    const rf = view.getUint8(off + 1);
    if ((rf & ~FLAG_RECORD_ACTIVE) !== 0) throw new LayoutError('reserved', i);
    r.active = (rf & FLAG_RECORD_ACTIVE) !== 0;
    r.policy = view.getUint8(off + 2);
    r.style = view.getUint8(off + 3);
    r.boundaryRole = view.getUint8(off + 4);
    r.reflectionProfile = view.getUint8(off + 5);
    const bytes = buf.subarray(off + 6, off + 6 + LAYOUT_NAME_BYTES);
    const nul = bytes.indexOf(0);
    if (nul < 0) throw new LayoutError('name', i);
    for (let k = nul; k < LAYOUT_NAME_BYTES; k++) if (bytes[k] !== 0) throw new LayoutError('name', i);
    r.name = String.fromCharCode(...bytes.subarray(0, nul));
    r.polygon = getPolygon(view, off + 6 + LAYOUT_NAME_BYTES, i, !!r.boundaryRole);
    if (r.boundaryRole && r.polygon.length === 2) r.doorToleranceMm = view.getUint16(off + 6 + LAYOUT_NAME_BYTES + 10, true);
    off += LAYOUT_RECORD_BYTES;
  }
  l.nativeMode = view.getUint8(off);
  if (view.getUint8(off + 1) !== 0) throw new LayoutError('reserved', 'native');
  for (let i = 0; i < LAYOUT_NATIVE_ZONE_COUNT; i++) {
    l.nativeZones[i] = {
      x0: view.getInt16(off + 2 + 8 * i, true), y0: view.getInt16(off + 4 + 8 * i, true),
      x1: view.getInt16(off + 6 + 8 * i, true), y1: view.getInt16(off + 8 + 8 * i, true),
    };
  }
  validateLayout(l);
  return l;
}

/** The transform the device derives: height above scatterer, or 0 when no correction is configured. */
export function derivedTransform(l) {
  return {
    yawTenths: l.yawTenths, inverted: l.inverted,
    heightMm: 0, // D-24: retained layout heights never affect room positions.
    offsetXmm: l.originXmm, offsetYmm: l.originYmm,
  };
}
