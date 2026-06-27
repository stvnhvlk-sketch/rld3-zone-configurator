/*
 * polygon_codec.js — RLD3-Target zone polygon wire codec (adapter-agnostic core)
 *
 * Mirrors the firmware `polygon_t` byte layout (main/Polygon/polygon.h) so the
 * configurator produces blobs the device accepts and decodes blobs it returns.
 *
 * Wire layout (ZONE_MAX_VERTICES = 12 → 56 bytes; see 3T-zone-configurator.md §4):
 *
 *   off 0   u8     count        active vertices, 3..MAX
 *   off 1   3B     padding      0x000000 (struct alignment; covered by CRC)
 *   off 4   4*MAX  pts[MAX]     per vertex: x_mm int16 LE, y_mm int16 LE
 *                              unused vertex slots zeroed
 *   off N-4 4B     crc32 LE     esp_crc32_le(0, bytes[0 .. N-5])
 *
 * The CRC equals esp_crc32_le(0, ...) which is the standard reflected CRC-32
 * (poly 0xEDB88320, init/xorout 0xFFFFFFFF) — see polygon_nvs.c. The firmware
 * does NOT verify it on the Zigbee path (recomputed on NVS persist), but we
 * write a correct CRC anyway: cheap and forward-compatible if the device later
 * hardens the write path (§9).
 *
 * MAX (vertex cap) is NOT a hardcoded truth. The device reports it via RO attr
 * 0x0005 (ATTR_POLY_MAX_VERTICES). Callers SHOULD read that and pass it as
 * `maxVertices`; DEFAULT_MAX_VERTICES is only the current-build fallback.
 */

export const POLY_HEADER_BYTES = 4; // count(1) + padding(3)
export const POLY_CRC_BYTES = 4;
export const VERTEX_BYTES = 4; // x int16 + y int16
export const DEFAULT_MAX_VERTICES = 12;
export const COORD_MIN = -32768; // int16
export const COORD_MAX = 32767;

/** Raw blob length for a given vertex cap (56 at MAX=12). */
export function polygonByteLength(maxVertices = DEFAULT_MAX_VERTICES) {
  return POLY_HEADER_BYTES + VERTEX_BYTES * maxVertices + POLY_CRC_BYTES;
}

/* ----------------------------------------------------------------------------
 * CRC-32 (reflected, poly 0xEDB88320) — matches esp_crc32_le(0, buf, len).
 * ------------------------------------------------------------------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* ----------------------------------------------------------------------------
 * Vertex normalisation
 * ------------------------------------------------------------------------- */

/** Accept [{x,y}, ...] or [[x,y], ...]; return a uniform [{x,y}] of integers. */
export function normalizeVertices(vertices) {
  if (!Array.isArray(vertices)) {
    throw new TypeError('vertices must be an array');
  }
  return vertices.map((v, i) => {
    const x = Array.isArray(v) ? v[0] : v.x;
    const y = Array.isArray(v) ? v[1] : v.y;
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      throw new TypeError(`vertex ${i} coordinates must be integer mm`);
    }
    return { x, y };
  });
}

/* ----------------------------------------------------------------------------
 * Validation (client-side rules the device does NOT enforce — §4)
 * ------------------------------------------------------------------------- */

/**
 * Validate a vertex list against the wire contract and geometry rules.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validatePolygon(vertices, { maxVertices = DEFAULT_MAX_VERTICES } = {}) {
  const errors = [];
  let v;
  try {
    v = normalizeVertices(vertices);
  } catch (e) {
    return { ok: false, errors: [e.message] };
  }

  if (v.length < 3) errors.push(`vertex count ${v.length} < 3`);
  if (v.length > maxVertices) errors.push(`vertex count ${v.length} > max ${maxVertices}`);

  for (let i = 0; i < v.length; i++) {
    const { x, y } = v[i];
    if (x < COORD_MIN || x > COORD_MAX || y < COORD_MIN || y > COORD_MAX) {
      errors.push(`vertex ${i} (${x},${y}) outside int16 mm range`);
    }
  }

  // Zero-length edges (consecutive identical vertices, including wrap) — the
  // device rejects these in polygon_validate().
  for (let i = 0; i < v.length; i++) {
    const a = v[i];
    const b = v[(i + 1) % v.length];
    if (a.x === b.x && a.y === b.y) errors.push(`zero-length edge at vertex ${i}`);
  }

  // Self-intersection — accepted by the device (counterintuitive results) so
  // the configurator MUST reject it client-side (§4).
  if (v.length >= 4 && hasSelfIntersection(v)) {
    errors.push('polygon is self-intersecting');
  }

  return { ok: errors.length === 0, errors };
}

/* ----------------------------------------------------------------------------
 * Encode / decode
 * ------------------------------------------------------------------------- */

/**
 * Encode a vertex list to the raw N-byte polygon blob (no length prefix).
 * Throws if the polygon fails validation.
 * @returns {Uint8Array}
 */
