/*
 * mqtt_ws.js — minimal MQTT 3.1.1 over WebSocket (publish/subscribe, QoS 0).
 *
 * Dependency-free browser client, just enough to provision the device from the
 * configurator. The HA Mosquitto add-on exposes MQTT-over-WebSocket on port
 * 1884 (subprotocol "mqtt"). Not a general MQTT library — no reconnect, no QoS
 * 1/2; fine for a short provisioning burst.
 */

const TE = new TextEncoder();
const TD = new TextDecoder();

function encLen(n) {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; out.push(b); } while (n > 0);
  return out;
}
function encStr(s) {
  const b = TE.encode(s);
  return [(b.length >> 8) & 0xff, b.length & 0xff, ...b];
}
function packet(type, body) {
  return new Uint8Array([type, ...encLen(body.length), ...body]);
}

/**
 * Connect and resolve with a client { publish, subscribe, onMessage, end }.
 * @param {{url:string, username?:string, password?:string, clientId?:string, keepalive?:number}} opts
 */
export function mqttConnect(opts) {
  const { url, username, password, keepalive = 30 } = opts;
  const clientId = opts.clientId || 'rld3-cfg-' + Math.random().toString(16).slice(2, 8);

  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(url, 'mqtt'); } catch (e) { return reject(e); }
    ws.binaryType = 'arraybuffer';

    let buf = new Uint8Array(0);
    let messageHandler = null;
    let pingTimer = null;
    let settled = false;

    const send = (bytes) => ws.send(bytes);

    ws.onopen = () => {
      const flags = 0x02 | (username ? 0x80 : 0) | (password ? 0x40 : 0); // clean session
      const vh = [...encStr('MQTT'), 4, flags, (keepalive >> 8) & 0xff, keepalive & 0xff];
      const pl = [...encStr(clientId)];
      if (username) pl.push(...encStr(username));
      if (password) pl.push(...encStr(password));
      send(packet(0x10, [...vh, ...pl]));
    };
    ws.onerror = () => { if (!settled) { settled = true; reject(new Error('WebSocket error connecting to ' + url)); } };
    ws.onclose = () => { if (pingTimer) clearInterval(pingTimer); };

    ws.onmessage = (ev) => {
      const inc = new Uint8Array(ev.data);
      const merged = new Uint8Array(buf.length + inc.length);
      merged.set(buf); merged.set(inc, buf.length); buf = merged;
      let off = 0;
      while (off + 2 <= buf.length) {
        let mult = 1, len = 0, i = off + 1, b, ok = true;
        do {
          if (i >= buf.length) { ok = false; break; }
          b = buf[i++]; len += (b & 0x7f) * mult; mult *= 128;
        } while (b & 0x80);
        if (!ok || i + len > buf.length) break;     // incomplete packet
        handle(buf[off] >> 4, buf.subarray(i, i + len));
        off = i + len;
      }
      buf = buf.slice(off);
    };

    const api = {
      publish(topic, message) {
        const m = typeof message === 'string' ? TE.encode(message) : message;
        send(packet(0x30, [...encStr(topic), ...m]));
      },
      subscribe(topic) { send(packet(0x82, [0, 1, ...encStr(topic), 0])); },
      onMessage(cb) { messageHandler = cb; },
      end() { try { send(new Uint8Array([0xE0, 0x00])); } catch (_) {} ws.close(); },
    };

    function handle(type, payload) {
      if (type === 2) {                              // CONNACK
        const rc = payload.length >= 2 ? payload[1] : -1;
        settled = true;
        if (rc === 0) {
          pingTimer = setInterval(() => send(new Uint8Array([0xC0, 0x00])), keepalive * 800);
          resolve(api);
        } else {
          const names = { 4: 'bad user/pass', 5: 'not authorized' };
          reject(new Error('CONNACK refused (rc=' + rc + (names[rc] ? ', ' + names[rc] : '') + ')'));
          ws.close();
        }
      } else if (type === 3) {                       // PUBLISH (QoS 0, no packet id)
        const tlen = (payload[0] << 8) | payload[1];
        const topic = TD.decode(payload.subarray(2, 2 + tlen));
        const msg = TD.decode(payload.subarray(2 + tlen));
        if (messageHandler) messageHandler(topic, msg);
      }
      /* SUBACK (9), PINGRESP (13) ignored */
    }
  });
}
