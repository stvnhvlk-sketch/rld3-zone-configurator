/*
 * layout_edit.js — edit session + SAFE provision plan (ZC §12 Phase 2).
 *
 * Phase 1 loads the device's geometry (read-only). Phase 2 lets the operator
 * change it and write only what they changed — safely. This module is the pure,
 * host-tested core of that; the browser only calls it and sends the resulting
 * sets. All the source-of-truth safety lives here (CLAUDE.md "Consuming another
 * system's source of truth", 3T-zone-configurator.md §4/§12):
 *
 *   - Write ONLY zones the operator actually edited (dirty). An untouched zone is
 *     never rewritten — no accidental re-provision, matches the firmware's
 *     per-attr / one-octet-per-frame write model.
 *   - The BULK plan built here NEVER writes an empty (null) zone over a real
 *     one — an emptied draft is skipped, not written as blank. Deleting a
 *     provisioned zone is a deliberate, separate act, outside this plan
 *     entirely: the dedicated "Delete from Sensor" action (Phase D, ui/
 *     index.html) sends an explicit empty value for exactly one zone's key,
 *     which the device treats as an erase (zero-length octet write).
 *   - NEVER write an invalid draft. A polygon that fails the codec's rules is
 *     skipped with a warning, never sent as bytes the device would reject or
 *     mis-store.
 *
 * The plan is a list of z2m_adapter {key, value} sets — the same shape
 * layoutToZ2mSets emits — so the adapter provisions it unchanged.
 */

import { emptyLayout, validateLayout } from './layout.js';
import { encodePolygon, bytesToHex, validatePolygon, DEFAULT_MAX_VERTICES } from './polygon_codec.js';
import { POLY_KEY, EXCL_KEY, MOUNT_KEY } from './z2m_adapter.js';
import { PRESENCE_ZONE_COUNT, ENTRY_EXIT_PAIRS, EXCLUSION_ZONE_COUNT } from './attributes.js';

/* Canonical zone registry — one descriptor per writable slot. Drives edits and
 * the provision plan so there's a single place that knows key ↔ layout path. */
function buildRegistry() {
  const zones = [
    { key: 'master', kind: 'poly', propKey: POLY_KEY.master,
      get: (l) => l.master, set: (l, v) => { l.master = v; } },
  ];
  for (let i = 0; i < PRESENCE_ZONE_COUNT; i++) {
    zones.push({ key: `presence${i}`, kind: 'poly', propKey: POLY_KEY.presence[i],
      get: (l) => l.presence[i], set: (l, v) => { l.presence[i] = v; } });
  }
  for (let i = 0; i < ENTRY_EXIT_PAIRS; i++) {
    zones.push({ key: `ez${i}_in`, kind: 'poly', propKey: POLY_KEY.ez[i].inner,
      get: (l) => l.entryExit[i]?.inner ?? null,
      set: (l, v) => { (l.entryExit[i] ||= { inner: null, outer: null }).inner = v; } });
    zones.push({ key: `ez${i}_out`, kind: 'poly', propKey: POLY_KEY.ez[i].outer,
      get: (l) => l.entryExit[i]?.outer ?? null,
      set: (l, v) => { (l.entryExit[i] ||= { inner: null, outer: null }).outer = v; } });
  }
  for (let i = 0; i < EXCLUSION_ZONE_COUNT; i++) {
    zones.push({ key: `excl${i}`, kind: 'excl', propKey: EXCL_KEY[i],
      get: (l) => l.exclusions[i], set: (l, v) => { l.exclusions[i] = v; } });
  }
  return zones;
}

const REGISTRY = buildRegistry();
const byKey = new Map(REGISTRY.map((z) => [z.key, z]));

/** Deep-ish clone of a layout (plain data: numbers, arrays, small objects). */
function cloneLayout(layout) {
  return JSON.parse(JSON.stringify({ ...emptyLayout(), ...layout }));
}

/**
 * Start an edit session from a loaded layout. `draft` is the mutable working
 * copy; `baseline` is what was loaded (for revert/diff); `dirty` marks operator
 * edits. Mount edits are tracked under the pseudo-key 'mount'.
 */
export function createEditSession(layout, { maxVertices = DEFAULT_MAX_VERTICES } = {}) {
  return {
    baseline: cloneLayout(layout),
    draft: cloneLayout(layout),
    dirty: new Set(),
    maxVertices,
  };
}

/**
 * Insert a vertex after `afterIndex` in a polygon zone (splice between
 * vertices[afterIndex] and vertices[afterIndex+1]). Marks the zone dirty.
 */
export function addVertex(session, zoneKey, afterIndex, vertex) {
  const z = byKey.get(zoneKey);
  if (!z || z.kind !== 'poly') throw new Error(`not a polygon zone: ${zoneKey}`);
  const poly = z.get(session.draft);
  const verts = poly ? poly.vertices.map((v) => ({ x: v.x, y: v.y })) : [];
  verts.splice(afterIndex + 1, 0, { x: Math.round(vertex.x), y: Math.round(vertex.y) });
  z.set(session.draft, { vertices: verts });
  session.dirty.add(zoneKey);
}

/**
 * Remove the vertex at `index` from a polygon zone. Throws if the result
 * would have fewer than 3 vertices (a polygon needs at least a triangle).
 */
export function deleteVertex(session, zoneKey, index) {
  const z = byKey.get(zoneKey);
  if (!z || z.kind !== 'poly') throw new Error(`not a polygon zone: ${zoneKey}`);
  const poly = z.get(session.draft);
  if (!poly || poly.vertices.length <= 3) throw new Error('polygon must keep ≥ 3 vertices');
  const verts = poly.vertices.map((v) => ({ x: v.x, y: v.y }));
  verts.splice(index, 1);
  z.set(session.draft, { vertices: verts });
  session.dirty.add(zoneKey);
}

