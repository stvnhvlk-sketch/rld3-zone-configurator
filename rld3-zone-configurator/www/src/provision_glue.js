/*
 * provision_glue.js — the pure baseline→session→plan glue for the UI's Safe
 * Provision (3T-zone-configurator.md §14, task A3).
 *
 * The browser holds two layouts in the same wire frame (sensor-at-origin room
 * frame): `base`, the device baseline from the last Read, and `cur`, the
 * operator's current geometry (appToLayout). This module turns the pair into a
 * layout_edit session with ONLY the changed zones marked dirty, then into the
 * host-tested safe provision plan. Keeping it out of index.html is what lets it
 * run under `node --test` — the safety invariants live in layout_edit, and the
 * only new logic here (which zone changed) is exactly what needs a host test.
 *
 * The UI zone ids (pres0, ez0_in, excl0…) map to layout_edit session keys
 * (presence0, ez0_in, excl0…); appToLayout already emits the canonical layout
 * shape, so the mapping is just presence[n] → `presence${n}`.
 */

import {
  createEditSession, setZoneVertices, setExclusionRect, setMount, buildProvisionPlan,
} from './layout_edit.js';
import { emptyLayout } from './layout.js';
import { POLY_KEY, EXCL_KEY, MOUNT_KEY } from './z2m_adapter.js';
import { PRESENCE_ZONE_COUNT, ENTRY_EXIT_PAIRS, EXCLUSION_ZONE_COUNT } from './attributes.js';

/** Two polygon zone values ({vertices}|null) are equal iff same verts in order. */
export function polygonsEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const av = a.vertices, bv = b.vertices;
  return av.length === bv.length && av.every((v, i) => v.x === bv[i].x && v.y === bv[i].y);
}

/** Two exclusion rects ({x1,y1,x2,y2}|null) are equal iff all four corners match. */
export function rectsEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.x1 === b.x1 && a.y1 === b.y1 && a.x2 === b.x2 && a.y2 === b.y2;
}

/**
 * Build an edit session from `base` and apply `cur` as edits where they differ.
 * Only changed zones are marked dirty. A zone the operator cleared but that was
 * loaded is set null — buildProvisionPlan then skips it as empty-not-written
 * (never blanks real device state). A missing baseline is treated as empty:
 * undrawn zones stay null==null (unchanged, untouched); drawn zones are additive
 * writes that blank nothing.
 */
export function sessionFromLayouts(base, cur, opts = {}) {
  const b = base ?? emptyLayout();
  const session = createEditSession(b, opts);

  const polyMap = [
    ['master', cur.master, b.master],
    ...Array.from({ length: PRESENCE_ZONE_COUNT }, (_, n) =>
      [`presence${n}`, cur.presence[n], b.presence[n]]),   // V2.1 Delta B (was [0,1,2,3])
    ['ez0_in', cur.entryExit[0]?.inner ?? null, b.entryExit[0]?.inner ?? null],
    ['ez0_out', cur.entryExit[0]?.outer ?? null, b.entryExit[0]?.outer ?? null],
    ['ez1_in', cur.entryExit[1]?.inner ?? null, b.entryExit[1]?.inner ?? null],
    ['ez1_out', cur.entryExit[1]?.outer ?? null, b.entryExit[1]?.outer ?? null],
  ];
  for (const [key, c, bv] of polyMap) {
    if (!polygonsEqual(c, bv)) setZoneVertices(session, key, c ? c.vertices : null);
  }
  for (let n = 0; n < 3; n++) {
    if (!rectsEqual(cur.exclusions[n], b.exclusions[n])) setExclusionRect(session, `excl${n}`, cur.exclusions[n]);
  }
  if (cur.mount.yawDeciDeg !== b.mount.yawDeciDeg || !!cur.mount.inverted !== !!b.mount.inverted) {
    setMount(session, cur.mount);
  }
  return session;
}

/** Convenience: the session and its safe provision plan in one call. */
export function planFromLayouts(base, cur, opts = {}) {
  const session = sessionFromLayouts(base, cur, opts);
  return { session, plan: buildProvisionPlan(session, opts) };
}

/*
 * Reverse map: converter property key (plan.sets[].key) → session zone key.
 * Built once from the same constants layout_edit.js uses in its REGISTRY, so the
 * two stay in sync without coupling provision_glue to layout_edit's internals.
 */
const PROP_TO_SESSION = (() => {
  const m = new Map();
  m.set(POLY_KEY.master, 'master');
  for (let i = 0; i < PRESENCE_ZONE_COUNT; i++) m.set(POLY_KEY.presence[i], `presence${i}`);
  for (let i = 0; i < ENTRY_EXIT_PAIRS; i++) {
    m.set(POLY_KEY.ez[i].inner, `ez${i}_in`);
    m.set(POLY_KEY.ez[i].outer, `ez${i}_out`);
  }
  for (let i = 0; i < EXCLUSION_ZONE_COUNT; i++) m.set(EXCL_KEY[i], `excl${i}`);
  m.set(MOUNT_KEY.yaw, 'mount');
  m.set(MOUNT_KEY.inverted, 'mount');
  return m;
})();

/**
 * Check whether the device's re-read layout confirms what was just written.
 *
 * For each zone that was actually written (plan.sets), compares the re-read
 * layout against the intended write (writtenLayout). A zone is confirmed when
 * re-read and intended values match; it is unconfirmed when they still differ
 * (the write was silently dropped or rejected by the device). Every writable zone
 * is readable back — polygons (W1) and exclusions (Phase B) — so a mismatch is a
 * real failure, not a read-back gap.
 *
 * @param {object} plan          - provision plan returned by planFromLayouts
 * @param {object} writtenLayout - appToLayout() snapshot captured at write time
 * @param {object} reReadLayout  - layoutFromReports().layout after the write settled
 * @returns {{ confirmed: string[], unconfirmed: string[] }}
 */
export function confirmPlan(plan, writtenLayout, reReadLayout) {
  const writtenKeys = new Set();
  for (const { key } of plan.sets) {
    const sk = PROP_TO_SESSION.get(key);
    if (sk) writtenKeys.add(sk);
  }
  // Any zone that still differs in the re-read was not accepted by the device.
  const remaining = sessionFromLayouts(reReadLayout, writtenLayout);
  const confirmed = [], unconfirmed = [];
  for (const key of writtenKeys) {
    (remaining.dirty.has(key) ? unconfirmed : confirmed).push(key);
  }
  return { confirmed, unconfirmed };
}
