/** Human identity and kind presentation. Spatial IDs are independent of slots. */
export const PALETTE = Object.freeze({room:'#cbd5e1', zone:'#56b4e9', tz:'#e69f00', iz:'#cc79a7', mask:'#009e73', door:'#f0e442', unused:'#6b7280'});
export const FROZEN_FRAMES = 50;
export const CHOICES = Object.freeze({default:[0,'default'],bed:[0,'bed'],chair:[0,'chair'],couch:[0,'couch'],table:[0,'table'],transit_only:[1,'none'],impossible:[2,'none']});
export function kindOf(policy = 0) { return policy === 1 ? 'tz' : policy === 2 ? 'iz' : 'zone'; }
export function defaultName(kind, id) { return `${({zone:'Zone',tz:'TZ',iz:'IZ',door:'Door',mask:'Mask'})[kind]} ${id}`; }
export function validName(name) { return typeof name === 'string' && /^[\x20-\x7e]{1,15}$/.test(name) && name.trim().length > 0; }
export function checkName(name) { if (!validName(name)) throw new Error('Name must be 1–15 printable ASCII characters, not blank'); return name; }
export function nextSpatialId(elements) {
  const used = new Set(elements.filter(Boolean).map(e => e.spatialId));
  for (let id = 1; id <= 255; id++) if (!used.has(id)) return id;
  throw new Error('No spatial IDs left');
}
export function checkSpatialIds(elements) {
  const seen = new Set();
  for (const e of elements.filter(Boolean)) {
    if (!Number.isInteger(e.spatialId) || e.spatialId < 1 || e.spatialId > 255) throw new Error(`${e.name || 'Element'}: repair spatial ID to 1–255 before writing`);
    if (seen.has(e.spatialId)) throw new Error(`${e.name || 'Element'}: duplicate spatial ID ${e.spatialId}`);
    seen.add(e.spatialId);
  }
}
export function choiceFor(policy, style) { return Object.keys(CHOICES).find(k => CHOICES[k][0] === policy && CHOICES[k][1] === style) ?? 'unsupported'; }
