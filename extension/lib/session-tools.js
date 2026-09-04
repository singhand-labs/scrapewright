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

  // Fourth-live-log G1: the LLM kept sending natural-language maps
  // ({"posts":"array of post objects"}) as outputSchema. Verify scoring and
  // every detector read .required/.properties — such maps leave them all
  // blind, so verify.run reports score 0 even after a fully successful
  // extraction. Acceptance = JSON-Schema object shape.
  function isJsonObjectSchema(s) {
    return !!s && typeof s === 'object' && !Array.isArray(s) &&
      (s.type === 'object' ||
        (s.properties && typeof s.properties === 'object' && !Array.isArray(s.properties)));
  }

  // Seventeenth log: {"type":"object"} — no required, no properties — passed
  // the JSON-shape gate at BOTH io.confirm and service.update. Every
  // schema-reading check (scoring, empty/junk/partial-empty detectors) reads
  // required/properties, so the session verified blind and shipped ONE
  // all-empty record as green score-0 garbage. An output schema must declare
  // at least one field somewhere. Input schemas may legitimately be fieldless
  // ({} = a no-parameter service).
  function schemaDeclaresFields(s) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
    if (Array.isArray(s.required) && s.required.length > 0) return true;
    if (s.properties && typeof s.properties === 'object' && !Array.isArray(s.properties) &&
        Object.keys(s.properties).length > 0) return true;
    return false;
  }

  // Reduce a JSON Schema to its load-bearing shape (field names, types,
  // required, nesting). Cosmetic keys (description/title/examples) are
  // ignored, so re-confirmation triggers only on MATERIAL drift: fields
  // added/removed/renamed or types changed.
  function schemaShape(s) {
    const shape = (node) => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
      if (node.type === 'array') return { t: 'array', i: node.items ? shape(node.items) : null };
      const out = { t: typeof node.type === 'string' ? node.type : '?' };
      if (Array.isArray(node.required)) out.req = node.required.map(String).sort();
      if (node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)) {
        out.props = {};
        for (const k of Object.keys(node.properties).sort()) out.props[k] = shape(node.properties[k]);
      }
      return out;
    };
    return JSON.stringify(shape(s));
  }

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
    if (!total) return null;
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
      'Step scripts are async JavaScript whose text is placed after `return`. Every script MUST return a value: a single expression, or an async IIFE whose LAST line is `return <value>;` — a script that yields undefined stores no result (later steps reading __stepResults__[stepId] get nothing; verify.run reports STEP_NO_RETURN). Await every $ call you depend on before returning. Globals: __input__ (run input object), __stepResults__ (prior results by step id), __lastResult__.',
      '',
      '# $ API',
      '- $(sel) — first matching element data',
      '- $count(sel) → number; $list(sel) → serializable element data (plain JSON objects, NOT live DOM nodes — you cannot call querySelectorAll on them); $exists(sel, timeoutMs?) → boolean',
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
      'Every $ call resolves to plain serializable JSON (or a primitive) — a step return value must be fully awaited plain JSON: live DOM nodes and un-awaited Promises cannot cross the sandbox boundary.',
      'The $ list above is exhaustive — there is no $json, $log, $fetch, or any other $ global; use the plain JS builtins (JSON.stringify, Math, Array methods) for anything else.',
      'Selectors are STANDARD CSS only (:has/:not/:is/:where are valid; :has-text/:contains/:text= are NOT and throw instantly).',
      'Selectors may target iframes with the prefix <iframe-css>|<inner-css> (outer selects the iframe element, inner is evaluated inside its document) — works in every $ API.',
      '',
      '# Methodology meta-rules',
      '1. Ground every selector and attribute filter in an observation (probe or user annotation) BEFORE service.update — ungrounded writes are rejected with the missing receipt named.',
      '2. Prefer the cheapest probe that answers the current question; never ask for raw pages.',
      '3. Attribute DISTRIBUTIONS (probe.attrStats), not single samples, reveal what a data-* attribute means (attr is read on every element containerSel matches — the elements themselves, not their descendants).',
      '4. After any container/filter fix, propagate it to every step sharing that selector.',
      '5. When verify.run fails, read diag.read BEFORE changing anything.',
      '6. To observe a hover popover during research call probe.hover (a session tool — do NOT call the $hover DSL primitive as a tool); it returns the popover evidence (observedPopover identity + htmlSnippet) and, when the popover is observed, a canonical popoverSelector whose EXACT string is recorded as an observation receipt — copy that string VERBATIM into popoverSel; an embellished variant (extra attributes) is a new string the gate must reject. Popover absence is ANCHOR-specific evidence: a link with no hovercard does not mean the page has none — hover at least one other anchor before concluding popovers do not work here — on a repeating item (list card, table row, or detail block) the element that carries identity or author metadata is the usual hovercard carrier. When two different anchors show no popover, stop: the page has none.',
      '7. Scrolling is available DURING research via probe.scroll (a session tool — do NOT call the $scroll DSL primitives as tools): use it to trigger lazy-load / viewport-gated content before counting, sampling, or writing scroll steps. The container selector you pass becomes an observation receipt, grounding a later $scrollToBottom(sel) in steps.',
      '8. Iterate the fieldMap in the LIVE tab with probe.extract BEFORE writing steps: one probe turn per revision, warm DOM, empty-field census included. Reserve service.update + verify.run for the end-to-end check — verify opens a FRESH tab, so cold-load divergence (fewer/different items than the research tab) is expected; investigate counts with probes on the research tab, not by re-verifying. Run the FIRST verify with the SAME input values that drove the research page: a different input value can change the result-card population ENTIRELY (a field selector grounded on the researched query may match 0 items under another query — population divergence, not a rendering failure; the verify error FIELD_MATCH_ZERO names the census). Only after a green verify, spot-check one other input. When verify reports INPUT_VALUE_SUSPECT (zero containers on the page — no result items at all), the input VALUE itself is the prime suspect: the site may simply have no content for it (an obscure keyword, an over-specific filter) — that is not a selector bug. Re-run verify.run with {"input": {<param>: <a DIFFERENT, more common value>}} BEFORE hardening selectors; if the alternate value succeeds, adopt it with service.update({testInput: {...}}) (steps-less update is allowed for adoption) and re-verify without an override; note the input-value sensitivity in the ledger.',
      '9. EARLY contract confirmation: right after the first page.open and a coarse look at the repeating item\'s structure (list card, table row, or detail block), propose the input/output contract with io.confirm({inputSchema, outputSchema, note}) and WAIT for the user — service.update is REJECTED until the user confirms. annotate.request is likewise rejected until the confirmation lands: user annotation picks elements for output FIELDS, so settle the contract first. Apply every revision the user returns and re-confirm. Once confirmed, do NOT re-propose the same contract — a re-proposal whose shape matches the confirmed one auto-confirms without prompting the user; propose again only when the user asks for a change or evidence forces a MATERIAL renegotiation. Adding/renaming/removing fields or changing types later is a MATERIAL change: call io.confirm again with the new schemas before service.update (description-only edits are exempt).',
      '10. Ship real values only. A green verify can still carry junk: bare query strings ("?a=b…") posing as ids, data: URIs polluting url/media arrays (inline UI icons — filter arrays to http(s) entries inside the step script), raw HTML dumps in data fields, and OBFUSCATED text (anti-scrape decoy characters mixed into textContent — interleaved/scrambled runs, reversed fragments, combining marks, zero-width chars). If a text value reads scrambled, the clean value usually lives in an ATTRIBUTE on the same element (aria-label, title, datetime) — probe it (attrStats, or extract with attr) and bind the field to that attribute; never ship an obfuscated "best-effort" value in a confirmed field. Check detectors.junkValues in the verify report. If research proves a confirmed field is unextractable or only junk-reachable, renegotiate the contract with io.confirm (drop or redefine the field) instead of shipping it empty/junk. Scalar or single-value outputs skip the array filters but still go through detectors.junkValues. An empty string is not a value either: check detectors.partialEmptyFields — a confirmed field empty in EVERY record (emptyRatio 1) is a binding failure or the page lacks the data, so fix the binding (attribute fallback) or renegotiate with io.confirm; a field empty in only SOME records may legitimately vary (a text-only item has no media) — if it does and the field is required, move it to optional in the contract. Never rationalize a persistent empty as timing or "acceptable", and never hardcode an empty-string placeholder for a confirmed field. Do not declare synthetic bookkeeping fields (an index, serialNumber, a loop counter) in outputSchema: declare only fields the requirement asks for — a populated synthetic field masks the empty-data signals (a record whose only filled field is index reads as non-empty).'
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
    // C3: stamp every probe receipt with the rail's current page epoch so a
    // mid-session reload invalidates earlier evidence at the gate. Probes all
    // record through this wrapper — one stamping point, no per-probe changes.
    const lateBoundLog = {
      record: (obs) => {
        if (!engineLog) return;
        const ep = (d.rail && typeof d.rail.epoch === 'number') ? d.rail.epoch : undefined;
        engineLog.record(typeof ep === 'number' ? Object.assign({}, obs, { epoch: ep }) : obs);
      }
    };
    const probes = probeFactory({ executeDsl: d.rail.executeDsl, observationLog: lateBoundLog });

    let lastVerify = null;
    // I/O contract confirmation state (ninth-log follow-up): runtime flag for
    // the live bag + a provenance:'user' ledger marker that survives seed
    // resume, reload recovery, and ledger compaction (compaction never drops
    // user entries). service.update is gated on one of them.
    let ioConfirmed = false;
    let ioConfirmedShape = null;
    const IO_LEDGER_MARKER = 'I/O CONTRACT CONFIRMED';

    function ioContractConfirmed(ctx) {
      if (ioConfirmed) return true;
      try {
        const ser = (ctx && ctx.ledger && typeof ctx.ledger.serialize === 'function')
          ? ctx.ledger.serialize() : null;
        const entries = (ser && Array.isArray(ser.entries)) ? ser.entries : [];
        return entries.some((e) => e && typeof e.finding === 'string' && e.finding.indexOf(IO_LEDGER_MARKER) !== -1);
      } catch (e) { return false; }
    }

    // Shape of the contract the ledger marker recorded, embedded as JSON so a
    // resumed session (runtime flag gone) can dedupe same-shape re-proposals
    // exactly. Legacy markers (field-name lists only) return null — the caller
    // then consults the bridge, the safe default.
    function ledgerConfirmedShape(ctx) {
      try {
        const ser = (ctx && ctx.ledger && typeof ctx.ledger.serialize === 'function')
          ? ctx.ledger.serialize() : null;
        const entries = (ser && Array.isArray(ser.entries)) ? ser.entries : [];
        for (let i = entries.length - 1; i >= 0; i--) {
          const f = entries[i] && typeof entries[i].finding === 'string' ? entries[i].finding : '';
          if (f.indexOf(IO_LEDGER_MARKER) === -1) continue;
          const at = f.indexOf(' shape: ');
          if (at === -1) return null;
          return JSON.parse(f.slice(at + ' shape: '.length));
        }
      } catch (e) { return null; }
      return null;
    }

    async function ioConfirm(args, ctx) {
      const a = args && typeof args === 'object' ? args : {};
      const bridge = d.ioConfirmBridge;
      if (!bridge || typeof bridge.request !== 'function') {
        return { error: 'io.confirm unavailable — no confirmation bridge wired (wiring bug, not a usage error)' };
      }
      const schemaBad = [];
      if (!isJsonObjectSchema(a.inputSchema)) schemaBad.push('inputSchema');
      if (!isJsonObjectSchema(a.outputSchema)) schemaBad.push('outputSchema');
      if (schemaBad.length) {
        return {
          error: 'SCHEMA_NOT_JSON_SCHEMA: ' + schemaBad.join(' and ') + ' must be a JSON Schema object like {"type":"object","required":["keyword"],"properties":{"keyword":{"type":"string"}}}. Resend io.confirm with both schemas properly shaped.'
        };
      }
      if (!schemaDeclaresFields(a.outputSchema)) {
        return {
          error: 'SCHEMA_NO_FIELDS: outputSchema declares no fields — neither "required" nor "properties" names an output field. Scoring and every empty/junk detector read those keys, so a fieldless contract verifies BLIND: verify.run reports score 0 (green garbage) whether extraction succeeded or failed. Resend io.confirm with an outputSchema like {"type":"object","required":["posts"],"properties":{"posts":{"type":"array","items":{"type":"object"}}}} listing every output field under properties and the must-haves in required.'
        };
      }
      // Dedup: a contract the user already confirmed is NOT re-prompted while
      // its shape is unchanged (rejections of revisions leave the original
      // standing). Only a materially different proposal pops the panel again.
      const incoming = { input: schemaShape(a.inputSchema), output: schemaShape(a.outputSchema) };
      const priorShape = ioConfirmedShape || ledgerConfirmedShape(ctx);
      if (ioContractConfirmed(ctx) && priorShape &&
          priorShape.input === incoming.input && priorShape.output === incoming.output) {
        ioConfirmed = true; // resume path: the runtime flag catches up
        ioConfirmedShape = incoming;
        return { confirmed: true, note: 'contract already confirmed — same contract, proceeding without re-prompting the user' };
      }
      const sess = (ctx && ctx.session) || null;
      let res;
      if (sess && typeof sess.parkBegin === 'function') sess.parkBegin();
      try {
        res = await bridge.request({
          inputSchema: a.inputSchema,
          outputSchema: a.outputSchema,
          note: typeof a.note === 'string' ? a.note : ''
        });
      } finally {
        if (sess && typeof sess.parkEnd === 'function') sess.parkEnd();
      }
      if (res && res.confirmed) {
        ioConfirmed = true;
        ioConfirmedShape = { input: schemaShape(a.inputSchema), output: schemaShape(a.outputSchema) };
        const ledger = (ctx && ctx.ledger) || null;
        if (ledger) {
          try {
            ledger.add({
              finding: IO_LEDGER_MARKER + ' — inputs: [' + Object.keys((a.inputSchema && a.inputSchema.properties) || {}).join(', ') +
                '] outputs: [' + Object.keys((a.outputSchema && a.outputSchema.properties) || {}).join(', ') +
                '] shape: ' + JSON.stringify({ input: incoming.input, output: incoming.output }),
              evidence: 'io.confirm (user approved the proposed contract)',
              confidence: 'high',
              provenance: 'user',
              selectors: []
            });
          } catch (e) { /* ledger secondary — the runtime flag already holds */ }
        }
        return { confirmed: true, note: 'contract approved — author the steps and call service.update with exactly these schemas' };
      }
      return {
        confirmed: false,
        feedback: String((res && res.feedback) || '(no revision note)'),
        note: 'user requested changes — revise the schemas, then call io.confirm again'
      };
    }

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
      if (kind === 'all' || kind === 'popover') {
        const pd = popoverDigest(events);
        if (pd) out.popover = pd;
      }
      if (kind === 'all' || kind === 'counters') out.counters = counterTrajectory(events);
      return out;
    }

    async function annotateRequest(args, ctx) {
      const a = args && typeof args === 'object' ? args : {};
      if (!ioContractConfirmed(ctx)) {
        return {
          error: 'I/O CONTRACT UNCONFIRMED — annotate.request is rejected until the user confirms the input/output contract. Annotation asks the user to pick elements for output fields, so the field list must be settled first: call io.confirm({inputSchema, outputSchema, note}) EARLY (right after the coarse page look), apply any revision the user returns, then annotate to ground selectors for the confirmed fields.'
        };
      }
      const bridge = d.annotationBridge;
      if (!bridge || typeof bridge.request !== 'function') {
        return { error: 'annotation bridge not wired in this host' };
      }
      const sess = (ctx && ctx.session) || null;
      let res;
      if (sess && typeof sess.parkBegin === 'function') sess.parkBegin();
      try {
        res = await bridge.request({
          why: typeof a.why === 'string' ? a.why : '',
          fields: Array.isArray(a.fields) ? a.fields.filter((f) => typeof f === 'string') : [],
          containerSel: typeof a.containerSel === 'string' ? a.containerSel : '',
          hint: typeof a.hint === 'string' ? a.hint : ''
        });
      } finally {
        if (sess && typeof sess.parkEnd === 'function') sess.parkEnd();
      }
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
      if (!ioContractConfirmed(ctx)) {
        return {
          error: 'I/O CONTRACT UNCONFIRMED — service.update is rejected until the user confirms the input/output contract. Call io.confirm({inputSchema, outputSchema, note}) EARLY (right after the first page look), wait for the user, and apply any revision the user returns before authoring steps.'
        };
      }
      const schemaBad = [];
      if (a.inputSchema != null && !isJsonObjectSchema(a.inputSchema)) schemaBad.push('inputSchema');
      if (a.outputSchema != null && !isJsonObjectSchema(a.outputSchema)) schemaBad.push('outputSchema');
      if (schemaBad.length) {
        return {
          error: 'SCHEMA_NOT_JSON_SCHEMA: ' + schemaBad.join(' and ') + ' must be a JSON Schema object like {"type":"object","required":["posts"],"properties":{"posts":{"type":"array","items":{"type":"object"}}}}, not a natural-language map like {"posts":"array of post objects"}. Verify scoring and every detector read "required"/"properties" — a natural-language map leaves them all blind, so verify.run reports score 0 even after a fully successful extraction. Resend with JSON-Schema-shaped schemas: list every output field under properties and put the must-have keys in required.'
        };
      }
      // Seventeenth log: a fieldless outputSchema must not slip in here either
      // (the io.confirm gate rejects it, but drift/renegotiation paths and
      // legacy resumed sessions converge on service.update).
      if (a.outputSchema != null && !schemaDeclaresFields(a.outputSchema)) {
        return {
          error: 'SCHEMA_NO_FIELDS: outputSchema declares no fields — neither "required" nor "properties" names an output field, so scoring and every empty/junk detector verify BLIND (score 0 green garbage). Resend with the fielded outputSchema the contract carries: fields under "properties", must-haves in "required" — renegotiate with io.confirm first if the field list itself is changing.'
        };
      }
      // Runtime-flag path: a materially different contract must be
      // re-confirmed. The ledger-marker recovery path (session resume /
      // reload) intentionally skips this — the user is already driving
      // those continuations via feedback.
      if (ioConfirmed && ioConfirmedShape && (a.inputSchema != null || a.outputSchema != null)) {
        const drift = [];
        if (a.inputSchema != null && schemaShape(a.inputSchema) !== ioConfirmedShape.input) drift.push('inputSchema');
        if (a.outputSchema != null && schemaShape(a.outputSchema) !== ioConfirmedShape.output) drift.push('outputSchema');
        if (drift.length) {
          return {
            error: 'I/O CONTRACT DRIFT — ' + drift.join(' and ') + ' differ materially from the contract the user confirmed (fields added/removed/renamed or types changed; cosmetic description edits are fine). Call io.confirm with the NEW schemas, wait for the user, then service.update.'
          };
        }
      }
      // Fourteenth-log follow-up (user request): when an alternate input
      // value turned out to be the fix (INPUT_VALUE_SUSPECT loop), the model
      // must be able to ADOPT it without re-sending the whole step graph.
      // Steps-less update with only testInput against the existing artifact.
      // Runs BEFORE chain validation — an empty steps array is the signal.
      const currentSteps = (typeof d.getSteps === 'function' ? (d.getSteps() || []) : []);
      if (!steps.length && a.testInput && typeof a.testInput === 'object' && !Array.isArray(a.testInput)) {
        if (!currentSteps.length) {
          return { error: 'no artifact yet — a steps-less testInput update needs an existing step graph; author it with service.update({steps,...}) first' };
        }
        d.applyArtifact({ steps: currentSteps, testInput: a.testInput });
        return { updated: true, testInputAdopted: true, note: 'test input adopted — run verify.run WITHOUT an input override to confirm the default input works' };
      }
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

    // Ninth-log M3: the research tab must never open a LITERAL {{param}}
    // placeholder — the resulting page is a real search for the placeholder
    // string, its probes return plausible-but-wrong evidence, and the ninth
    // log burned ~30 of 60 turns on it. Substitute every {{key}} the test
    // input can fill; refuse to open while any placeholder remains (the model
    // re-opens with a concrete sample value one turn later).
    function renderTemplateUrl(url, input) {
      return String(url).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => (
        input && typeof input === 'object' && key in input &&
        input[key] !== undefined && input[key] !== null ? String(input[key]) : m
      ));
    }

    async function pageOpen(args) {
      const a = args && typeof args === 'object' ? args : {};
      let url = typeof a.url === 'string' ? a.url : '';
      if (url) {
        const input = typeof d.getTestInput === 'function' ? (d.getTestInput() || {}) : {};
        url = renderTemplateUrl(url, input);
        const left = url.match(/\{\{\s*\w+\s*\}\}/g);
        if (left && left.length) {
          return {
            error: 'url contains unsubstituted template parameter(s) ' + left.join(', ') +
              ' — opening it would run the site\'s search FOR THE LITERAL PLACEHOLDER, and every probe on that page returns misleading evidence. ' +
              'testInput keys available: [' + Object.keys(input).join(', ') + ']. ' +
              'Re-open with a concrete sample value substituted for every {{param}}, then probe.'
          };
        }
      }
      const substituted = typeof a.url === 'string' && url !== a.url;
      return d.rail.pageOpen(substituted ? Object.assign({}, a, { url: url }) : args);
    }

    const tools = {
      'page.open': pageOpen,
      'page.state': d.rail.pageState,
      'probe.count': probes.count,
      'probe.text': probes.text,
      'probe.attrStats': probes.attrStats,
      'probe.sample': probes.sample,
      'probe.hover': probes.hover,
      'probe.scroll': probes.scroll,
      'probe.extract': probes.extract,
      'diag.read': diagRead,
      'verify.run': verifyRun,
      'annotate.request': annotateRequest,
      'io.confirm': ioConfirm,
      'service.update': serviceUpdate
    };

    const toolSpecs = [
      { name: 'page.open', args: '{url?}', returns: '{tabId,url,ready,warning?} — {{param}} placeholders are filled from the test input; a URL that still has one is rejected (never probe the literal placeholder page)' },
      { name: 'page.state', args: '{}', returns: '{open,tabId,url,title,status}' },
      { name: 'probe.count', args: '{sel}', returns: '{count}' },
      { name: 'probe.text', args: '{sel}', returns: '{total,items[]}' },
      { name: 'probe.attrStats', args: '{containerSel, attr}', returns: '{totalItems,values[{value,items,pct}],absentPct}' },
      { name: 'probe.sample', args: '{sel, opts:{index,wantHtml,clean}}', returns: '{match,total,element,html?} — clean:true strips scripts/styles/noise from the HTML (prefer it when reading structure)' },
      { name: 'probe.hover', args: '{anchorSel, popoverSel?, opts:{index,timeoutMs}}', returns: '{hovered,htmlSnippet,popoverSelector,popoverSelectorNote?,reason,observedPopover?}' },
      { name: 'probe.scroll', args: "{mode?:'bottom'|'by', sel?, by?}", returns: '{scrolled,prevY,newY}' },
      { name: 'probe.extract', args: '{containerSel, fieldMap, multi?, allowEmpty?}', returns: '{total,records[3],emptyFields{field:emptyCount}}' },
      { name: 'diag.read', args: '{stepId?, kind?}', returns: '{selectorDiagnostics, failingStep?, popover, counters, lastError?}' },
      { name: 'verify.run', args: '{input?} — optional object overriding the test input for THIS run (the mechanism for alternate-value re-tests when INPUT_VALUE_SUSPECT says the site may have no content for the current value)', returns: '{ok,score,scoreNote?,error,detectors,steps,finalResult,schemaOk} — detectors.partialEmptyFields lists confirmed fields that came back empty with their emptyRatio (empty/total records): ratio 1 means fix the binding or renegotiate the contract, not ship it' },
      { name: 'annotate.request', args: '{why, fields?, containerSel?}', returns: '{annotations[{selector,purpose,outputField}]} | {cancelled} — REQUIRES a confirmed I/O contract (io.confirm first)' },
      { name: 'io.confirm', args: '{inputSchema, outputSchema, note?}', returns: '{confirmed:true} | {confirmed:false, feedback} — propose the contract EARLY and wait for the user; service.update is rejected until a confirmation lands; a SAME-shape re-proposal auto-confirms without prompting. outputSchema MUST declare its fields (properties + required); a fieldless {"type":"object"} verifies blind and is rejected' }
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
