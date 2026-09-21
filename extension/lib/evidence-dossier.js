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
  const CENSUS_CAP_CHARS = 2500;      // purpose-built verify census budget (89th-round T2)

  // Purpose-built [LAST VERIFY CENSUS] renderer (89th-round audit): the raw
  // JSON.stringify head-slice cut mid-JSON behind prose detectors, hiding the
  // rows the model acts on. Unwrap-tolerant: accepts the REPORT shape and the
  // production {events, report, raw, at} wrapper (the shape-mismatch class
  // struck three times — never trust one shape again). Overflow drops row
  // families tail-first; the ok/error line is never dropped.
  function renderVerifyCensus(reportOrWrapper) {
    if (!reportOrWrapper || typeof reportOrWrapper !== 'object') return '';
    const r = (reportOrWrapper.report && typeof reportOrWrapper.report === 'object')
      ? reportOrWrapper.report : reportOrWrapper;
    try {
      const out = [];
      const scoreNum = r.score && typeof r.score.score === 'number'
        ? Math.round(r.score.score * 10) / 10 : (typeof r.score === 'number' ? r.score : '?');
      out.push('ok=' + String(r.ok) + (r.executedArtifactVersion !== undefined ? ' v' + r.executedArtifactVersion : '') +
        ' score=' + scoreNum + (r.schemaOk !== undefined ? ' schemaOk=' + r.schemaOk : ''));
      if (r.error && r.error.message) {
        out.push('ERROR: ' + String(r.error.message).slice(0, 200) + (r.error.stepId ? ' (step: ' + r.error.stepId + ')' : ''));
      }
      const d = (r.detectors && typeof r.detectors === 'object') ? r.detectors : {};
      const rel = Array.isArray(d.relativeTimestamps) ? d.relativeTimestamps : [];
      for (const row of rel) {
        if (!row) continue;
        out.push('time ' + String(row.path || row.field) + ': ' +
          (row.relativeCount || 0) + ' relative + ' + (row.partialAbsoluteCount || 0) +
          ' partial' + (row.sampleValue ? ' (sample "' + String(row.sampleValue).slice(0, 40) + '")' : '') +
          ' of ' + (row.totalRecords || '?'));
      }
      const pe = Array.isArray(d.partialEmptyFields) ? d.partialEmptyFields : [];
      for (const row of pe) {
        if (!row) continue;
        let hint = '';
        if (Array.isArray(row.emptyRecordSamples) && row.emptyRecordSamples.length) {
          const s = row.emptyRecordSamples[0];
          hint = ' (e.g. #' + (s.index || (s.parentIndex + '.' + s.subIndex)) + ' "' + String(s.hint || '').slice(0, 30) + '")';
        }
        out.push('empty ' + String(row.path || row.field) + ' ' + (row.emptyCount || 0) + '/' + (row.totalCount || '?') + hint);
      }
      const tsx = Array.isArray(d.timeSourceUnexercised) ? d.timeSourceUnexercised : [];
      for (const row of tsx) {
        if (!row) continue;
        out.push('time-source-unexercised ' + String(row.path || row.field) +
          (row.tier ? ' [' + row.tier + ']' : '') + ' (sample "' + String(row.sampleValue || '').slice(0, 30) + '")');
      }
      const dup = Array.isArray(d.duplicateIdValues) ? d.duplicateIdValues : [];
      for (const row of dup) {
        if (!row) continue;
        out.push('dup-id ' + String(row.path) + ' ' + (row.count || 0) + '/' + (row.totalRecords || '?') +
          ' on records ' + (Array.isArray(row.indices) ? row.indices.join(', ') : '?'));
      }
      const entp = Array.isArray(d.duplicateEntityPairs) ? d.duplicateEntityPairs : [];
      for (const row of entp) {
        if (!row) continue;
        out.push('dup-entity #' + (row.indexA || '?') + '≡#' + (row.indexB || '?') +
          ' match ' + (Array.isArray(row.matchedFields) ? row.matchedFields.join('+') : '?') +
          (row.idSurface ? ' id-surface differs: ' + row.idSurface.field : ''));
      }
      if (d.countShortfall) out.push('count-shortfall: ' + String(d.countShortfall).slice(0, 120));
      const uc = d.unusedCaptures;
      if (uc && typeof uc === 'object') {
        out.push('unused-captures: ' + (uc.totalCaptured || 0) + ' popovers captured, ' +
          (uc.popoverReadFields || 0) + ' fields consume' +
          (Array.isArray(uc.samples) && uc.samples.length ? ' (sample "' + String(uc.samples[0]).slice(0, 40) + '")' : ''));
      }
      let txt = out.join('\n');
      if (txt.length > CENSUS_CAP_CHARS) {
        const lines = out;
        while (lines.length > 2 && (lines.slice(0, 2).join('\n') + '\n…[+' + (lines.length - 2) + ' census rows elided]').length > CENSUS_CAP_CHARS) {
          lines.splice(2, 1); // drop the OLDEST row family entry, keep ok/error
        }
        lines.splice(2, 0, '…[' + 'census rows trimmed to fit ' + CENSUS_CAP_CHARS + ']');
        txt = lines.join('\n');
        if (txt.length > CENSUS_CAP_CHARS) txt = txt.slice(0, CENSUS_CAP_CHARS);
      }
      return txt;
    } catch (e) { return ''; }
  }

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

    // [CAPTURE ROUTES] (112th log): evidence-route bookkeeping — which
    // anchor→payload routes are PROVEN this session (with samples) and which
    // keep failing. The policy line enforces page-op frugality: parsing and
    // binding problems are solved from captured evidence, not by re-
    // triggering proven page operations.
    let routesText = '';
    if (Array.isArray(a.captureRoutes) && a.captureRoutes.length) {
      const rl = a.captureRoutes.slice(0, 8).map((e) => {
        const an = JSON.stringify(String((e && e.anchor) || '?').slice(0, 60));
        if (e && e.proofs > 0) {
          return '- anchor ' + an + ': PROVEN ×' + e.proofs +
            ((e.samples && e.samples.length) ? ' (sample ' + JSON.stringify(String(e.samples[0]).slice(0, 40)) + ')' : '');
        }
        return '- anchor ' + an + ': ' + ((e && e.attempts) || 0) + ' attempt(s), NO capture';
      });
      routesText = '[CAPTURE ROUTES]\n' + rl.join('\n') +
        '\npage-op frugality: a PROVEN route\'s payload is already captured (this block / [POPOVER CAPTURES]) — solve parsing/binding problems from the captured evidence or probe.snippet, NOT by re-triggering page hovers; page ops are for not-yet-proven routes and verify. A route with ≥3 attempts and NO capture: ask the user (user.observe / annotate.request) instead of another identical dispatch.';
    }

    // [LAST VERIFY CENSUS] — purpose-built renderer (89th-round plan T2):
    // deterministic rows for the decision-critical detectors. The old raw
    // JSON.stringify head-slice cut mid-JSON behind prose detectors, hiding
    // exactly the rows the model acts on (relativeTimestamps sampleValue,
    // partialEmptyFields emptyRecordSamples, dup ids, unused captures).
    let census = '';
    if (a.lastVerify && typeof a.lastVerify === 'object') {
      census = renderVerifyCensus(a.lastVerify);
      if (census.length > CENSUS_CAP_CHARS) { trims.push('last-verify census trimmed ' + (census.length - CENSUS_CAP_CHARS) + ' chars'); census = census.slice(0, CENSUS_CAP_CHARS); }
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
        const turn = (e && typeof e.sinceTurn === 'number') ? ' @turn ' + e.sinceTurn : '';
        return '- ' + id + name + ': ' + status + note + turn;
      });
      // 89th-round T5: the unconditional "research the FIRST non-grounded
      // step" line misled when every step had executed and the failure was
      // FIELD-level (red verify, no error.stepId) — redirect to the census.
      const hasUngrounded = a.stepPlan.some((e) => e && e.status === 'planned');
      const teaching = hasUngrounded
        ? 'research the FIRST non-grounded step; re-probe grounded steps only when their selector family fails in verify'
        : 'all steps executed — the failing layer is FIELD-level: read [LAST VERIFY CENSUS] rows and re-probe the named records/fields';
      stepPlanText = '[STEP PLAN]\n' + lines.join('\n') + '\n' + teaching;
    }

    function assemble(popCount, skel, cens, scripts) {
      const parts = ['<EVIDENCE DOSSIER (authoritative, rebuilt each turn)>'];
      // 89th-round D5: disclose skeleton staleness — captured before a
      // page.open/verify.run it may describe a page the model no longer sees.
      let staleNote = '';
      if (skel && a.containerHtmlMeta && typeof a.containerHtmlMeta === 'object') {
        const meta = a.containerHtmlMeta;
        if (meta.staleBy) {
          const ageS = typeof meta.at === 'number' ? Math.max(0, Math.round((Date.now() - meta.at) / 1000)) : '?';
          staleNote = '\n(STALE — captured ' + ageS + 's ago; a ' + meta.staleBy + ' has run since)';
        }
      }
      parts.push('[CONTAINER SKELETON]\n' + (skel || '(no representative container captured yet — probe.sample wantHtml or probe.skeleton to capture one)') + staleNote);
      const ps = popovers.slice(0, popCount).map((p, i) =>
        '- #' + (i + 1) + ' anchor=' + JSON.stringify(p.anchor) + ' text=' + JSON.stringify(p.text)).join('\n');
      parts.push('[POPOVER CAPTURES] (' + popCount + (popoverTrimmed ? ', ' + popoverTrimmed + ' oldest trimmed for budget' : '') + ')\n' +
        (ps || '(none captured yet — hover-bearing probes feed this automatically)'));
      if (routesText) parts.push(routesText);
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

  const api = { buildDossier, pushPopoverCapture, renderVerifyCensus, DOSSIER_CAP_CHARS, POPOVER_LRU_MAX, POPOVER_TEXT_HEAD, PROMPT_WINDOW_TOKENS, CENSUS_CAP_CHARS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.EvidenceDossier = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
