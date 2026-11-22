/* Commissioning display and ground truth; no device IO. All points are room mm.
 * Jog sign is measured, not inferred: ui/index.html panUpdateAlignError comment,
 * rld3-bench/2026-07-27_005635_dc3_run4_keyboard (+114 -> bearing -11.7°).
 */
export const DEG_PER_STEP = 360 / 4096;
export const JOG_CAP_STEPS = 512;
export const wrapDegrees = (d) => ((d + 180) % 360 + 360) % 360 - 180;
const pointOK = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y);
export function bearingError(point, target, sensor) {
  if (![point, target, sensor].every(pointOK)) return null;
  if ((point.x === sensor.x && point.y === sensor.y) || (target.x === sensor.x && target.y === sensor.y)) return null;
  return wrapDegrees((Math.atan2(point.y - sensor.y, point.x - sensor.x)
    - Math.atan2(target.y - sensor.y, target.x - sensor.x)) * 180 / Math.PI);
}
export function alignmentJog(errorDeg) {
  const degrees = -errorDeg; // Measured sign; see module header.
  return { degrees, steps: Math.round(degrees / DEG_PER_STEP),
    withinCap: Number.isFinite(degrees) && Math.abs(degrees) <= JOG_CAP_STEPS * DEG_PER_STEP,
    direction: degrees >= 0 ? 'clockwise' : 'counter-clockwise' };
}

// Display choices, not measured settling/accuracy requirements. Twelve distinct
// samples prevent a single quiet return claiming stability. At the contract's
// max 4 Hz this covers ~3 s, but spread, not elapsed time, decides stability.
export const WINDOW_SAMPLES = 12;
// Six missing 4 Hz updates invalidate the browser's last observation.
export const STALE_MS = 6 * 1000 / 4;
export function createYawWindow() {
  let samples = [], context = '', lastFrame = '', lastTime = -Infinity, blocked = 'need one usable return';
  function reset(reason = 'need one usable return') { samples = []; context = ''; lastFrame = ''; lastTime = -Infinity; blocked = reason; }
  function summary(now, toleranceDeg = 2) {
    if (samples.length && now - lastTime > STALE_MS) reset('live frame stale');
    if (!samples.length) return { valid: false, reason: blocked };
    const base = samples[0];
    const unwrapped = samples.map((d) => base + wrapDegrees(d - base));
    const spreadDeg = Math.max(...unwrapped) - Math.min(...unwrapped);
    const errorDeg = wrapDegrees(unwrapped.reduce((a, b) => a + b, 0) / samples.length);
    return { valid: true, errorDeg, spreadDeg, count: samples.length,
      settled: samples.length === WINDOW_SAMPLES && toleranceDeg > 0 && spreadDeg <= toleranceDeg };
  }
  function update(frame, point, sensor, now, frozenThreshold = 50) {
    if (now - lastTime > STALE_MS) reset();
    const slots = (frame?.slots || []).filter((s) => s.valid);
    const sl = slots[0];
    const target = sl && { x: sl.x_mm, y: sl.y_mm };
    const error = sl && bearingError(point, target, sensor);
    const reason = frame?.stream_state !== 'ok' ? `stream ${frame?.stream_state ?? 'unavailable'}`
      : slots.length !== 1 ? `need one usable return (${slots.length} valid returns)`
      : error == null ? 'place a mark away from the sensor; return position must be available'
      : sl.ghost ? 'ghost return'
      : sl.kinematic_suspect ? 'suspect return'
      : sl.spatial_reason !== 'normal' ? `spatial rejection: ${sl.spatial_reason}`
      : sl.observation_state === 'unchanged' && sl.unchanged_frames >= frozenThreshold ? 'frozen return'
      : sl.track_present && !sl.supported_this_frame ? 'track not supported this frame (coasting)' : '';
    if (reason) { reset(reason); return { valid: false, reason }; }
    const key = JSON.stringify([frame.boot_session, frame.transform_generation, point, sensor,
      sl.track_present ? sl.track_token : null, frame.slots.indexOf(sl)]);
    if (key !== context) { reset(); context = key; }
    const identity = `${frame.boot_session}/${frame.frame_sequence}`;
    if (identity !== lastFrame) { samples.push(error); samples = samples.slice(-WINDOW_SAMPLES); lastFrame = identity; lastTime = now; }
    return summary(now);
  }
  return { update, summary, reset };
}
