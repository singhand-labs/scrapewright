// extension/lib/session-tools.js
//
// The session tool bag (spec §2) + toolSpecs + the DSL-contract system
// prompt base (spec §3C prompt diet: DSL contract + a few methodology
// meta-rules; the accumulated rule corpus lives in the knowledge units and
// is pulled on demand — never injected wholesale).
//
// Probes are lib/probe-tools.js instances over the rail's executeDsl with a
// LATE-BOUND observation log: the engine owns the real log (created inside
// createResearchSession), so bindEngine(session) connects it after engine
// construction.
//
// IIFE-wrapped per RC30. No site tokens.

(function (global) {

  function resolveLib(requirePath, globalName) {
    if (typeof require !== 'undefined') {
      try { return require(requirePath); } catch (e) { /* fall through */ }
    }
    return (typeof global !== 'undefined' && global[globalName]) || null;
  }

  function resolveWU() {
    const m = resolveLib('./wizard-utils', '__wizardUtilsModuleMarker__');
    if (m && typeof m.validateChain === 'function') return m;
    const w = (typeof window !== 'undefined' && window) || global || self;
    return {
      validateChain: w.validateChain,
      summarizeAllStepDiagnostics: w.summarizeAllStepDiagnostics,
      summarizeExecutionDiagnostics: w.summarizeExecutionDiagnostics
    };
  }

  const ProbeTools = resolveLib('./probe-tools', 'ProbeTools');

  const DEFAULT_DIAG_CAP = 4000;

  function cap(s, n) {
    const t = String(s == null ? '' : s);
    if (t.length <= n) return t;
    return Array.from(t).slice(0, Math.max(0, n - 1)).join('') + '…';
  }

  function previewJson(p) {
    try { return JSON.parse(String(p)); } catch (e) { return null; }
  }

  function popoverDigest(events) {
    const reasons = {};
    let total = 0;
    let observed = 0;
    for (const evt of events) {
      if (!evt || evt.type !== 'STEP_ITERATION') continue;
      const p = previewJson(evt.resultPreview);
      if (p && typeof p.observedPopoverCount === 'number') observed += p.observedPopoverCount;
      const fr = p && typeof p === 'object' ? p.failureReasons : null;
      if (!fr) continue;
      for (const k of Object.keys(fr)) {
        reasons[k] = (reasons[k] || 0) + fr[k];
        total += fr[k];
      }
    }
    if (!total) return { note: 'no hover failure reasons recorded in this verify run' };
    return {
      failureReasons: reasons,
      totalFailures: total,
      observedPopoverCards: observed,
      hint: 'observedPopoverCards>0 means popovers MOUNTED but popoverSel missed them — rewrite popoverSel from the observed structure instead of re-guessing (knowledge unit: popover-selector-from-evidence)'
    };
  }

  function counterTrajectory(events) {
    const byStep = new Map();
    for (const evt of events) {
      if (!evt || evt.type !== 'STEP_ITERATION') continue;
      if (!byStep.has(evt.stepId)) byStep.set(evt.stepId, []);
      byStep.get(evt.stepId).push(evt);
    }
    const out = [];
    for (const stepId of Array.from(byStep.keys())) {
      const evts = byStep.get(stepId);
      const previews = evts.slice(0, 2).concat(evts.length > 4 ? evts.slice(-2) : []).map((e) => cap(e.resultPreview, 160));
      out.push({ stepId: stepId, iterations: evts.length, firstAndLastPreviews: previews });
    }
    return out;
  }

  function buildDslContractPrompt() {
    return [
      '# Service model',
      'A service is a step graph: steps[{id,name,script,onSuccess,onFailure,maxIterations?}].',
      'onSuccess/onFailure point at another step id or "TERMINATE". A step with maxIterations>1 is a poll/retry loop: return {done:false} to retry the same step, {done:true} or plain data to advance via onSuccess, {failed:true} or {error:"..."} to follow onFailure.',
      'Step scripts are async JavaScript (the script body is placed after `return` semantics — write an expression or an async IIFE). Globals: __input__ (run input object), __stepResults__ (prior results by step id), __lastResult__.',
      '',
      '# $ API',
      '- $(sel) — first matching element data',
      '- $count(sel) → number; $list(sel) → elements; $exists(sel, timeoutMs?) → boolean',
      '- $extract(sel, attr?) — first match; attr may be "outerHTML" or any attribute name',
      '- $extractList(containerSel, fieldMap, opts?) — one record per container; fieldMap {field:{selector,attr?}}; opts.allowEmpty keeps empty-string fields (return every record, never filter to [])',
      '- $extractListMulti(containerSel, fieldMap, opts?) — array-valued fields',
      '- $extractWithHover(containerSel, fieldMap, {hover:{anchorSel, popoverSel?}}) — hover-enriched extraction; anchorSel is evaluated INSIDE each container',
      '- $hover(anchorSel, popoverSel?, opts?) — one-off trusted hover (opts.index picks the Nth anchor); for hover-enriched record extraction prefer $extractWithHover',
      '- $waitForStable(sel, opts?) — resolves true once the element\'s sampled content stops changing (streaming content); prefer over setTimeout guessing',
      '- $click(sel), $type(sel, text), $wait(sel, ms?), $check(sel, prop)',
      '- $clickInList(containerSel, subSel) — click inside every matched container',
      '- $scrollBy(px), $scrollToBottom(), $scrollIntoView(sel)',
      '- $openTab(url, fn) — open a sub-tab, run fn in it, return its result',
      'Selectors are STANDARD CSS only (:has/:not/:is/:where are valid; :has-text/:contains/:text= are NOT and throw instantly).',
      'Selectors may target iframes with the prefix <iframe-css>|<inner-css> (outer selects the iframe element, inner is evaluated inside its document) — works in every $ API.',
      '',
      '# Methodology meta-rules',
      '1. Ground every selector and attribute filter in an observation (probe or user annotation) BEFORE service.update — ungrounded writes are rejected with the missing receipt named.',
      '2. Prefer the cheapest probe that answers the current question; never ask for raw pages.',
      '3. Attribute DISTRIBUTIONS (probe.attrStats), not single samples, reveal what a data-* attribute means (attr is read on every element containerSel matches — the elements themselves, not their descendants).',
      '4. After any container/filter fix, propagate it to every step sharing that selector.',
      '5. When verify.run fails, read diag.read BEFORE changing anything.',
      '6. To observe a hover popover during research call probe.hover (a session tool — do NOT call the $hover DSL primitive as a tool); it returns the popover evidence (observedPopover identity + htmlSnippet). Learn the real popoverSel from that evidence BEFORE writing $extractWithHover into steps.'
    ].join('\n');
  }

  function createSessionTools(deps) {
    const d = deps || {};
    if (!d.rail || typeof d.rail.executeDsl !== 'function') throw new Error('createSessionTools requires a rail (live-rail instance)');
    if (typeof d.runVerify !== 'function') throw new Error('createSessionTools requires a runVerify (verify-runner instance)');
    for (const k of ['getDraftService', 'applyArtifact', 'getTestInput', 'getOutputSchema', 'getSteps']) {
      if (typeof d[k] !== 'function') throw new Error('createSessionTools requires a ' + k + '() function');
    }
    const WU = resolveWU();
    const probeFactory = typeof d.probeFactory === 'function' ? d.probeFactory : (ProbeTools && ProbeTools.createProbeTools);
    if (!probeFactory) throw new Error('probe-tools lib required (load lib/probe-tools.js before session-tools.js)');
    const diagCap = typeof d.diagCapChars === 'number' && d.diagCapChars > 0 ? d.diagCapChars : DEFAULT_DIAG_CAP;

    // Late-bound engine surfaces (connected by bindEngine after the engine
    // exists — the engine creates the observation log internally).
    let engineLog = null;
    const lateBoundLog = { record: (obs) => { if (engineLog) engineLog.record(obs); } };
    const probes = probeFactory({ executeDsl: d.rail.executeDsl, observationLog: lateBoundLog });

    let lastVerify = null;

    async function verifyRun(args) {
      const service = d.getDraftService();
      if (!service || !Array.isArray(service.steps) || !service.steps.length) {
        return { error: 'no artifact yet — author the step graph and call service.update first' };
      }
      const a = args && typeof args === 'object' ? args : {};
      const input = (a.input && typeof a.input === 'object' && !Array.isArray(a.input)) ? a.input : d.getTestInput();
      const out = await d.runVerify({ service: service, input: input, outputSchema: d.getOutputSchema() });
      lastVerify = { events: out.events || [], report: out.report, raw: out.raw, at: Date.now() };
      return out.report;
    }

    async function diagRead(args) {
      if (!lastVerify) return { error: 'no verify run yet in this session — run verify.run first' };
      const a = args && typeof args === 'object' ? args : {};
      const kind = typeof a.kind === 'string' && a.kind ? a.kind : 'all';
      const all = lastVerify.events || [];
      const events = a.stepId != null ? all.filter((e) => e && String(e.stepId) === String(a.stepId)) : all;
      const out = { at: lastVerify.at, eventCount: all.length };
      if (lastVerify.staleArtifact) {
        out.warning = 'this diagnostics snapshot predates the current artifact — run verify.run again before trusting it for the new version';
      }
      if (lastVerify.report && lastVerify.report.error) out.lastError = lastVerify.report.error;
      if (kind === 'all' || kind === 'selectorDiagnostics') {
        out.selectorDiagnostics = cap(WU.summarizeAllStepDiagnostics(all, d.getSteps() || []), diagCap);
      }
      if ((kind === 'all' || kind === 'failingStep') && lastVerify.report && lastVerify.report.error && lastVerify.report.error.stepId) {
        out.failingStep = cap(WU.summarizeExecutionDiagnostics(all, String(lastVerify.report.error.stepId)), diagCap);
      }
      if (kind === 'all' || kind === 'popover') out.popover = popoverDigest(events);
      if (kind === 'all' || kind === 'counters') out.counters = counterTrajectory(events);
      return out;
    }

    async function annotateRequest(args, ctx) {
      const a = args && typeof args === 'object' ? args : {};
      const bridge = d.annotationBridge;
      if (!bridge || typeof bridge.request !== 'function') {
        return { error: 'annotation bridge not wired in this host' };
      }
      const res = await bridge.request({
        why: typeof a.why === 'string' ? a.why : '',
        fields: Array.isArray(a.fields) ? a.fields.filter((f) => typeof f === 'string') : [],
        containerSel: typeof a.containerSel === 'string' ? a.containerSel : '',
        hint: typeof a.hint === 'string' ? a.hint : ''
      });
      if (!res || res.cancelled) {
        return { cancelled: true, note: 'user cancelled annotation — try a probe (probe.sample / probe.attrStats) instead' };
      }
      const picks = Array.isArray(res.annotations) ? res.annotations.filter((p) => p && typeof p === 'object') : [];
      const ledger = (ctx && ctx.ledger) || null;
      try {
        for (const p of picks) {
          if (typeof p.selector !== 'string' || !p.selector) continue;
          if (ledger) {
            ledger.add({
              finding: 'user annotation: ' + (p.purpose || p.type || 'element') +
                (typeof p.outputField === 'string' && p.outputField ? ' → ' + p.outputField : ''),
              evidence: a.why || 'annotate.request',
              confidence: 'high',
              provenance: 'user',
              selectors: [p.selector]
            });
          }
        }
      } catch (e) { /* ledger failure is secondary — the user's picks still count */ }
      return {
        annotations: picks.map((p) => ({
          selector: String(p.selector || ''),
          purpose: String(p.purpose || p.type || ''),
          outputField: String(p.outputField || ''),
          inputField: String(p.inputField || ''),
          waitCondition: String(p.waitCondition || '')
        })).filter((p) => p.selector),
        url: typeof res.url === 'string' ? res.url : ''
      };
    }

    async function serviceUpdate(args, ctx) {
      const a = args && typeof args === 'object' ? args : {};
      const steps = Array.isArray(a.steps) ? a.steps : [];
      const chain = WU.validateChain(steps);
      if (!chain || chain.valid !== true) {
        return { error: 'step chain invalid: ' + String((chain && chain.error) || 'validation failed') };
      }
      try {
        d.applyArtifact(a);
        if (lastVerify) lastVerify.staleArtifact = true;
      } catch (e) {
        return { error: 'artifact apply failed: ' + String((e && e.message) || e) };
      }
      const st = ctx && ctx.session ? ctx.session.state() : null;
      const version = (st && st.session && Array.isArray(st.session.artifactVersions))
        ? st.session.artifactVersions.length + 1
        : 1;
      return { updated: true, version: version };
    }

    const tools = {
      'page.open': d.rail.pageOpen,
      'page.state': d.rail.pageState,
      'probe.count': probes.count,
      'probe.text': probes.text,
      'probe.attrStats': probes.attrStats,
      'probe.sample': probes.sample,
      'probe.hover': probes.hover,
      'diag.read': diagRead,
      'verify.run': verifyRun,
      'annotate.request': annotateRequest,
      'service.update': serviceUpdate
    };

    const toolSpecs = [
      { name: 'page.open', args: '{url?}', returns: '{tabId,url,ready,warning?}' },
      { name: 'page.state', args: '{}', returns: '{open,tabId,url,title,status}' },
      { name: 'probe.count', args: '{sel}', returns: '{count}' },
      { name: 'probe.text', args: '{sel}', returns: '{total,items[]}' },
      { name: 'probe.attrStats', args: '{containerSel, attr}', returns: '{totalCards,values[{value,cards,pct}],absentPct}' },
      { name: 'probe.sample', args: '{sel, opts:{index,wantHtml}}', returns: '{match,total,element,html?}' },
      { name: 'probe.hover', args: '{anchorSel, popoverSel?, opts:{index,timeoutMs}}', returns: '{hovered,htmlSnippet,popoverSelector,reason,observedPopover?}' },
      { name: 'diag.read', args: '{stepId?, kind?}', returns: '{selectorDiagnostics, failingStep?, popover, counters, lastError?}' },
      { name: 'verify.run', args: '{input?}', returns: '{ok,score,error,detectors,steps,finalResult,schemaOk}' },
      { name: 'annotate.request', args: '{why, fields?, containerSel?}', returns: '{annotations[{selector,purpose,outputField}]} | {cancelled}' }
    ];

    return {
      tools: tools,
      toolSpecs: toolSpecs,
      systemPromptBase: buildDslContractPrompt(),
      bindEngine: function (session) {
        if (session && session.observationLog) engineLog = session.observationLog;
      },
      getLastVerify: function () { return lastVerify; }
    };
  }

  const api = { createSessionTools, buildDslContractPrompt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.SessionTools = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
