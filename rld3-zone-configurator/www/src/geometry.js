/*
 * geometry.js — room ↔ sensor frame transforms (the §6 "frame trap").
 *
 * The canvas works in ROOM frame. Polygons are written in room frame. But
 * exclusion zones execute inside the LD2450 in SENSOR frame, before yaw
 * correction exists (3T-zone-configurator.md §6). A rectangle drawn on the
 * room canvas is NOT an axis-aligned sensor-frame rectangle unless yaw is a
 * multiple of 90°, so it must be reprojected before it is written.
 *
 * Firmware forward transform (sensor → room), mount_angle.c / 3T-mounting.md:
 *   1. inversion: if inverted, negate X
 *   2. CCW yaw rotation:
 *        x_room = xi*cos(yaw) - yi*sin(yaw)
 *        y_room = xi*sin(yaw) + yi*cos(yaw)
 *   i.e.  room = R(yaw) · Inv · sensor
 *
 * Inverse (room → sensor) = Inv · R(-yaw) · room  (Inv is its own inverse):
 *        xt =  x_room*cos(yaw) + y_room*sin(yaw)
 *        yt = -x_room*sin(yaw) + y_room*cos(yaw)
 *        x_sensor = inverted ? -xt : xt ;  y_sensor = yt
 *
 * yaw is in tenths of a degree (deci-degrees), matching attr 0x0100
 * (ATTR_YAW_TENTHS); inverted is the bool from attr 0x0101.
 *
 * Precision note: the device computes this in Q15 fixed-point with linear
 * interpolation between integer degrees; this module uses double-precision
 * Math.{sin,cos}. The two can differ by well under 1 mm at room scale. For
 * drawing and exclusion-zone bounding boxes that is immaterial. Do NOT use
 * this module to predict the device's exact rounding of a single coordinate.
 */

/** Mounting config as read from the device (0x0100 / 0x0101). */
/** @typedef {{ yawDeciDeg: number, inverted: boolean }} Mount */

function trig(yawDeciDeg) {
  const rad = (yawDeciDeg / 10) * (Math.PI / 180);
  return { sin: Math.sin(rad), cos: Math.cos(rad) };
}

/** Sensor frame → room frame (mirrors mount_angle_apply, in floating point). */
export function sensorToRoom({ x, y }, { yawDeciDeg = 0, inverted = false } = {}) {
  const { sin, cos } = trig(yawDeciDeg);
  const xi = inverted ? -x : x;
  const yi = y;
  return { x: xi * cos - yi * sin, y: xi * sin + yi * cos };
}

/** Room frame → sensor frame (inverse of the firmware transform). */
export function roomToSensor({ x, y }, { yawDeciDeg = 0, inverted = false } = {}) {
  const { sin, cos } = trig(yawDeciDeg);
  const xt = x * cos + y * sin;
  const yt = -x * sin + y * cos;
  return { x: inverted ? -xt : xt, y: yt };
}

/** Round to integer mm, normalising negative zero to 0. */
function r0(v) {
  const n = Math.round(v);
  return n === 0 ? 0 : n;
}

/** Round a point to integer mm (wire coordinates are int16 mm). */
export function roundPoint({ x, y }) {
  return { x: r0(x), y: r0(y) };
}

/**
 * Map a room-frame rectangle to the axis-aligned sensor-frame bounding box
 * that must actually be written (§6 option 2, "bounding-box mapping").
 *
 * The four room-frame corners are transformed to sensor frame and the
 * axis-aligned extent is taken. When yaw is not a multiple of 90° this box is
 * larger than the drawn rectangle — the configurator MUST display this
 * effective region back to the installer so they see what the device will
 * exclude. Returns integer mm, ready for exclusion_codec.encodeExclusion().
 *
 * @param {{x1:number,y1:number,x2:number,y2:number}} roomRect
 * @param {Mount} mount
 * @returns {{x1:number,y1:number,x2:number,y2:number}} sensor-frame AABB
 */
export function roomRectToSensorBBox(roomRect, mount = {}) {
  const corners = [
    { x: roomRect.x1, y: roomRect.y1 },
    { x: roomRect.x2, y: roomRect.y1 },
    { x: roomRect.x2, y: roomRect.y2 },
    { x: roomRect.x1, y: roomRect.y2 },
  ].map((c) => roomToSensor(c, mount));

  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  return {
    x1: r0(Math.min(...xs)),
    y1: r0(Math.min(...ys)),
    x2: r0(Math.max(...xs)),
    y2: r0(Math.max(...ys)),
  };
}

