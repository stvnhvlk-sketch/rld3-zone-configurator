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
