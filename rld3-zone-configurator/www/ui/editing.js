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
