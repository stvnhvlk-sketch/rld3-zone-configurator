/*
 * sensor_spec.js — LD2450 coverage constants (single source of truth for the UI).
 *
 * The firmware-derived values are pinned to the C headers by
 * test/contract.test.js so the coverage overlay can't drift from the firmware.
 * Both cone angles ARE firmware constants and map to DIFFERENT ones:
 * SENSOR_CONE_SWEET_DEG → CONE_GATE_SWEET_DEG (installer guidance) and
 * SENSOR_FOV_FULL_DEG → CONE_GATE_HALF_ANGLE_DEG (outer operating cone).
 */

// COVERAGE constants — what the sensor can see. These shape the overlay the
// installer reads, so they must stay honest about reach and carry NO margin.
export const SENSOR_RANGE_R = 6000;       // max radial range (mm) — datasheet 6 m
export const SENSOR_RANGE_X = 3000;       // lateral clip (mm) for the drawn sector

// PARSER SANITY bounds — what LD2450_parser.c will accept. Deliberately WIDER
// than the coverage constants above, and deliberately NOT the same numbers.
//
// They answer a different question. Coverage says "where can it see"; these say
// "what value is so implausible it must be corruption". Margin is right for the
// second and wrong for the first — an overlay drawn with margin lies to the
// installer. They were one pair of constants until 2026-08-04, which forced a
// choice between an honest overlay and a safe bound; splitting them ends that.
//
// Derived from SENSOR_RANGE_CURVE below: projecting the teardrop gives a worst
// case of |x| ~3984 mm (at 60°) and y ~7500 mm (on boresight). Margin is added
// because that curve is eyeballed off the datasheet chart AND mounting-dependent
// — a different height or tilt can legitimately exceed it, and a false reject
// deletes a real person. Revise from real-use data.
//
// PINNED to the C by test/contract.test.js, which scrapes the two literals in
// LD2450_parser.c's boundary check. Change one, change both.
export const PARSER_MAX_ABS_X = 5000;     // mm — |x| bound in LD2450_parser.c
export const PARSER_MAX_Y     = 9000;     // mm — y bound in LD2450_parser.c
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