export function encodePolygon(vertices, { maxVertices = DEFAULT_MAX_VERTICES } = {}) {
  const { ok, errors } = validatePolygon(vertices, { maxVertices });
  if (!ok) throw new Error(`invalid polygon: ${errors.join('; ')}`);

  const v = normalizeVertices(vertices);
  const size = polygonByteLength(maxVertices);
  const buf = new Uint8Array(size); // padding + unused slots stay zero
  const dv = new DataView(buf.buffer);

  dv.setUint8(0, v.length);
  for (let i = 0; i < v.length; i++) {
    dv.setInt16(POLY_HEADER_BYTES + i * VERTEX_BYTES + 0, v[i].x, true);
    dv.setInt16(POLY_HEADER_BYTES + i * VERTEX_BYTES + 2, v[i].y, true);
  }

  const crc = crc32(buf.subarray(0, size - POLY_CRC_BYTES));
  dv.setUint32(size - POLY_CRC_BYTES, crc, true);
  return buf;
}

/**
 * Decode a raw polygon blob.
 * @returns {{ count, vertices, crc, crcValid }}
 * @throws on length/structure errors that indicate a transport/build mismatch.
 */
export function decodePolygon(buf, { maxVertices = DEFAULT_MAX_VERTICES } = {}) {
  const bytes = buf instanceof Uint8Array ? buf : Uint8Array.from(buf);
  const expected = polygonByteLength(maxVertices);
  if (bytes.length !== expected) {
    throw new RangeError(`blob length ${bytes.length} ≠ expected ${expected} (maxVertices ${maxVertices})`);
  }

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint8(0);
  if (count > maxVertices) {
    throw new RangeError(`decoded count ${count} > max ${maxVertices}`);
  }

  const vertices = [];
  for (let i = 0; i < count; i++) {
    vertices.push({
      x: dv.getInt16(POLY_HEADER_BYTES + i * VERTEX_BYTES + 0, true),
      y: dv.getInt16(POLY_HEADER_BYTES + i * VERTEX_BYTES + 2, true),
    });
  }

  const storedCrc = dv.getUint32(expected - POLY_CRC_BYTES, true);
  const calcCrc = crc32(bytes.subarray(0, expected - POLY_CRC_BYTES));
  return { count, vertices, crc: storedCrc, crcValid: storedCrc === calcCrc };
}

/* ----------------------------------------------------------------------------
 * ZCL octet string framing
 * ------------------------------------------------------------------------- */

/** Prefix the raw blob with its 1-byte ZCL length, as written on the air. */
export function toZclOctet(blob) {
  if (blob.length > 0xff) throw new RangeError('blob too long for ZCL octet string');
  const out = new Uint8Array(blob.length + 1);
  out[0] = blob.length;
  out.set(blob, 1);
  return out;
}

/** Strip and verify the ZCL length prefix, returning the raw blob. */
export function fromZclOctet(octet) {
  const bytes = octet instanceof Uint8Array ? octet : Uint8Array.from(octet);
  if (bytes.length < 1) throw new RangeError('empty octet string');
  const len = bytes[0];
  if (len !== bytes.length - 1) {
    throw new RangeError(`length prefix ${len} ≠ payload ${bytes.length - 1}`);
  }
  return bytes.subarray(1);
}

/* ----------------------------------------------------------------------------
 * Hex helpers — the Z2M converter accepts polygons as a hex string and lets
 * zigbee-herdsman add the ZCL octet length prefix, so the hex is the RAW blob
 * (no prefix). Browser-safe (no Buffer dependency).
 * ------------------------------------------------------------------------- */

export function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(hex) {
  const clean = hex.replace(/\s+/g, '');
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new RangeError('invalid hex string');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/* ----------------------------------------------------------------------------
 * Self-intersection test (integer-exact, O(n²), n ≤ 12)
 * ------------------------------------------------------------------------- */

function orient(a, b, c) {
  // Sign of the cross product (b-a) × (c-a). BigInt avoids int overflow for
  // worst-case int16 spans.
  const val =
    BigInt(b.x - a.x) * BigInt(c.y - a.y) - BigInt(b.y - a.y) * BigInt(c.x - a.x);
  return val > 0n ? 1 : val < 0n ? -1 : 0;
}

function onSegment(a, b, p) {
  return (
    Math.min(a.x, b.x) <= p.x &&
    p.x <= Math.max(a.x, b.x) &&
    Math.min(a.y, b.y) <= p.y &&
    p.y <= Math.max(a.y, b.y)
  );
}

function segmentsIntersect(p1, p2, p3, p4) {
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  if (d1 === 0 && onSegment(p3, p4, p1)) return true;
  if (d2 === 0 && onSegment(p3, p4, p2)) return true;
  if (d3 === 0 && onSegment(p1, p2, p3)) return true;
  if (d4 === 0 && onSegment(p1, p2, p4)) return true;
  return false;
}

/** True if any pair of non-adjacent edges intersects or touches. */
export function hasSelfIntersection(vertices) {
  const v = normalizeVertices(vertices);
  const n = v.length;
  for (let i = 0; i < n; i++) {
    const a1 = v[i];
    const a2 = v[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // Skip edges that share a vertex (adjacent, including the wrap pair).
      if (j === i) continue;
      if ((j + 1) % n === i || (i + 1) % n === j) continue;
      const b1 = v[j];
      const b2 = v[(j + 1) % n];
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}
