/*
 * viewport.js — world(mm) ↔ screen(px) mapping for the canvas. Pure, no DOM.
 *
 * World frame is the ROOM frame in millimetres: +x right (lateral), +y forward
 * (away from the sensor). Screen is pixels with +y DOWN, so the mapping flips y
 * — drawing forward-distance upward, which is how an installer reads the room.
 *
 *   screen = (tx + x*scale, ty - y*scale)
 *   world  = ((sx - tx)/scale, (ty - sy)/scale)
 *
 * A viewport is the plain object { scale, tx, ty } (px-per-mm and the screen
 * pixel of world origin). All functions are pure and return new viewports.
 */

export function makeViewport({ scale = 0.1, tx = 0, ty = 0 } = {}) {
  return { scale, tx, ty };
}

export function worldToScreen(vp, { x, y }) {
  return { sx: vp.tx + x * vp.scale, sy: vp.ty - y * vp.scale };
}

export function screenToWorld(vp, { sx, sy }) {
  return { x: (sx - vp.tx) / vp.scale, y: (vp.ty - sy) / vp.scale };
}

/** Zoom by `factor` about a screen point, keeping the world point under it fixed. */
export function zoomAt(vp, factor, { sx, sy }) {
  const w = screenToWorld(vp, { sx, sy });
  const scale = vp.scale * factor;
  return { scale, tx: sx - w.x * scale, ty: sy + w.y * scale };
}

/** Pan by a screen-pixel delta. */
export function pan(vp, dxPx, dyPx) {
  return { scale: vp.scale, tx: vp.tx + dxPx, ty: vp.ty + dyPx };
}

/**
 * Fit a world bounding box into a canvas with uniform scale and centring.
 * @param {{xmin,xmax,ymin,ymax}} bounds
 * @param {{w,h}} canvas  pixel size
 * @param {number} pad    pixel padding on every side
 */
export function fitBounds(bounds, canvas, pad = 20) {
  const wWorld = Math.max(1, bounds.xmax - bounds.xmin);
  const hWorld = Math.max(1, bounds.ymax - bounds.ymin);
  const scale = Math.min((canvas.w - 2 * pad) / wWorld, (canvas.h - 2 * pad) / hWorld);

  // Centre of the world bbox should land at the centre of the canvas.
  const cx = (bounds.xmin + bounds.xmax) / 2;
  const cy = (bounds.ymin + bounds.ymax) / 2;
  return {
    scale,
    tx: canvas.w / 2 - cx * scale,
    ty: canvas.h / 2 + cy * scale,
  };
}

/** Convert a pixel distance to world mm at the current scale (for hit radii). */
export function pxToWorld(vp, px) {
  return px / vp.scale;
}
