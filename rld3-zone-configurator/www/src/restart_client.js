/*
 * restart_client.js — the Configurator side of the restart transport.
 *
 * Speaks the RLD3Restart.mjs converter keys over an injected transport
 * ({publish(topic, payload), subscribe(topic, handler)}), so it is testable
 * without a broker. Implements contract §2 as the Configurator must drive it:
 *
 *   write:  begin → chunk × N → (device validates) → commit → verify
 *           generation/hash equality → read back and compare bytes
 *   live:   live_view ON/OFF; live_frame records decoded by the converter
 *           arrive on the state topic and are handed to the caller
 *
 * Success is only ever claimed from the device's own state: config_state,
 * config_generation, config_hash as read back, never from a write having
 * been published (INTERFACE-CONTRACT: a Command is the write event; what it
 * did is Data). The client never retries a chunk on its own — a rejection is
 * surfaced with the device's reason so the operator sees it.
 */

import { LAYOUT_BYTES, LAYOUT_SCHEMA, layoutHash } from './layout_codec.js';

export const CHUNK_BYTES = 48;
export const DEFAULT_TIMEOUT_MS = 8000;
export const SUPPLY_CLEAR_CONFIRM_MS = 10000; // 8 s request allowance + 2 s click allowance.
/* Zigbee2MQTT serialises writes per device; pacing chunks keeps the write
 * queue short and gives the device's chunk queue (depth 6) room. */
export const DEFAULT_CHUNK_INTERVAL_MS = 200;

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => Uint8Array.from(s.match(/../g) || [], (h) => parseInt(h, 16));

export class RestartRejected extends Error {
  constructor(state) {
    super(`device rejected: ${state.config_reason ?? '?'} (detail ${state.config_detail ?? '?'}, offset ${state.config_offset ?? '?'})`);
    this.state = state;
  }
}

