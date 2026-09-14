/*
 * restart_layout.js — the editor's room layout ⇄ the restart layout record.
 *
 * The editor keeps the model in layout.js (mount + master + presence zones +
 * entry/exit pairs + exclusions). The restart device takes one versioned
 * layout (layout_codec.js, contract §2): pose, master, up to 12 spatial
 * records, native LD2450 zones. This file is the mapping, and nothing else.
 *
 * What does not carry over, deliberately:
 *   - entry/exit pairs: the restart has no EZ semantics; departure roles are a
 *     later layout generation (contract §2 "deferred");
 *   - the baseline's heightMm is "sensor height above the scatterer" — a
 *     derived value. The restart wants the two measured quantities, so the
 *     editor supplies `mount.sensorHeightMm` (floor to lens) and the scatterer
 *     height is derived here as sensorHeightMm − heightMm, never the other way.
 */

import { emptyLayout as emptyRestartLayout, POLICY, STYLE, NATIVE_MODE, LAYOUT_RECORD_COUNT } from './layout_codec.js';
import { OCCUPANCY_ZONE_STYLE } from './attributes.js';

/** Editor style name → restart {policy, style}. */
export const STYLE_MAP = Object.freeze({
  [OCCUPANCY_ZONE_STYLE.DEFAULT]: { policy: POLICY.normal, style: STYLE.default },
  [OCCUPANCY_ZONE_STYLE.BED]: { policy: POLICY.normal, style: STYLE.bed },
  [OCCUPANCY_ZONE_STYLE.CHAIR]: { policy: POLICY.normal, style: STYLE.chair },
  [OCCUPANCY_ZONE_STYLE.COUCH]: { policy: POLICY.normal, style: STYLE.couch },
  [OCCUPANCY_ZONE_STYLE.TABLE]: { policy: POLICY.normal, style: STYLE.table },
  [OCCUPANCY_ZONE_STYLE.TRANSIT_ONLY]: { policy: POLICY.transit_only, style: STYLE.none },
});

const REVERSE_STYLE = Object.freeze(Object.fromEntries(
  Object.entries(STYLE_MAP).map(([name, v]) => [`${v.policy}/${v.style}`, name]),
));

/**
 * Build the restart layout from an editor layout.
 * @param {object} layout  editor layout (layout.js shape)
 * @param {object} opts    { generation, geometryUncertaintyMm = 0, sensorHeightMm }
 *   sensorHeightMm may also come from layout.mount.sensorHeightMm.
 */
export function editorToRestart(layout, opts = {}) {
  const r = emptyRestartLayout();
  const m = layout.mount || {};
  const sensorHeightMm = opts.sensorHeightMm ?? m.sensorHeightMm ?? 0;
  const heightMm = m.heightMm ?? 0;
  if (heightMm > 0 && sensorHeightMm <= 0) {
    throw new Error('mount.sensorHeightMm (floor to lens) is required when heightMm is set: the restart stores measured heights, not the derived one');
  }
  if (heightMm > sensorHeightMm) throw new Error('mount.heightMm exceeds sensorHeightMm');
  r.generation = opts.generation ?? 0;
  r.originXmm = m.offsetXMm ?? 0;
  r.originYmm = m.offsetYMm ?? 0;
  r.yawTenths = m.yawDeciDeg ?? 0;
  r.inverted = !!m.inverted;
  r.sensorHeightMm = sensorHeightMm;
  r.scattererHeightMm = heightMm > 0 ? sensorHeightMm - heightMm : 0;
  r.geometryUncertaintyMm = opts.geometryUncertaintyMm ?? 0;
  if (layout.master && Array.isArray(layout.master.vertices) && layout.master.vertices.length >= 3) {
    r.masterActive = true;
    r.master = layout.master.vertices.map(({ x, y }) => [x, y]);
  }
  const presence = layout.presence || [];
  presence.forEach((zone, i) => {
    if (!zone || i >= LAYOUT_RECORD_COUNT) return;
    const mapped = STYLE_MAP[zone.style ?? OCCUPANCY_ZONE_STYLE.DEFAULT];
    if (!mapped) throw new Error(`presence[${i}].style ${zone.style} has no restart mapping`);
    r.records[i] = {
      spatialId: i + 1,
      active: true,
      policy: mapped.policy,
      style: mapped.style,
      boundaryRole: 0,
      reflectionProfile: 0,
      name: (zone.name || `zone_${i + 1}`).slice(0, 15),
      polygon: zone.vertices.map(({ x, y }) => [x, y]),
    };
  });
  const excl = (layout.exclusions || []).filter(Boolean);
  if (excl.length > 0) {
    r.nativeMode = NATIVE_MODE.exclusion;
    excl.slice(0, 3).forEach((e, i) => {
      r.nativeZones[i] = {
        x0: Math.min(e.x1, e.x2), y0: Math.min(e.y1, e.y2),
        x1: Math.max(e.x1, e.x2), y1: Math.max(e.y1, e.y2),
      };
    });
  }
  return r;
}

/** The editor layout a restart layout describes (round trip of the carried fields). */
export function restartToEditor(r) {
  const heightMm = r.scattererHeightMm > 0 ? r.sensorHeightMm - r.scattererHeightMm : 0;
  const layout = {
    mount: {
      yawDeciDeg: r.yawTenths, inverted: !!r.inverted,
      offsetXMm: r.originXmm, offsetYMm: r.originYmm,
      heightMm, sensorHeightMm: r.sensorHeightMm,
    },
    master: r.masterActive ? { vertices: r.master.map(([x, y]) => ({ x, y })) } : null,
    presence: new Array(8).fill(null),
    entryExit: [null, null],
    exclusions: [null, null, null],
  };
  r.records.forEach((rec, i) => {
    if (!rec.active || i >= layout.presence.length) return;
    const style = REVERSE_STYLE[`${rec.policy}/${rec.style}`] ?? OCCUPANCY_ZONE_STYLE.DEFAULT;
    layout.presence[i] = { vertices: rec.polygon.map(([x, y]) => ({ x, y })), style, name: rec.name };
  });
  if (r.nativeMode === NATIVE_MODE.exclusion) {
    r.nativeZones.forEach((z, i) => {
      if (z.x0 === 0 && z.y0 === 0 && z.x1 === 0 && z.y1 === 0) return;
      layout.exclusions[i] = { x1: z.x0, y1: z.y0, x2: z.x1, y2: z.y1 };
    });
  }
  return layout;
}
