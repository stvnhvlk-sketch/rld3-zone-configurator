/*
 * editing.js — pure geometry helpers for canvas polygon editing. No DOM.
 *
 * All distances are in WORLD units (mm). The shell converts a pixel hit radius
 * to mm via viewport.pxToWorld() before calling in, so behaviour is consistent
 * at any zoom.
 */

function dist2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * Index of the vertex within `maxDist` of `p`, nearest first; -1 if none.
 */
export function nearestVertex(vertices, p, maxDist) {
  let best = -1;
  let bestD2 = maxDist * maxDist;
  for (let i = 0; i < vertices.length; i++) {
    const d2 = dist2(vertices[i], p);
    if (d2 <= bestD2) {
      bestD2 = d2;
      best = i;
    }
  }
  return best;
}

/** Perpendicular distance from point p to segment ab (clamped to the segment). */
export function distToSegment(a, b, p) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return Math.sqrt(dist2(a, p));
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  const proj = { x: a.x + t * abx, y: a.y + t * aby };
  return Math.sqrt(dist2(proj, p));
}

/**
 * Edge index (i → i+1, wrapping) whose segment is within `maxDist` of p, for
 * inserting a vertex on an edge; -1 if none. Closed polygon assumed.
 */
export function nearestEdge(vertices, p, maxDist) {
  let best = -1;
  let bestD = maxDist;
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const d = distToSegment(vertices[i], vertices[(i + 1) % n], p);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * While drawing, should clicking at `p` close the polygon? True when there are
 * at least 3 vertices and `p` is within `closeDist` of the first vertex.
 */
export function shouldClosePolygon(vertices, p, closeDist) {
  if (vertices.length < 3) return false;
  return Math.sqrt(dist2(vertices[0], p)) <= closeDist;
}

/**
 * Midpoint and length of every edge of a closed polygon, in WORLD units (mm).
 *
 * Edge i runs vertices[i] → vertices[(i+1) % n], the same indexing nearestEdge()
 * returns, so a caller can line the two up without translating.
 *
 * `dx`/`dy` are the edge vector, for orienting a label along the wall. A
 * two-point "polygon" yields ONE edge, not two identical ones.
 */
export function edgeMetrics(vertices) {
  if (!Array.isArray(vertices) || vertices.length < 2) return [];
  const n = vertices.length;
  const edges = n === 2 ? 1 : n;
  const out = [];
  for (let i = 0; i < edges; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % n];
    out.push({
      index: i,
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      length: Math.sqrt(dist2(a, b)),
      dx: b.x - a.x,
      dy: b.y - a.y,
    });
  }
  return out;
}

/*
 * Axis lock — hold Shift while dragging to square a wall up.
 *
 * A generic axis constraint locks movement to the axis you started the drag on.
 * That is the wrong anchor for a polygon: what the operator wants is not "move
 * horizontally", it is "make THIS WALL horizontal". So the candidates are drawn
 * from the vertex's NEIGHBOURS -- sharing a neighbour's y makes the edge to that
 * neighbour horizontal, sharing its x makes it vertical -- and the nearest
 * candidate to the free pointer wins. Both adjacent walls are offered at once,
 * so one gesture can square either of them without choosing a mode first.
 *
 * Measured motivation: a hand-drawn room came out with a 3120 mm wall rising
 * 17 mm over its length (0.31 deg off) and a corner at 90.265 deg. Close every
 * time, exact never.
 *
 * `anchors` is a list because Draw mode has only the previous point to work
 * from, while Edit mode has both neighbours. Empty list = nothing to square
 * against, so the point is returned untouched rather than guessed at.
 */
export function axisLock(p, anchors) {
  if (!Array.isArray(anchors) || anchors.length === 0) return { x: p.x, y: p.y };
  let best = { x: p.x, y: p.y };
  let bestD2 = Infinity;
  for (const q of anchors) {
    if (!q) continue;
    for (const cand of [{ x: p.x, y: q.y }, { x: q.x, y: p.y }]) {
      const d2 = dist2(cand, p);
      if (d2 < bestD2) { bestD2 = d2; best = cand; }
    }
  }
  return best;
}

/*
 * Clip segment a->b to a rectangle (Liang-Barsky), in SCREEN space.
 *
 * Wall labels sit at the segment's midpoint, which works until you zoom in:
 * the midpoint leaves the canvas while the wall itself still crosses it, and
 * the number vanishes exactly when the detail you zoomed in for is on screen.
 * Clipping first and labelling the midpoint of the VISIBLE run keeps it in
 * view -- the standard map-labelling fix.
 *
 * Returns null when the segment misses the rectangle entirely (nothing to
 * label), so the caller skips it rather than drawing off-canvas.
 */
export function clipSegmentToRect(a, b, rect) {
  const dx = b.sx - a.sx;
  const dy = b.sy - a.sy;
  let t0 = 0;
  let t1 = 1;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;            // parallel: inside iff not outside
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  if (!clip(-dx, a.sx - rect.x0) || !clip(dx, rect.x1 - a.sx)
      || !clip(-dy, a.sy - rect.y0) || !clip(dy, rect.y1 - a.sy)) return null;
  return {
    a: { sx: a.sx + t0 * dx, sy: a.sy + t0 * dy },
    b: { sx: a.sx + t1 * dx, sy: a.sy + t1 * dy },
  };
}

/** Insert a vertex after edge index `edge` (between edge and edge+1). */
export function insertVertexAfter(vertices, edge, p) {
  const out = vertices.slice();
  out.splice(edge + 1, 0, { x: Math.round(p.x), y: Math.round(p.y) });
  return out;
}

/** Axis-aligned world bounding box of a set of points (for fit-to-view). */
export function boundsOf(points, fallback) {
  if (!points || points.length === 0) return fallback;
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const { x, y } of points) {
    if (x < xmin) xmin = x;
    if (x > xmax) xmax = x;
    if (y < ymin) ymin = y;
    if (y > ymax) ymax = y;
  }
  return { xmin, xmax, ymin, ymax };
}
