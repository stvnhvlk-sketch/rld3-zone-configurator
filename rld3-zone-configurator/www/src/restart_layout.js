/* Restart layout ⇄ editor. Wire heights are opaque metadata (D-24 O1).
 * Record positions carry bitmask identity; spatial IDs survive all editing.
 */
import { emptyLayout as emptyRestartLayout, POLICY, STYLE, NATIVE_MODE, LAYOUT_RECORD_COUNT } from './layout_codec.js';
import { validatePolygon } from './polygon_codec.js';
import { assertDoorsDisjoint } from './door_layout.js';
import { nextSpatialId, checkSpatialIds, defaultName, kindOf } from './elements.js';
import { OCCUPANCY_ZONE_STYLE } from './attributes.js';

// UI yaw rotates sensor +y (boresight bearing = UI yaw + 90°).
// Restart design.md §2.2 stores that bearing directly. Keep both conversions
// here; canonicalise equivalent ±180° as +180°, matching (-180, +180].
const QUARTER_TURN_TENTHS = 900;
const HALF_TURN_TENTHS = 1800;
const FULL_TURN_TENTHS = 3600;
function wrapYawTenths(yaw) {
  const wrapped = ((yaw % FULL_TURN_TENTHS) + FULL_TURN_TENTHS) % FULL_TURN_TENTHS;
  return wrapped > HALF_TURN_TENTHS ? wrapped - FULL_TURN_TENTHS : wrapped;
}

/** Editor style name → restart {policy, style}. */
export const STYLE_MAP = Object.freeze({
  none: { policy: POLICY.normal, style: STYLE.none },
  [OCCUPANCY_ZONE_STYLE.DEFAULT]: { policy: POLICY.normal, style: STYLE.default },
  [OCCUPANCY_ZONE_STYLE.BED]: { policy: POLICY.normal, style: STYLE.bed },
  [OCCUPANCY_ZONE_STYLE.CHAIR]: { policy: POLICY.normal, style: STYLE.chair },
  [OCCUPANCY_ZONE_STYLE.COUCH]: { policy: POLICY.normal, style: STYLE.couch },
  [OCCUPANCY_ZONE_STYLE.TABLE]: { policy: POLICY.normal, style: STYLE.table },
  [OCCUPANCY_ZONE_STYLE.TRANSIT_ONLY]: { policy: POLICY.transit_only, style: STYLE.none },
});

/**
 * Build the restart layout from an editor layout.
 * @param {object} layout  editor layout (layout.js shape)
 * @param {object} opts    { generation, geometryUncertaintyMm = 0, sensorHeightMm }
 *   sensorHeightMm may also come from layout.mount.sensorHeightMm.
 */