export function createRestartClient({ transport, device, baseTopic = 'zigbee2mqtt',
  timeoutMs = DEFAULT_TIMEOUT_MS, chunkIntervalMs = DEFAULT_CHUNK_INTERVAL_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!transport || typeof transport.publish !== 'function' || typeof transport.subscribe !== 'function') {
    throw new TypeError('transport.publish and transport.subscribe are required');
  }
  if (!device) throw new TypeError('device (friendly name) is required');

  const setTopic = `${baseTopic}/${device}/set`;
  const getTopic = `${baseTopic}/${device}/get`;
  const stateTopic = `${baseTopic}/${device}`;

  const state = {};                 // last known device state, merged
  const stateListeners = new Set();
  const frameListeners = new Set();
  const waiters = [];               // { predicate, resolve, timer }
  let lastFrame = null;

  transport.subscribe(stateTopic, (payload) => {
    let obj;
    try { obj = typeof payload === 'string' ? JSON.parse(payload) : JSON.parse(new TextDecoder().decode(payload)); } catch { return; }
    Object.assign(state, obj);
    for (const l of stateListeners) l(obj, state);
    /* Command 0x02 supplies live_frame directly. Z2M may re-carry that frame
     * on unrelated cached-state updates. Identity comes from the frame itself:
     * the top-level boot_session read may precede or follow a reboot's frame. */
    const frame = obj.live_frame;
    if (frame && (!lastFrame || frame.boot_session !== lastFrame.boot_session
        || frame.frame_sequence !== lastFrame.frame_sequence)) {
      lastFrame = { boot_session: frame.boot_session, frame_sequence: frame.frame_sequence };
      for (const l of frameListeners) l(frame);
    }
    for (const w of waiters.slice()) {
      if (w.predicate(state, obj)) { clearTimeout(w.timer); waiters.splice(waiters.indexOf(w), 1); w.resolve({ ...state }); }
    }
  });

  function set(payload) { transport.publish(setTopic, JSON.stringify(payload)); }
  function get(keys) {
    const p = {};
    for (const k of Array.isArray(keys) ? keys : [keys]) p[k] = '';
    transport.publish(getTopic, JSON.stringify(p));
  }

  /** Resolve when the merged state satisfies predicate; reject on timeout. */
  function waitFor(predicate, what, ms = timeoutMs) {
    if (predicate(state, {})) return Promise.resolve({ ...state });
    return new Promise((resolve, reject) => {
      const w = { predicate, resolve, timer: null };
      waiters.push(w);
      w.timer = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) { waiters.splice(i, 1); reject(new Error(`timeout waiting for ${what}`)); }
      }, ms);
    });
  }

  /** Read the identity/status keys; resolves with the merged state. */
  async function readStatus() {
    const keys = ['boot_session', 'interface_revision', 'config_generation', 'config_hash',
      'transform_generation', 'stream_state', 'config_state', 'config_reason', 'config_detail', 'config_offset', 'live_view'];
    /* Each key is a separate converter read. Wait for the complete summary,
     * including mode and rejection details, rather than the first state key.
     * Cached MQTT state still cannot prove when each field was read. */
    const frameBefore = lastFrame;
    for (const key of keys) delete state[key];
    get(keys);
    const status = await waitFor((s) => {
      if (!keys.every((key) => s[key] !== undefined)) return false;
      if (s.live_view !== 'ON') return true;
      // Live republishes can fill deleted keys with stale cached status.
      // Require a distinct post-request frame and atomic pose agreement.
      // Keep status authoritative and retain all read-back comparisons.
      const f = s.live_frame;
      return lastFrame !== frameBefore && f && f.boot_session === s.boot_session
        && f.transform_generation === s.transform_generation;
    }, 'status read (live pose agreement)');
    return status;
  }

  /** Explicit Developer read only: never polled or added to readStatus().
   * Null means unavailable; firmware values refresh internally within 500 ms.
   * Z2M cached-state replay still limits per-field freshness. */
  async function readSupply() {
    const keys = ['supply_undervoltage_now', 'supply_undervoltage_since_boot', 'supply_minimum_since_boot_mv', 'supply_dip_count_since_boot', 'supply_mv', 'supply_deepest_mv', 'supply_droop_count',
      'supply_since_droop_ms', 'supply_calibrated', 'supply_available',
      'supply_gaps', 'supply_hardware_alerts', 'supply_persistence_errors',
      'supply_gain_ppm', 'supply_reference_mv', 'supply_raw_average',
      'supply_measured_mv', 'supply_cal_status', 'supply_deepest_duration_us', 'supply_clear_status'];
    for (const key of keys) delete state[key];
    get(keys);
    await waitFor((s) => keys.every((key) => s[key] !== undefined), 'supply read');
    return Object.fromEntries(keys.map((key) => [key, state[key]]));
  }

  let clearArmedUntil = 0;
  function armSupplyClear() {
    set({ supply_clear: 1 });
    clearArmedUntil = Date.now() + SUPPLY_CLEAR_CONFIRM_MS;
  }
  function clearSupplyHistory() {
    if (!clearArmedUntil || Date.now() >= clearArmedUntil) throw new Error('Arm history clear first; confirmation expires after 10 seconds');
    clearArmedUntil = 0;
    set({ supply_clear: 2 });
    // Read supply_clear_status later; do not invent completion locally.
  }

  function calibrateSupply(referenceMv) {
    if (!Number.isInteger(referenceMv) || referenceMv < 1000 || referenceMv > 6600)
      throw new RangeError('reference must be 1000..6600 mV');
    set({ supply_calibrate: referenceMv });
    // Caller reads supply_cal_status: 1 pending, 2 durable success, 3 failed.
  }

  /**
   * Write one encoded layout blob as a transaction and prove it landed.
   * Resolves { generation, hash } (hash as the device reports it, lower hex).
   * Rejects with RestartRejected carrying the device's reason.
   */
  async function writeLayout(blob, { generation, onProgress = () => {} } = {}) {
    if (!(blob instanceof Uint8Array) || blob.length !== LAYOUT_BYTES) throw new TypeError(`blob must be ${LAYOUT_BYTES} bytes`);
    if (!Number.isInteger(generation)) throw new TypeError('generation is required');
    const hash = layoutHash(blob) >>> 0;
    const hashHex = hash.toString(16).padStart(8, '0');

    onProgress({ phase: 'begin' });
    delete state.config_state;
    set({ config_begin: { generation, length: LAYOUT_BYTES, hash, schema: LAYOUT_SCHEMA } });
    let s = await waitFor((st) => st.config_state === 'staging' || st.config_state === 'rejected', 'begin');
    if (s.config_state !== 'staging') throw new RestartRejected(s);

    const total = Math.ceil(LAYOUT_BYTES / CHUNK_BYTES);
    for (let i = 0, off = 0; off < LAYOUT_BYTES; i++, off += CHUNK_BYTES) {
      set({ config_chunk: { offset: off, bytes: hex(blob.subarray(off, off + CHUNK_BYTES)) } });
      onProgress({ phase: 'chunk', index: i + 1, total });
      if (state.config_state === 'rejected') throw new RestartRejected(state);
      await sleep(chunkIntervalMs);
    }
    s = await waitFor((st) => st.config_state === 'staged' || st.config_state === 'rejected', 'staging to complete');
    if (s.config_state !== 'staged') throw new RestartRejected(s);

    onProgress({ phase: 'commit' });
    set({ config_commit: generation });
    s = await waitFor((st) => st.config_state === 'committed' || st.config_state === 'rejected', 'commit');
    if (s.config_state !== 'committed') throw new RestartRejected(s);

    onProgress({ phase: 'verify' });
    /* Zigbee2MQTT republishes its whole cached state with every update, so a
     * message carrying config_hash is not proof the hash was just read. Verify
     * therefore waits for equality with what was sent, and a timeout is the
     * failure: "the device never said what we sent" is the honest result. */
    get(['config_generation', 'config_hash', 'transform_generation']);
    try {
      s = await waitFor((st) => st.config_generation === generation && st.config_hash === hashHex, 'verify read');
    } catch (e) {
      throw new Error(`verify failed: device reports generation ${state.config_generation} hash ${state.config_hash}, sent ${generation} ${hashHex}`);
    }
    onProgress({ phase: 'done', generation, hash: hashHex });
    return { generation, hash: hashHex, transformGeneration: s.transform_generation };
  }

  /** Read the active blob back through the windowed read attribute. */
  let readTail=Promise.resolve();
  function readLayout(opts={}) {
    const operation=readTail.then(()=>readLayoutTransaction(opts));
    readTail=operation.catch(()=>{});return operation;
  }
  async function readLayoutTransaction({ onProgress = () => {} } = {}) {
    const before=await readStatus();
    const out = new Uint8Array(LAYOUT_BYTES);
    const total = Math.ceil(LAYOUT_BYTES / CHUNK_BYTES);
    /* A window is fresh only when its converter-side seq differs from the one
     * last seen: the state topic re-carries the previous window with every
     * cached republish. Inequality, not ordering — the converter's counter
     * restarts with Zigbee2MQTT while the cached state keeps the old value. */
    let lastSeq = state.config_read_window ? state.config_read_window.seq ?? null : null;
    for (let i = 0, off = 0; off < LAYOUT_BYTES; i++, off += CHUNK_BYTES) {
      set({ config_read_offset: off });
      get('config_read_window');
      const s = await waitFor((st) => st.config_read_window && st.config_read_window.offset === off
        && (st.config_read_window.seq ?? null) !== lastSeq, `read window ${off}`);
      lastSeq = s.config_read_window.seq ?? null;
      const bytes = unhex(s.config_read_window.bytes);
      const n = Math.min(CHUNK_BYTES, LAYOUT_BYTES - off);
      if (bytes.length < n) throw new Error(`read window ${off}: ${bytes.length} bytes`);
      out.set(bytes.subarray(0, n), off);
      onProgress({ phase: 'read', index: i + 1, total });
    }
    const after=await readStatus();
    if(before.boot_session!==after.boot_session || before.transform_generation!==after.transform_generation || before.config_generation!==after.config_generation || before.config_hash!==after.config_hash
      || new DataView(out.buffer).getUint32(4,true)!==after.config_generation
      || (layoutHash(out)>>>0).toString(16).padStart(8,'0')!==after.config_hash)throw new Error('Layout changed during read-back');
    return out;
  }

  /** Write then read back; resolves only when the bytes match. */
  async function writeAndVerify(blob, opts) {
    const result = await writeLayout(blob, opts);
    const back = await readLayout(opts);
    for (let i = 0; i < LAYOUT_BYTES; i++) {
      if (back[i] !== blob[i]) throw new Error(`read-back differs at byte ${i}`);
    }
    return { ...result, readBackIdentical: true };
  }

  function setLiveView(on) { set({ live_view: on ? 'ON' : 'OFF' }); }
  function onLiveFrame(cb) { frameListeners.add(cb); return () => frameListeners.delete(cb); }
  function onState(cb) { stateListeners.add(cb); return () => stateListeners.delete(cb); }
  function currentState() { return { ...state }; }

  return { readStatus, readSupply, calibrateSupply, armSupplyClear, clearSupplyHistory, writeLayout, readLayout, writeAndVerify, setLiveView, onLiveFrame, onState, currentState,
    topics: { setTopic, getTopic, stateTopic } };
}

/**
 * Classify one decoded live-frame slot for drawing (contract §3 layers).
 * `frozenThresholdFrames` is a display parameter: the measured floor from the
 * living-room capture is 15 identical frames for a quiet seated person, so a
 * threshold well above that is required (default 50 ≈ 4.5 s).
 */
export function classifySlot(slot, { frozenThresholdFrames = 50 } = {}) {
  if (!slot || !slot.valid) return 'absent';
  if (slot.observation_state === 'unchanged' && slot.unchanged_frames >= frozenThresholdFrames) return 'frozen';
  if (slot.spatial_reason && slot.spatial_reason !== 'normal') return 'rejected';
  if (slot.ghost) return 'ghost';
  if (slot.track_present && slot.track_state === 'coasting') return 'coasting';
  if (slot.track_present && slot.supported_this_frame) return 'supported';
  if (slot.track_present) return 'candidate';
  return 'raw';
}
