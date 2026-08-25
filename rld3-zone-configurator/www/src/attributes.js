/*
 * attributes.js — RLD3 custom cluster 0xFDCD attribute map.
 *
 * MIRROR OF FIRMWARE: main/application/zigbee.h. If an ID changes there, change it
 * here. The configurator core is transport-agnostic but it is NOT attribute-
 * agnostic — these IDs are the contract.
 */

export const CLUSTER_CFG = 0xfdcd;
export const EP_CFG = 1;

/* State (read-only) */
export const ATTR_POLY_MAX_VERTICES = 0x0005; // u8 — read this; do not hardcode the cap

/* Mounting configuration (read/write) */
export const ATTR_YAW_TENTHS = 0x0100; // int16, 0.1° units
export const ATTR_INVERTED = 0x0101; // bool
// Sensor's position in room-space coordinates, mm (2026-08-08) — lets the
// operator choose a room-frame origin (e.g. a laser-measured corner) instead
// of the sensor. (0,0) = disabled, the default.
export const ATTR_MOUNT_OFFSET_X_MM = 0x0108; // int16, mm
export const ATTR_MOUNT_OFFSET_Y_MM = 0x0109; // int16, mm
export const ATTR_MOUNT_HEIGHT_MM   = 0x0107; // uint16, mm above the target's torso

/* Zone polygon provisioning. Read-back works (firmware W1); these are RW —
 * the configurator loads device geometry via device_load.layoutFromReports. */
export const ATTR_POLY_MASTER = 0x0200;
// V2.1 Delta B: 8 presence zones (was 4). Mirrors zigbee.h ATTR_POLY_PRES_0..7.
export const ATTR_POLY_PRES = [0x0201, 0x0202, 0x0203, 0x0204,
                               0x0205, 0x0206, 0x0207, 0x0208];
export const ATTR_POLY_EZ = [
  { inner: 0x0210, outer: 0x0211 }, // pair 0
  { inner: 0x0212, outer: 0x0213 }, // pair 1
];

/* Exclusion zone provisioning (write-only, 8-byte octet, sensor frame) */
export const ATTR_EXCL = [0x0220, 0x0221, 0x0222];

/* Per-zone presence config — zone n base 0x0300 + n*0x10 */
export const ATTR_ZCFG_BASE = 0x0300;
export const ATTR_ZCFG_STRIDE = 0x0010;
// holdMin (offset 5) is u16 (V2.1 Delta C) — all others are u8. Consumers that
// write it must use a 16-bit type; the Z2M converter's zone_N_hold_min key
// handles this at the MQTT boundary.
export const ZCFG_OFFSET = { entryFrames: 0, exitFrames: 1, statThreshMf: 2, statWindow: 3, statPersist: 4, holdMin: 5, style: 6 };

/* Occupancy Zone style is semantic configuration, not geometry tuning. The
 * Zigbee2MQTT converter exposes the names below; firmware stores the matching
 * u8 codes at zone-block offset +6. */
export const OCCUPANCY_ZONE_STYLE = Object.freeze({
  DEFAULT: 'default',
  BED: 'bed',
  CHAIR: 'chair',
  COUCH: 'couch',
  TABLE: 'table',
  TRANSIT_ONLY: 'transit_only',
});
export const OCCUPANCY_ZONE_STYLES = Object.freeze(Object.values(OCCUPANCY_ZONE_STYLE));
export const OCCUPANCY_ZONE_STYLE_CODE = Object.freeze({
  default: 0, bed: 1, chair: 2, couch: 3, table: 4, transit_only: 6,
  // 5 (walkway) retired 2026-08-23, burned, never reused. transit_only was
  // retired alongside it and RESTORED 2026-08-24 at its ORIGINAL value 6, so a
  // stored zone keeps the meaning it already had. Codes are NOT contiguous:
  // never derive one from an array index.
});
export function isOccupancyZoneStyle(style) {
  return OCCUPANCY_ZONE_STYLES.includes(style);
}
/** Wire code -> style name. NOT an array: the codes are not contiguous (5 is
 * burned), so indexing a names array by wire value would map 5 to transit_only
 * and 6 to undefined. Returns undefined for an unknown or retired code, which
 * callers must treat as invalid. */
export const OCCUPANCY_ZONE_STYLE_FROM_CODE = Object.freeze(
  Object.fromEntries(Object.entries(OCCUPANCY_ZONE_STYLE_CODE).map(([n, c]) => [c, n])));
export function occupancyZoneStyleFromCode(code) {
  return OCCUPANCY_ZONE_STYLE_FROM_CODE[code];
}
export function occupancyZoneStyleCode(style) {
  if (!isOccupancyZoneStyle(style)) throw new Error(`invalid occupancy zone style: ${style}`);
  return OCCUPANCY_ZONE_STYLE_CODE[style];
}
export function attrZcfg(zone, field) {
  return ATTR_ZCFG_BASE + zone * ATTR_ZCFG_STRIDE + ZCFG_OFFSET[field];
}

export const PRESENCE_ZONE_COUNT = 8;   // V2.1 Delta B (was 4); zigbee.h PRESENCE_ZONE_COUNT
export const ENTRY_EXIT_PAIRS = 2;
export const EXCLUSION_ZONE_COUNT = 3;
