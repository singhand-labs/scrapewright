// extension/lib/knowledge-base.js
//
// Global methodology library operations (spec §3A): the unit INDEX rides the
// system prompt (compact: id + title per unit); bodies pull on demand
// (knowledge.query) or auto-attach when a loop observation matches a unit's
// event signature. Sessions PROPOSE new units through proposeUnit — shape
// validation + universality + id-uniqueness — and the USER approves before
// anything enters lib/knowledge-units.js.
//
// Pure module. IIFE-wrapped per RC30.

(function (global) {

  const FORBIDDEN_TOKENS = /facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i;
  const MIN_BODY_CHARS = 40;

  function buildIndex(units) {
    return (units || [])
      .filter(u => u && typeof u.id === 'string')
      .map(u => ({ id: u.id, title: String(u.title || '').slice(0, 100) }));
  }

  function queryUnits(units, ids) {
    const wanted = new Set(Array.isArray(ids) ? ids.filter(x => typeof x === 'string') : []);
    return (units || []).filter(u => wanted.has(u.id));
  }

  function matchUnits(units, events) {
    const seen = new Set(Array.isArray(events) ? events.filter(x => typeof x === 'string') : []);
    if (seen.size === 0) return [];
    return (units || []).filter(u =>
      Array.isArray(u.matchEvents) && u.matchEvents.some(ev => seen.has(ev))
    );
  }

  function proposeUnit(existingUnits, candidate) {
    const errors = [];
    const u = candidate || {};
    if (!u.id || typeof u.id !== 'string') errors.push('id is required');
    else if ((existingUnits || []).some(x => x.id === u.id)) errors.push('id already exists: ' + u.id);
    if (!u.title || typeof u.title !== 'string') errors.push('title is required');
    if (!u.body || typeof u.body !== 'string' || u.body.trim().length < MIN_BODY_CHARS) {
      errors.push('body must be at least ' + MIN_BODY_CHARS + ' chars of real lesson');
    }
    if (!Array.isArray(u.matchEvents) || u.matchEvents.length === 0) {
      errors.push('matchEvents (signature tags) are required');
    }
    if (!u.origin || typeof u.origin !== 'string') errors.push('origin (incident reference) is required');
    const blob = [u.id, u.title, u.body, (u.matchEvents || []).join(' ')].join(' ');
    if (FORBIDDEN_TOKENS.test(blob)) {
      errors.push('site token in unit — global knowledge must stay site-independent');
    }
    return errors.length === 0
      ? { ok: true, unit: { id: u.id, title: u.title, body: u.body, matchEvents: u.matchEvents, origin: u.origin } }
      : { ok: false, errors: errors };
  }

  const api = { buildIndex, queryUnits, matchUnits, proposeUnit };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.KnowledgeBase = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