/** Replace a polygon zone's vertices (null clears the draft; still marked dirty). */
export function setZoneVertices(session, zoneKey, vertices) {
  const z = byKey.get(zoneKey);
  if (!z || z.kind !== 'poly') throw new Error(`not a polygon zone: ${zoneKey}`);
  z.set(session.draft, vertices ? { vertices: vertices.map((v) => ({ x: v.x, y: v.y })) } : null);
  session.dirty.add(zoneKey);
}

/** Replace an exclusion zone's rect (sensor frame; null clears the draft). */
export function setExclusionRect(session, zoneKey, rect) {
  const z = byKey.get(zoneKey);
  if (!z || z.kind !== 'excl') throw new Error(`not an exclusion zone: ${zoneKey}`);
  z.set(session.draft, rect ? { ...rect } : null);
  session.dirty.add(zoneKey);
}

/** Set mount (yaw in 0.1°, inverted). Marks 'mount' dirty. */
export function setMount(session, { yawDeciDeg, inverted }) {
  if (yawDeciDeg !== undefined) session.draft.mount.yawDeciDeg = yawDeciDeg;
  if (inverted !== undefined) session.draft.mount.inverted = !!inverted;
  session.dirty.add('mount');
}

/** Discard a zone's edits, restoring the loaded value (deep-copied so the
 *  draft never shares refs with the baseline). */
export function revertZone(session, zoneKey) {
  if (zoneKey === 'mount') {
    session.draft.mount = { ...session.baseline.mount };
  } else {
    const z = byKey.get(zoneKey);
    if (!z) throw new Error(`unknown zone: ${zoneKey}`);
    const baseVal = z.get(session.baseline);
    z.set(session.draft, baseVal ? JSON.parse(JSON.stringify(baseVal)) : null);
  }
  session.dirty.delete(zoneKey);
}

export function isDirty(session, zoneKey) { return session.dirty.has(zoneKey); }
export function anyDirty(session) { return session.dirty.size > 0; }

/** Current draft value for a zone (poly {vertices} / rect / null). Deep-copied. */
export function getZone(session, zoneKey) {
  const z = byKey.get(zoneKey);
  if (!z) throw new Error(`unknown zone: ${zoneKey}`);
  const v = z.get(session.draft);
  return v ? JSON.parse(JSON.stringify(v)) : null;
}

/* ----------------------------------------------------------------------------
 * The safe provision plan
 * ------------------------------------------------------------------------- */

function polyValue(poly, maxVertices) {
  return bytesToHex(encodePolygon(poly.vertices, { maxVertices }));
}

/**
 * Build the safe set of writes for the current draft: only dirty, non-empty,
 * valid zones. Everything skipped is reported with a reason so the UI can show
 * what will (and won't) be written before the operator commits.
 *
 * @returns {{ sets:{key,value}[], skipped:{zone,reason}[], warnings:string[] }}
 */
export function buildProvisionPlan(session, { maxVertices = session.maxVertices ?? DEFAULT_MAX_VERTICES } = {}) {
  const sets = [];
  const skipped = [];
  const warnings = [];

  // Mount first (frame-dependent), only if edited.
  if (session.dirty.has('mount')) {
    const { ok, errors } = validateLayout(
      { ...emptyLayout(), mount: session.draft.mount }, { maxVertices });
    if (ok) {
      sets.push({ key: MOUNT_KEY.yaw, value: session.draft.mount.yawDeciDeg });
      sets.push({ key: MOUNT_KEY.inverted, value: !!session.draft.mount.inverted });
    } else {
      skipped.push({ zone: 'mount', reason: 'invalid' });
      warnings.push(`mount: ${errors.join('; ')}`);
    }
  }

  for (const z of REGISTRY) {
    if (!session.dirty.has(z.key)) { skipped.push({ zone: z.key, reason: 'unchanged' }); continue; }
    const draft = z.get(session.draft);

    // SAFETY: an emptied draft is never written as blank over a real zone.
    if (draft == null) { skipped.push({ zone: z.key, reason: 'empty-not-written' }); continue; }

    if (z.kind === 'poly') {
      const { ok, errors } = validatePolygon(draft.vertices, { maxVertices });
      if (!ok) { skipped.push({ zone: z.key, reason: 'invalid' }); warnings.push(`${z.key}: ${errors.join('; ')}`); continue; }
      sets.push({ key: z.propKey, value: polyValue(draft, maxVertices) });
    } else { // exclusion
      const bad = ['x1', 'y1', 'x2', 'y2'].some((k) => !Number.isInteger(draft[k]) || draft[k] < -32768 || draft[k] > 32767);
      if (bad) { skipped.push({ zone: z.key, reason: 'invalid' }); warnings.push(`${z.key}: not int16 mm`); continue; }
      sets.push({ key: z.propKey, value: `${draft.x1},${draft.y1},${draft.x2},${draft.y2}` });
    }
  }

  return { sets, skipped, warnings };
}

/** Mark the plan's zones clean after a successful write (call once the adapter confirms). */
export function markProvisioned(session, plan) {
  const written = new Set(plan.sets.map((s) => s.key));
  if (written.has(MOUNT_KEY.yaw) || written.has(MOUNT_KEY.inverted)) session.dirty.delete('mount');
  for (const z of REGISTRY) if (written.has(z.propKey)) session.dirty.delete(z.key);
}