export function editorToRestart(layout, opts = {}) {
  if ((layout.entryExit || []).some((pair) => pair != null)) {
    throw new Error('Restart does not support EZ inner/outer pairs. Remove the EZ drawings explicitly before sending.');
  }
  assertDoorsDisjoint(layout.master?.vertices, layout.doors || []);
  for (const zone of [layout.master,...(layout.presence || [])].filter(Boolean)) {
    const result=validatePolygon(zone.vertices);
    if(!result.ok)throw new Error(`${zone.name || 'Room'}: ${result.errors.join('; ')}`);
  }
  if ((layout.presence || []).slice(LAYOUT_RECORD_COUNT).some(Boolean)) throw new Error('Restart has only 12 slots');
  const r = layout.restartMetadata ? structuredClone(layout.restartMetadata) : emptyRestartLayout();
  const m = layout.mount || {};
  const sensorHeightMm = opts.sensorHeightMm ?? m.sensorHeightMm ?? 0;
  // Legacy JSON carried a derived height; convert only when no raw metadata exists.
  const scattererHeightMm = m.scattererHeightMm ?? ((m.heightMm ?? 0) > 0 ? sensorHeightMm - m.heightMm : 0);
  if (scattererHeightMm < 0) throw new Error('mount.heightMm exceeds sensorHeightMm');
  r.generation = opts.generation ?? 0;
  r.originXmm = m.offsetXMm ?? 0;
  r.originYmm = m.offsetYMm ?? 0;
  r.yawTenths = wrapYawTenths((m.yawDeciDeg ?? 0) + QUARTER_TURN_TENTHS);
  r.inverted = !!m.inverted;
  r.sensorHeightMm = sensorHeightMm;
  r.scattererHeightMm = scattererHeightMm;
  r.geometryUncertaintyMm = opts.geometryUncertaintyMm ?? r.geometryUncertaintyMm;
  r.masterActive = false;
  if (layout.master && Array.isArray(layout.master.vertices) && layout.master.vertices.length >= 3) {
    r.masterActive = true;
    r.master = layout.master.vertices.map(({ x, y }) => [x, y]);
  }
  const presence = layout.presence || [];
  const zones = presence.filter(Boolean), doors = layout.doors || [];
  if (zones.length + doors.length > LAYOUT_RECORD_COUNT) throw new Error('Zones and doors share the 12 record limit');
  // Old callers/documents without IDs are upgraded without renumbering explicit IDs.
  const elements = [...zones, ...doors].map(e => ({...e}));
  for (const e of elements) if (e.spatialId == null) e.spatialId = nextSpatialId(elements);
  checkSpatialIds(elements);
  r.records = emptyRestartLayout().records;
  let at = 0;
  presence.forEach((zone, i) => {
    if (!zone) return;
    const mapped = STYLE_MAP[zone.style ?? OCCUPANCY_ZONE_STYLE.DEFAULT];
    if (!mapped) throw new Error(`${zone.name || 'Zone'}.style ${zone.style} has no restart mapping`);
    const policy = zone.policy ?? mapped.policy, spatialId = elements[at++].spatialId;
    r.records[i] = {spatialId, active:true, policy, style:zone.styleCode ?? mapped.style,
      boundaryRole:zone.boundaryRole ?? 0, reflectionProfile:zone.reflectionProfile ?? 0,
      name:zone.name || defaultName(kindOf(policy), spatialId), polygon:zone.vertices.map(({x,y})=>[x,y])};
  });
  for (const door of doors) {
    const free = door.recordIndex != null && !r.records[door.recordIndex]?.active ? door.recordIndex : r.records.findIndex(rec=>!rec.active);
    if (free < 0 || free >= LAYOUT_RECORD_COUNT) throw new Error('Zones and doors share the 12 record limit');
    if (!door || !Array.isArray(door.vertices) || door.vertices.length !== 2) throw new Error('Door requires two wall endpoints');
    const spatialId = elements[at++].spatialId;
    r.records[free] = {spatialId, active:true, policy:door.policy ?? 0, style:door.styleCode ?? 0,
      boundaryRole:door.boundaryRole ?? 3, reflectionProfile:door.reflectionProfile ?? 0,
      name:door.name || defaultName('door', spatialId), polygon:door.vertices.map(({x,y})=>[x,y]), doorToleranceMm:door.toleranceMm};
  }
  // Native slots cannot be compacted: Mask 3 is still native rectangle 3.
  if ((layout.exclusions || []).some(Boolean)) {
    r.nativeMode = NATIVE_MODE.exclusion;
    r.nativeZones = emptyRestartLayout().nativeZones;
    (layout.exclusions || []).slice(0,3).forEach((e,i) => { if(e) r.nativeZones[i] = {
      x0:Math.min(e.x1,e.x2), y0:Math.min(e.y1,e.y2), x1:Math.max(e.x1,e.x2), y1:Math.max(e.y1,e.y2)}; });
  } else if (r.nativeMode === NATIVE_MODE.exclusion) {
    r.nativeZones = emptyRestartLayout().nativeZones;
    r.nativeMode = NATIVE_MODE.disabled;
  }
  return r;
}

/** The editor layout a restart layout describes (round trip of the carried fields). */
export function restartToEditor(r) {
  const heightMm = r.scattererHeightMm > 0 ? r.sensorHeightMm - r.scattererHeightMm : 0;
  const layout = {
    mount: {
      yawDeciDeg: wrapYawTenths(r.yawTenths - QUARTER_TURN_TENTHS), inverted: !!r.inverted,
      offsetXMm: r.originXmm, offsetYMm: r.originYmm,
      heightMm, sensorHeightMm: r.sensorHeightMm, scattererHeightMm:r.scattererHeightMm,
    },
    restartMetadata: structuredClone(r),
    master: r.masterActive ? { vertices: r.master.map(([x, y]) => ({ x, y })) } : null,
    presence: new Array(LAYOUT_RECORD_COUNT).fill(null),
    doors: [],
    entryExit: [null, null],
    exclusions: [null, null, null],
  };
  r.records.forEach((rec, i) => {
    if (!rec.active || i >= layout.presence.length) return;
    if (rec.boundaryRole && rec.polygon.length === 2) {
      layout.doors.push({spatialId:rec.spatialId, recordIndex:i, boundaryRole:rec.boundaryRole, reflectionProfile:rec.reflectionProfile, policy:rec.policy, styleCode:rec.style, name:rec.name || defaultName('door',rec.spatialId),vertices:rec.polygon.map(([x,y])=>({x,y})),toleranceMm:rec.doorToleranceMm ?? 0});
      return;
    }
    const style = rec.policy === POLICY.transit_only && rec.style === STYLE.none
      ? OCCUPANCY_ZONE_STYLE.TRANSIT_ONLY
      : (Object.keys(STYLE).find((name) => STYLE[name] === rec.style) ?? OCCUPANCY_ZONE_STYLE.DEFAULT);
    layout.presence[i] = { vertices: rec.polygon.map(([x, y]) => ({ x, y })), style, policy: rec.policy, spatialId:rec.spatialId, styleCode:rec.style, boundaryRole:rec.boundaryRole, reflectionProfile:rec.reflectionProfile, name: rec.name || defaultName(kindOf(rec.policy),rec.spatialId) };
  });
  if (r.nativeMode === NATIVE_MODE.exclusion) {
    r.nativeZones.forEach((z, i) => {
      if (z.x0 === 0 && z.y0 === 0 && z.x1 === 0 && z.y1 === 0) return;
      layout.exclusions[i] = { x1: z.x0, y1: z.y0, x2: z.x1, y2: z.y1 };
    });
  }
  return layout;
}
