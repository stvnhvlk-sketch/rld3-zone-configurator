/*
 * sensor_spec.js — LD2450 coverage constants (single source of truth for the UI).
 *
 * The firmware-derived values are pinned to the C headers by
 * test/contract.test.js so the coverage overlay can't drift from the firmware.
 * Both cone angles ARE firmware constants and map to DIFFERENT ones:
 * SENSOR_CONE_SWEET_DEG → CONE_GATE_SWEET_DEG (installer guidance) and
 * SENSOR_FOV_FULL_DEG → CONE_GATE_HALF_ANGLE_DEG (outer operating cone).
 */

export const SENSOR_RANGE_R = 6000;       // max radial range (mm) — datasheet 6 m, == LD2450_parser.c y bound
export const SENSOR_RANGE_X = 3000;       // lateral clip (mm) — LD2450_parser.c x bound
export const SENSOR_CONE_SWEET_DEG = 45;  // cone_gate.h CONE_GATE_SWEET_DEG (optimal/sweet-spot cone)
export const SENSOR_FOV_FULL_DEG = 60;    // cone_gate.h CONE_GATE_HALF_ANGLE_DEG (outer cone; ~±60° FOV)

// Physical tracking range vs angle, digitized from the LD2450 datasheet Fig 7
// (wall mount, 1.5 m height). Angle from boresight (deg) → max range (mm).
// This is the real teardrop reach (deepest at boresight); it is MOUNTING-DEPENDENT
// (height/tilt change it) — see the sensor-geometry research TODO. Eyeballed off
// the chart; adjust if a numeric table surfaces.
export const SENSOR_RANGE_CURVE = [
  { deg: 0, mm: 7500 }, { deg: 15, mm: 7200 }, { deg: 30, mm: 6200 },
  { deg: 45, mm: 5300 }, { deg: 60, mm: 4600 }, { deg: 75, mm: 2800 },
  { deg: 90, mm: 1300 },
];
