/** Restart wall identities in screen pixels, independent of zoom. */
const LABEL_LIFT_PX = 27;
const ORIGIN_ALONG_PX = 34;
const ORIGIN_LIFT_PX = -16; // Outside the wall, clear of midpoint labels.
const ARROW_HALF_PX = 13;
const ARROW_HEAD_PX = 6;

/** Draw every index at its midpoint, a 0 mm dot at its first corner and a
 * directional arrow along the wall. Screen-space sizes keep default zoom
 * legible. w2s is the page's room-to-screen transform. No model is changed.
 */
export function drawWallGuides(ctx, master, w2s) {
  if (!master || master.length < 3) return;
  const points = master.map(w2s);
  const area = points.reduce((sum, a, i) => {
    const b = points[(i + 1) % points.length];
    return sum + a.sx * b.sy - b.sx * a.sy;
  }, 0);
  ctx.save();
  ctx.font = '600 13px system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.strokeStyle = '#67e8f9'; ctx.lineWidth = 2; ctx.setLineDash([]);
  function chip(text, x, y) {
    const width = ctx.measureText(text).width + 10;
    ctx.fillStyle = '#11161d'; ctx.fillRect(x - width / 2, y - 10, width, 20);
    ctx.fillStyle = '#a5f3fc'; ctx.fillText(text, x, y);
  }
  points.forEach((a, wall) => {
    const b = points[(wall + 1) % points.length];
    const length = Math.hypot(b.sx - a.sx, b.sy - a.sy);
    if (!length) return;
    const ux = (b.sx - a.sx) / length, uy = (b.sy - a.sy) / length;
    // Lift labels into the room, including clockwise vertex lists.
    const sign = area >= 0 ? 1 : -1, nx = -uy * sign, ny = ux * sign;
    const mx = (a.sx + b.sx) / 2, my = (a.sy + b.sy) / 2;
    chip(`Wall ${String.fromCharCode(65+wall)}`, mx + nx * LABEL_LIFT_PX, my + ny * LABEL_LIFT_PX);
    const along = Math.min(ORIGIN_ALONG_PX, length / 4);
    chip(`${String.fromCharCode(65+wall)}: 0 mm`, a.sx + ux * along + nx * ORIGIN_LIFT_PX,
      a.sy + uy * along + ny * ORIGIN_LIFT_PX);
    ctx.fillStyle = '#67e8f9';
    ctx.beginPath(); ctx.arc(a.sx, a.sy, 4, 0, Math.PI * 2); ctx.fill();
    const half = Math.min(ARROW_HALF_PX, length / 4);
    const tx = mx + ux * half, ty = my + uy * half;
    ctx.beginPath(); ctx.moveTo(mx - ux * half, my - uy * half); ctx.lineTo(tx, ty);
    ctx.moveTo(tx - ux * ARROW_HEAD_PX - uy * ARROW_HEAD_PX,
      ty - uy * ARROW_HEAD_PX + ux * ARROW_HEAD_PX);
    ctx.lineTo(tx, ty);
    ctx.lineTo(tx - ux * ARROW_HEAD_PX + uy * ARROW_HEAD_PX,
      ty - uy * ARROW_HEAD_PX - ux * ARROW_HEAD_PX); ctx.stroke();
  });
  ctx.restore();
}
