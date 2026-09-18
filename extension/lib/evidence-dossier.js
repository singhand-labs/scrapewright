// extension/lib/evidence-dossier.js
//
// Evidence dossier (2026-09-18 spec §3.B): a compact, AUTHORITATIVE evidence
// block the research-session engine rebuilds and injects EVERY turn — never
// stored in the transcript, so compaction can never eat it. Six sections:
//   [CONTAINER SKELETON]   numbered skeleton of the representative container
//   [POPOVER CAPTURES]     LRU (≤15) of captured popover texts w/ anchors
//   [LAST VERIFY CENSUS]   the most recent verify report's detector census
//   [ARTIFACT LINEAGE]     current version's step scripts IN FULL (user
//                          directive) + old versions as one-liners
//   [STEP PLAN]            per-step grounded/tested status (2026-09-18
//                          graduated-activation spec §3.C — cross-turn memory)
//   [BUDGET]               the dossier's own cost estimate + trim disclosure
//
// Hard cap ~30K chars; overflow trims the OLDEST evidence first and the BUDGET
// section discloses exactly what was trimmed (never silent). Site-independent
// by construction. IIFE-wrapped per RC30.

(function (global) {

  const DOSSIER_CAP_CHARS = 30000;
  const POPOVER_LRU_MAX = 15;
  const POPOVER_TEXT_HEAD = 200;
  const LINEAGE_SCRIPTS_MAX = 3;      // versions whose FULL scripts ride the dossier
  const LINEAGE_SCRIPTS_CHARS = 12000; // budget for the current version's full scripts
  const PROMPT_WINDOW_TOKENS = 128000; // user directive: design the input window for 128K

  function resolveDomCleaner() {
    if (typeof require !== 'undefined') {
      try { return require('./dom-cleaner'); } catch (e) { /* fall through */ }
    }
    return (typeof global !== 'undefined' && global.DomCleaner) || null;
  }

  // LRU push for popover captures. `list` is the caller-owned array (the
  // session-tools accumulator); entries {anchor, text, turn?}. Newest last,
  // oldest evicted at POPOVER_LRU_MAX — eviction is the accumulator's business;
  // buildDossier discloses the evicted count via list.evicted.
  function pushPopoverCapture(list, entry) {
    if (!Array.isArray(list)) list = [];
    if (list.evicted == null) list.evicted = 0;
    const text = String((entry && entry.text) || '').replace(/\s+/g, ' ').trim();
    if (!text) return list;
    const anchor = String((entry && entry.anchor) || '').slice(0, 120);
    // dedupe: same anchor+text already captured → refresh position (move to end)
    const i = list.findIndex(e => e.anchor === anchor && e.text === text.slice(0, POPOVER_TEXT_HEAD));
    if (i !== -1) list.splice(i, 1);
    list.push({ anchor: anchor, text: text.slice(0, POPOVER_TEXT_HEAD) });
    while (list.length > POPOVER_LRU_MAX) { list.shift(); list.evicted += 1; }
    return list;
  }

  function formatStepScript(step, idx) {
    const id = String((step && step.id) || ('step' + (idx + 1)));
    const name = step && step.name ? String(step.name).slice(0, 80) : '';
    const script = String((step && step.script) || '').trim() || '// (empty)';
    return '--- step ' + id + (name ? ' (' + name + ')' : '') + ' ---\n' + script;
  }

  function buildDossier(input) {
    const a = input || {};
    const trims = [];

    // [CONTAINER SKELETON] — built at dossier time from the stashed raw HTML
    // so a skeletonView improvement lands without re-probing.
    let skeleton = '';
    if (a.containerHtml) {
      const dc = resolveDomCleaner();
      if (dc && typeof dc.skeletonView === 'function') {
        skeleton = dc.skeletonView(a.containerHtml, { capChars: 8000 });
      } else {
        skeleton = String(a.containerHtml).slice(0, 8000);
        trims.push('container skeleton degraded (no skeletonView) — raw slice');
      }
    }

    // [POPOVER CAPTURES] — newest last; overflow trimming drops OLDEST first.
    let popovers = Array.isArray(a.popovers) ? a.popovers.slice() : [];
    let popoverTrimmed = 0;

    // [LAST VERIFY CENSUS]
    let census = '';
    const lv = a.lastVerify;
    if (lv && typeof lv === 'object') {
      try {
        const keys = ['ok', 'error', 'score', 'schemaOk'];
        const head = keys.filter(k => lv[k] !== undefined).map(k => k + '=' + JSON.stringify(lv[k])).join(' ');
        const detectors = (lv.detectors && typeof lv.detectors === 'object') ? JSON.stringify(lv.detectors) : '';
        census = (head ? head + '\n' : '') + (detectors ? 'detectors: ' + detectors : '');
      } catch (e) { census = ''; }
      if (census.length > 6000) { trims.push('last-verify census trimmed ' + (census.length - 6000) + ' chars'); census = census.slice(0, 6000); }
    }

    // [ARTIFACT LINEAGE] — current version's scripts IN FULL (user directive:
    // the model must see its own last script text, not a summary), old
    // versions one line each. Keep at most LINEAGE_SCRIPTS_MAX full versions
    // in the engine bookkeeping; older ones were never kept.
    const versions = Array.isArray(a.artifactVersions) ? a.artifactVersions : [];
    let lineageLines = [];
    const current = versions[versions.length - 1] || null;
    for (const v of versions) {
      if (v !== current) {
        const n = (v.steps || []).length;
        const ids = (v.steps || []).map(s => s && s.id).filter(Boolean).join('→');
        lineageLines.push('v' + v.version + ' (' + n + ' steps: ' + (ids || '?') + ')');
      }
    }
    let currentScripts = '';
    if (current) {
      currentScripts = (current.steps || []).map(formatStepScript).join('\n\n');
      if (currentScripts.length > LINEAGE_SCRIPTS_CHARS) {
        trims.push('current-version scripts trimmed ' + (currentScripts.length - LINEAGE_SCRIPTS_CHARS) + ' chars (raise the dossier cap if this recurs)');
        currentScripts = currentScripts.slice(0, LINEAGE_SCRIPTS_CHARS);
      }
    }

    // [STEP PLAN] (spec §3.C): one line per step of the CURRENT artifact —
    // status planned|grounded|tested|failed with the last-transition note.
    // The fixed teaching line closes the section. Empty/absent plan (pre-
    // artifact sessions) renders nothing.
    let stepPlanText = '';
    if (Array.isArray(a.stepPlan) && a.stepPlan.length) {
      const lines = a.stepPlan.slice(0, 20).map((e) => {
        const id = String((e && e.stepId) || '?');
        const name = (e && e.name) ? ' (' + String(e.name).slice(0, 60) + ')' : '';
        const status = String((e && e.status) || 'planned');
        const note = (e && e.note) ? ' — ' + String(e.note).slice(0, 80) : '';
        return '- ' + id + name + ': ' + status + note;
      });
      stepPlanText = '[STEP PLAN]\n' + lines.join('\n') +
        '\nresearch the FIRST non-grounded step; re-probe grounded steps only when their selector family fails in verify';
    }

    function assemble(popCount, skel, cens, scripts) {
      const parts = ['<EVIDENCE DOSSIER (authoritative, rebuilt each turn)>'];
      parts.push('[CONTAINER SKELETON]\n' + (skel || '(no representative container captured yet — probe.sample wantHtml or probe.skeleton to capture one)'));
      const ps = popovers.slice(0, popCount).map((p, i) =>
        '- #' + (i + 1) + ' anchor=' + JSON.stringify(p.anchor) + ' text=' + JSON.stringify(p.text)).join('\n');
      parts.push('[POPOVER CAPTURES] (' + popCount + (popoverTrimmed ? ', ' + popoverTrimmed + ' oldest trimmed for budget' : '') + ')\n' +
        (ps || '(none captured yet — hover-bearing probes feed this automatically)'));
      parts.push('[LAST VERIFY CENSUS]\n' + (cens || '(no verify run yet)'));
      parts.push('[ARTIFACT LINEAGE] current: ' + (current ? 'v' + current.version : '(none)') +
        (lineageLines.length ? '\nolder: ' + lineageLines.join(' | ') : '') +
        (scripts ? '\nCURRENT STEPS (full scripts):\n' + scripts : ''));
      if (stepPlanText) parts.push(stepPlanText);
      return parts;
    }

    // Trim loop: oldest popover first, then skeleton tail, then scripts tail.
    // body() = all five content sections (budget rides separately).
    const body = () => assemble(popCount, skeleton, census, currentScripts).join('\n\n');
    let popCount = popovers.length;
    while (body().length + 64 > DOSSIER_CAP_CHARS && popCount > 0) {
      popCount -= 1;
      popoverTrimmed += 1;
    }
    let over = body().length + 64 - DOSSIER_CAP_CHARS;
    if (over > 0 && skeleton) {
      const cut = Math.min(skeleton.length, over);
      skeleton = skeleton.slice(0, Math.max(0, skeleton.length - cut));
      trims.push('container skeleton tail trimmed ' + cut + ' chars');
    }
    over = body().length + 64 - DOSSIER_CAP_CHARS;
    if (over > 0 && currentScripts) {
      const cut = Math.min(currentScripts.length, over);
      currentScripts = currentScripts.slice(0, Math.max(0, currentScripts.length - cut));
      trims.push('current scripts tail trimmed ' + cut + ' chars');
    }

    const promptChars = (typeof a.promptCharsEstimate === 'number') ? a.promptCharsEstimate : null;
    const warn = (promptChars != null && promptChars / 4 > PROMPT_WINDOW_TOKENS)
      ? '\nWARNING: assembled prompt estimate ~' + Math.round(promptChars / 4) + ' tokens exceeds the ' + PROMPT_WINDOW_TOKENS + '-token window design — compact evidence (smaller test input, fewer probed pages) before the next call.'
      : '';
    const core = body();
    const budget = '[BUDGET] dossier ~' + (core.length + 64) + ' chars (~' + Math.ceil((core.length + 64) / 4) + ' tokens of the ' + Math.ceil(DOSSIER_CAP_CHARS / 4) + '-token dossier budget)' +
      (trims.length ? '\ntrimmed: ' + trims.join('; ') : '') +
      (a.evictedPopovers ? '; ' + a.evictedPopovers + ' popover capture(s) evicted by the LRU before this build' : '') + warn;

    return core + '\n\n' + budget + '\n</EVIDENCE DOSSIER>';
  }

  const api = { buildDossier, pushPopoverCapture, DOSSIER_CAP_CHARS, POPOVER_LRU_MAX, POPOVER_TEXT_HEAD, PROMPT_WINDOW_TOKENS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.EvidenceDossier = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
