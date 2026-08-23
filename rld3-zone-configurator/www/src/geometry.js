/*
 * geometry.js — room ↔ sensor frame transforms (the §6 "frame trap").
 *
 * The canvas works in ROOM frame. Polygons are written in room frame. But
 * exclusion zones execute inside the LD2450 in SENSOR frame, before yaw
 * correction exists (3T-zone-configurator.md §6). A rectangle drawn on the
 * room canvas is NOT an axis-aligned sensor-frame rectangle unless yaw is a
 * multiple of 90°, so it must be reprojected before it is written.
 *
 * Firmware forward transform (sensor -> room), mount_angle.c / 3T-mounting.md:
 *   1. ELEVATION: slant range -> true horizontal range (RLD3-031)
 *   2. inversion: if inverted, negate X
 *   3. CCW yaw rotation:
 *        x_room = xi*cos(yaw) - yi*sin(yaw)
 *        y_room = xi*sin(yaw) + yi*cos(yaw)
 *
 * Inverse (room -> sensor) reverses all three, elevation LAST.
 *
 * STEP 1 WAS MISSING HERE UNTIL 2026-08-22, and this comment used to describe
 * the transform as inversion + rotation only while claiming to mirror
 * mount_angle_apply(). It did not. The radar measures SLANT range to a target
 * roughly 1 m below a wall mount, and the firmware converts that to the
 * horizontal range a floor plan uses; a rotation-only inverse put every
 * exclusion zone at the wrong radius.
 *
 * Measured on hardware: a zone drawn with its near edge at room 2553 mm was
 * enforced at room 2349 mm -- 204 mm TOWARD the sensor, and the error grows as
 * range falls (382 mm at 1.5 m, and it diverges as range approaches the mount
 * height). The operator saw the suppressed region sitting "north of where
 * drawn". The LD2450 itself was faithful to 1-7 mm on all four edges once the
 * coordinate ENCODING was fixed the same night, which is what isolated this to
 * the frame conversion.
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

/** Mounting config as read from the device (0x0100 / 0x0101 / 0x0107). */
/** @typedef {{ yawDeciDeg: number, inverted: boolean, heightMm: number }} Mount */

function trig(yawDeciDeg) {
  const rad = (yawDeciDeg / 10) * (Math.PI / 180);
  return { sin: Math.sin(rad), cos: Math.cos(rad) };
}

/**
 * Slant -> horizontal. Mirrors elevation_to_horizontal() in mount_angle.c.
 *
 * The sensor reports the straight-line distance to a target that is `heightMm`
 * below it; a floor plan wants the horizontal distance. Scale radially by
 * rho/R where R = sqrt(x^2+y^2) and rho = sqrt(R^2 - h^2).
 *
 * The `r2 <= h2` guard is NOT defensive tidiness -- it is copied from the
 * firmware, which leaves points inside the height radius uncorrected because
 * the horizontal range there is imaginary. It makes the pair a non-exact
 * inverse for r < h; see horizontalToElevation().
 */
function elevationToHorizontal(x, y, h) {
  if (!h) return { x, y };
  const r2 = x * x + y * y;
  const h2 = h * h;
  if (r2 <= h2) return { x, y };
  const R = Math.sqrt(r2);
  if (R === 0) return { x, y };
  const rho = Math.sqrt(r2 - h2);
  return { x: (x * rho) / R, y: (y * rho) / R };
}

/**
 * Horizontal -> slant. Mirrors horizontal_to_elevation() in mount_angle.c.
 *
 * Note the asymmetry, which is faithful to the firmware rather than a bug
 * here: the forward direction refuses to correct inside the height radius but
 * this one always scales, so a round trip is exact only for rho > 0 mapping
 * out to r > h. Zones are authored metres away, so the region never arises in
 * practice -- but a round-trip test that samples near the origin WILL see it,
 * and should assert the firmware's behaviour rather than a clean identity.
 */
function horizontalToElevation(x, y, h) {
  if (!h) return { x, y };
  const rho2 = x * x + y * y;
  if (rho2 === 0) return { x, y };
  const rho = Math.sqrt(rho2);
  const R = Math.sqrt(rho2 + h * h);
  return { x: (x * R) / rho, y: (y * R) / rho };
}

/** Sensor frame → room frame (mirrors mount_angle_apply, in floating point). */
export function sensorToRoom({ x, y }, { yawDeciDeg = 0, inverted = false, heightMm = 0 } = {}) {
  const { sin, cos } = trig(yawDeciDeg);
  const e = elevationToHorizontal(x, y, heightMm);   // FIRST, as in the firmware
  const xi = inverted ? -e.x : e.x;
  const yi = e.y;
  return { x: xi * cos - yi * sin, y: xi * sin + yi * cos };
}

/** Room frame → sensor frame (inverse of the firmware transform). */
export function roomToSensor({ x, y }, { yawDeciDeg = 0, inverted = false, heightMm = 0 } = {}) {
  const { sin, cos } = trig(yawDeciDeg);
  const xt = x * cos + y * sin;
  const yt = -x * sin + y * cos;
  const xs = inverted ? -xt : xt;
  return horizontalToElevation(xs, yt, heightMm);    // LAST, as in the firmware
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
  /*
   * Four corners are enough, and that is not obvious once elevation is in play.
   *
   * With yaw alone the transform is linear, so corners bound the image exactly.
   * The elevation correction is a RADIAL scale by R/rho that grows as range
   * falls, so in principle the image of a straight edge can bow outside the
   * hull of the transformed corners, which would silently under-cover -- an
   * exclusion zone smaller than drawn.
   *
   * It was measured, not assumed: a 32-samples-per-edge version agrees with
   * this one to the millimetre on every rectangle tried, including edges
   * passing within the mount height of the sensor and rectangles straddling
   * it. The corners are scaled least but start furthest out, and they win.
   * The dense version is kept as a TEST (geometry.test.js) rather than as
   * production code, so the assumption is defended without paying for it here.
   */
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
