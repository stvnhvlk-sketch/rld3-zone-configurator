// Room-frame display only. Raw coordinates remain the measurement input.
export function displayPoint(slot) {
  if (!slot?.valid) return null;
  if (Number.isFinite(slot.display_x_mm) && Number.isFinite(slot.display_y_mm)) {
    return {x: slot.display_x_mm, y: slot.display_y_mm};
  }
  return Number.isFinite(slot.x_mm) && Number.isFinite(slot.y_mm)
    ? {x: slot.x_mm, y: slot.y_mm} : null;
}

// Independent of observation glyphs: frozen/rejected must not hide track status.
export function trackStatus(slot) {
  if (!slot?.track_present) return null;
  return slot.ghost ? 'ghost' : slot.kinematic_suspect ? 'suspect' : 'normal';
}