/**
 * Map a sensor-frame exclusion rectangle back to its four room-frame corners,
 * for drawing an existing/effective exclusion zone on the room canvas. Returns
 * a quad (not a rectangle) because an axis-aligned sensor rect is a rotated
 * quad in room frame.
 *
 * @returns {{x:number,y:number}[]} four room-frame corners, CW from (x1,y1)
 */
export function sensorRectToRoomQuad(sensorRect, mount = {}) {
  return [
    { x: sensorRect.x1, y: sensorRect.y1 },
    { x: sensorRect.x2, y: sensorRect.y1 },
    { x: sensorRect.x2, y: sensorRect.y2 },
    { x: sensorRect.x1, y: sensorRect.y2 },
  ].map((c) => sensorToRoom(c, mount));
}

/**
 * Even-odd point-in-polygon test for float {x,y} vertices.
 *
 * Shared so there is ONE implementation: `ui/index.html` used to carry its own
 * copy for exclusion-body hit-testing, and a second copy added for live-target
 * plausibility would have been free to drift from it.
 *
 * @param {{x:number,y:number}[]} pts polygon vertices, any winding
 * @param {{x:number,y:number}} p point to test
 * @returns {boolean} true if p is inside pts
 */
export function pointInPolygon(pts, p) {
  if (!Array.isArray(pts) || pts.length < 3) return false;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if (((a.y > p.y) !== (b.y > p.y)) &&
        (p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)) inside = !inside;
  }
  return inside;
}

/**
 * Is a live target somewhere a person cannot be — outside the room itself?
 *
 * The master zone is the strongest plausibility test the system has, and on
 * 2026-08-06 it was not applied to the live view: a track at room (-3308, 441)
 * was drawn as an ordinary target while being **outside the building**, on the
 * second floor (RLD3-029). The operator spotted it by eye; nothing in the
 * interface said anything.
 *
 * Returns false when there is no master polygon — an unprovisioned room must not
 * make every target look implausible. "Unknown" is not "outside".
 *
 * NOTE this is for FLAGGING, never for hiding. A target outside the room is the
 * most diagnostic thing on the canvas; suppressing it would have removed the
 * very evidence that found the defect. See the call site in index.html.
 *
 * @param {{x:number,y:number}} pointAbs target position, ABSOLUTE room frame
 *        (i.e. sensor origin already added)
 * @param {{x:number,y:number}[]|null|undefined} masterVertices room polygon
 * @returns {boolean} true only when a master polygon exists AND p is outside it
 */
function segmentsCross(p1, p2, p3, p4) {
  const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
         ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * Does polygon `inner` have any area outside polygon `outer`?
 *
 * True when a vertex of `inner` lies outside `outer`, or when their edges
 * cross. For simple polygons those two together are exhaustive: if every
 * vertex is inside and no edge crosses the boundary, the whole polygon is
 * contained. Touching edges (collinear/shared) count as contained, which is
 * the conservative direction here — it warns rather than reassures only when
 * there is genuinely area on the far side.
 *
 * Returns false when either polygon is missing: "unknown" is not "outside",
 * the same convention isTargetOutsideRoom() uses.
 */
export function hasAreaOutside(innerVerts, outerVerts) {
  if (!Array.isArray(innerVerts) || innerVerts.length < 3) return false;
  if (!Array.isArray(outerVerts) || outerVerts.length < 3) return false;

  for (const v of innerVerts) {
    if (!pointInPolygon(outerVerts, v)) return true;
  }
  for (let i = 0; i < innerVerts.length; i++) {
    const a = innerVerts[i], b = innerVerts[(i + 1) % innerVerts.length];
    for (let j = 0; j < outerVerts.length; j++) {
      const c = outerVerts[j], e = outerVerts[(j + 1) % outerVerts.length];
      if (segmentsCross(a, b, c, e)) return true;
    }
  }
  return false;
}

export function isTargetOutsideRoom(pointAbs, masterVertices) {
  if (!Array.isArray(masterVertices) || masterVertices.length < 3) return false;
  return !pointInPolygon(masterVertices, pointAbs);
}
