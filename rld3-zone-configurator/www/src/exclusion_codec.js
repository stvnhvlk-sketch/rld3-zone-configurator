/*
 * exclusion_codec.js — LD2450 exclusion-zone wire codec.
 *
 * Exclusion zones are the LD2450's native zones: axis-aligned rectangles in
 * SENSOR frame (not room frame — see 3T-zone-configurator.md §6, "the one
 * frame trap"). Wire form is an 8-byte octet string: x1,y1,x2,y2 as int16 LE.
 * Attributes 0x0220–0x0222, write-only (zigbee.h). decode_excl_octets() in
 * zigbee.c rejects any length ≠ 8.
 *
 * This codec handles ONLY the byte layout. The room→sensor reprojection that
 * §6 demands (inverse yaw + inversion before drawing/writing) belongs in the
 * geometry layer, which reads yaw/inversion from 0x0100/0x0101 first.
 */

export const EXCL_BYTES = 8;
const COORD_MIN = -32768;
const COORD_MAX = 32767;

/**
 * Encode a sensor-frame rectangle to the 8-byte exclusion blob.
 * @param {{x1:number,y1:number,x2:number,y2:number}} rect  sensor-frame mm
 * @returns {Uint8Array}
 */
export function encodeExclusion({ x1, y1, x2, y2 }) {
  for (const [name, val] of [['x1', x1], ['y1', y1], ['x2', x2], ['y2', y2]]) {
    if (!Number.isInteger(val) || val < COORD_MIN || val > COORD_MAX) {
      throw new RangeError(`exclusion ${name}=${val} not int16 mm`);
    }
  }
  const buf = new Uint8Array(EXCL_BYTES);
  const dv = new DataView(buf.buffer);
  dv.setInt16(0, x1, true);
  dv.setInt16(2, y1, true);
  dv.setInt16(4, x2, true);
  dv.setInt16(6, y2, true);
  return buf;
}

/** Decode an 8-byte exclusion blob to {x1,y1,x2,y2} (sensor-frame mm). */
export function decodeExclusion(buf) {
  const bytes = buf instanceof Uint8Array ? buf : Uint8Array.from(buf);
  if (bytes.length !== EXCL_BYTES) {
    throw new RangeError(`exclusion blob length ${bytes.length} ≠ ${EXCL_BYTES}`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    x1: dv.getInt16(0, true),
    y1: dv.getInt16(2, true),
    x2: dv.getInt16(4, true),
    y2: dv.getInt16(6, true),
  };
}
