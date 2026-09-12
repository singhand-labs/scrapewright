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
      'Step scripts run as the BODY of an async function — executed as `(async function(__input__) { <your script> })(__input__)`. Top-level `await` works directly, and every script MUST contain a top-level `return <value>;` statement (statement scripts like `const x = await $(...); return {...};` are the norm — no wrapper needed, and do NOT wrap the script in `return (...)` or an extra IIFE; the engine already provides the function body). A script that yields undefined stores no result (later steps reading __stepResults__[stepId] get nothing; verify.run reports STEP_NO_RETURN). Await every $ call you depend on before returning. Globals: __input__ (run input object), __stepResults__ (prior results by step id), __lastResult__.',
      '',
      '# $ API',
      '- $(sel) — first matching element data',
      '- $count(sel) → number; $list(sel) → serializable element data (plain JSON objects, NOT live DOM nodes — you cannot call querySelectorAll on them); $exists(sel, timeoutMs?) → boolean (VISIBILITY-gated — false for display:none/zero-size elements; reads are NOT gated, so never guard a read with it; probe.count reports the visible/invisible census)',
      '- $extract(sel, attr?) → string — first match; attr may be "outerHTML" or any attribute name; no attr = trimmed textContent; the return is a BARE string, assign it directly (postTime = await $extract(sel)); element-HTML reads (outerHTML/innerHTML) are capped at 50000 chars with a `<!--TRUNCATED: ...-->` suffix disclosing the original length',
      '- $labelledby(sel, attr?, timeoutMs?) → {text, attr, refCount, missingIds?, note?, viaDescendant?} — resolves the ARIA reference attr (default aria-labelledby; pass "aria-describedby") on the first match; when the match carries NEITHER reference attribute, resolution DESCENDS to its first descendant that carries one (disclosed as viaDescendant + note — own attributes always win); .text carries the CONCATENATED text of the referenced element(s) (id list looked up by id) — postTime = (await $labelledby(sel)).text. probe.labelledby returns this SAME object shape. Tooltip/timestamp full values usually live there — the referenced span is often hidden but readable, so use this instead of re-hovering when the popover never visibly renders. When a time field needs the full candidate→hover→filter dance, probe.timestamp does it in ONE call and returns date-shaped candidates only (absolute preferred). Environmental claims need evidence too: before concluding "requires login"/"unauthenticated", call probe.loginState and quote its marker census — page shape alone is not login-state evidence',
      '- $extractList(containerSel, fieldMap, opts?) — one record per container; fieldMap {field:{selector,attr?,labelledby?,multi?}}; a spec with multi:true (e.g. {selector:"a[href]",attr:"href",multi:true}) collects ALL matches of that field per container as an ARRAY (document order, [] when none) — the exact envelope probe.extract returns with multi:true, so a multi-probed fieldMap pastes into the step as-is (a NON-multi field is a scalar string; for-of over a string iterates characters and matches nothing); labelledby:true (or the attr name, e.g. aria-describedby) resolves the ARIA reference on the match and returns the referenced elements\' concatenated text — the read for anti-scrambled textContent (the visible text is decoy junk; the clean value lives in the hidden elements the reference points at; same resolution as $labelledby, INCLUDING the descendant fallback: when the matched element carries no reference attribute, resolution descends to the first descendant that carries one — so the fieldMap selector may point at the ANCHOR while a child span holds the aria-labelledby); opts.allowEmpty keeps empty-string fields (return every record, never filter to []); attr:"outerHTML"/"innerHTML" values are capped at 50000 chars with a TRUNCATED disclosure suffix — anchor htmlSnippet-style fields to the SEMANTIC sub-element, not the whole card (whole-card DOM is class/style/SVG noise; verify flags such fields OUTPUT_FIELD_SIZE)',
      '- $extractListMulti(containerSel, fieldMap, opts?) — array-valued fields (labelledby fields resolve every match); equivalent to every fieldMap spec carrying multi:true — use it for whole-call multi, or the per-field multi:true flag when only SOME fields need all matches (e.g. every anchor href per card beside scalar reads)',
      '- $extractWithHover(containerSel, fieldMap, {hover:{anchorSel, popoverSel?}}) — hover-enriched extraction; the SAME fieldMap shape as $extractList, per-field multi:true included (all matches per container as an array — the envelope a multi probe.extract returns, e.g. every anchor href per card to regex the post id out of); anchorSel is evaluated INSIDE each container and may be a comma-UNION to hover several anchors per card (e.g. the author link AND the timestamp element — each lands as its own entry). Each record carries its hover results in `hovercards[]`, ONE ENTRY PER matched anchor: {hovered, htmlSnippet, popoverSelector, reason, observedPopover, anchorIndex, anchorHref, anchorText, labelledbyText, labelledbyAttr} — probe.hover shows this same envelope for a single anchor. Build the output hover-card fields from r.hovercards (htmlSnippet is the captured popover DOM; anchorHref/anchorText tell you WHICH anchor produced it — anchorHref resolves the nearest ENCLOSING a[href] when the anchor itself is not the link, so pointing anchorSel at an inner span still classifies by the link it sits in). labelledbyText is the anchor\'s ACCESSIBLE LABEL, harvested in the same operation at dwell time: the full text its aria-labelledby/aria-describedby references carry (hidden-but-readable tooltip spans — timestamps hold their FULL value there) — and when the anchor itself carries no reference attribute, the harvest descends to the anchor\'s first descendant that carries one (so pointing anchorSel at the whole time link still harvests the inner span\'s label) — present on FAILED entries too (a label needs no visible popover), so a label-anchor entry (timestamp, icon, compact field) is exactly where to take a field\'s value from, NOT something to filter out of the assembly; there is no popoverHtml or __popover field',
      '- $hover(anchorSel, popoverSel?, opts?) — one-off trusted hover (opts.index picks the Nth anchor); for hover-enriched record extraction prefer $extractWithHover',
      '- $waitForStable(sel, opts?) — resolves true once the element\'s sampled content stops changing (streaming content); prefer over setTimeout guessing; a false resolve\'s diagnostics carry pageState — hidden/unfocus means the tab was throttled (content may simply never have arrived), not that the text kept changing',
      '- $click(sel), $type(sel, text), $check(sel, prop)',
      '- $wait(sel, ms?) — waits for a selector (30s cap) then sleeps ms; THROWS ELEMENT_NOT_FOUND if the selector never appears, so never $wait on a selector whose absence is your poll condition (content still loading) — $count it and return { done: false } so maxIterations drives the wait',
      '- $clickInList(containerSel, subSel) — click inside every matched container',
      '- $scrollBy(px), $scrollToBottom(), $scrollIntoView(sel) — for a count-bounded feed (the requirement asks for N items) write a poll step (maxIterations>1): $scrollBy one viewport per iteration, $count the population, return {done:false} while count < N and {done:true} with the data once it reaches N; reserve $scrollToBottom for genuinely collect-everything requirements. All scroll ops auto-activate the tab AND re-focus its window (infrastructure — the user may switch away mid-run; every call switches back). A no-progress $scrollBy result carries pageState (real visibilityState/hasFocus) and, when gated, frameSample (rAF ticks over ~300ms): ~0 ticks = the renderer stopped producing frames for this tab (lazy-load cannot fire — activation is automatic; `scrapewright throttle on` covers occluded windows); normal ticks with a stable count = the feed is genuinely exhausted',
      '- $openTab(url, fn) — open a sub-tab, run fn in it, return its result',
      'Every $ call resolves to plain serializable JSON (or a primitive) — a step return value must be fully awaited plain JSON: live DOM nodes and un-awaited Promises cannot cross the sandbox boundary.',
      'The $ list above is exhaustive — there is no $json, $log, $fetch, or any other $ global; use the plain JS builtins (JSON.stringify, Math, Array methods) for anything else.',
      'Selectors are STANDARD CSS only (:has/:not/:is/:where are valid; :has-text/:contains/:text= are NOT and throw instantly).',
      'Selectors may target iframes with the prefix <iframe-css>|<inner-css> (outer selects the iframe element, inner is evaluated inside its document) — works in every $ API.',
      '',
      '# Methodology meta-rules',
      '1. Ground every selector and attribute filter in an observation (probe or user annotation) BEFORE service.update — ungrounded writes are rejected with the missing receipt named.',
      '2. Prefer the cheapest probe that answers the current question; never ask for raw pages.',
      '3. Attribute DISTRIBUTIONS (probe.attrStats), not single samples, reveal what a data-* attribute means (attr is read on every element containerSel matches — the elements themselves, not their descendants). :has()/:not(:has()) filter by DESCENDANTS: before shipping a clause on an attr, census the descendant form containerSel + " [attr]" — absentPct 100 on the element form does NOT mean the attr is absent inside your containers, and a clause built on that misreading can exclude the whole population.',
      '4. After any container/filter fix, propagate it to every step sharing that selector.',
      '5. When verify.run fails, read diag.read BEFORE changing anything.',
      '6. To observe a hover popover during research call probe.hover (a session tool — do NOT call the $hover DSL primitive as a tool); it returns the popover evidence (observedPopover identity + htmlSnippet) and, when the popover is observed, a canonical popoverSelector whose EXACT string is recorded as an observation receipt — copy that string VERBATIM into popoverSel; an embellished variant (extra attributes) is a new string the gate must reject. A no-popover probe.hover result may carry rejectedAddedTexts — text READ out of hover-mounted nodes the visual filter rejected (hidden or zero-height mounts): the popover "exists" as readable content even though it never rendered visually; if the value you need is in rejectedAddedTexts, bind the field from it directly instead of re-hovering. Also try probe.labelledby on the anchor first: tooltip and timestamp values very often live in the element an aria-labelledby reference points at — hidden but readable in one call, no hover needed. Popover absence is ANCHOR-specific evidence: a link with no hovercard does not mean the page has none — hover at least one other anchor before concluding popovers do not work here — on a repeating item (list card, table row, or detail block) the element that carries identity or author metadata is the usual hovercard carrier. When two different anchors show no popover, stop: the page has none. CHOOSE THE ANCHOR BY REQUIREMENT SEMANTICS, not element type: any element can carry a hover or click handler (span, abbr, time, div, li — not just links), so to read a timestamp tooltip hover the timestamp element itself (the abbr/time/span rendering the relative age); an a[href]-typed anchor both misses the semantic target (its popover never triggers) and wastes budget on navigation chrome that matches first in document order.',
      '7. Scrolling is available DURING research via probe.scroll and probe.scrollUntil (session tools — do NOT call the $scroll DSL primitives as tools). REQUIREMENT-BOUNDED SCROLLING: when the requirement names a count (N items / 条数), the scroll loop is BOUNDED by that count — call probe.scrollUntil({sel, targetCount: N}) which scrolls one viewport, settles, and re-counts each round, stopping the MOMENT the population reaches N; never scroll to the end of the feed for a bounded requirement, and never spend turns on manual scroll→count cycles the tool performs in one call (scroll-to-exhaustion wastes budget on feeds that never end). READ THE TRACE it returns: a count that NEVER changes while page height grows means sel matches static page chrome instead of the growing population — a wrong selector, not missing data; re-target sel at what actually grows before scrolling again. A count AND height that both stop changing means the SCROLL ROOT TESTED is exhausted — that is all this path yields (some sites scroll the feed inside an inner overflow container while the window sits still; the at_bottom note and the $scrollBy fallback:"inner-container" disclosure say when to retry with scrollSel). A count frozen at a NONZERO value while scroll makes no progress is ambiguous between renderer gating and real exhaustion — read the scroll diagnostics\' pageState/frameSample (hidden/unfocused + ~0 rAF ticks = throttled tab: activation and window focus are automatic, `scrapewright throttle on` covers occlusion; normal frames = exhausted, accept the count or renegotiate with io.confirm) instead of rewriting the scroll step. A container selector you scroll or count becomes an observation receipt, grounding a later $scrollToBottom(sel)/$scrollBy(n, sel) in steps.',
      '8. Iterate the fieldMap in the LIVE tab with probe.extract BEFORE writing steps: one probe turn per revision, warm DOM, empty-field census included. Reserve service.update + verify.run for the end-to-end check — verify opens a FRESH tab, so cold-load divergence (fewer/different items than the research tab) is expected; investigate counts with probes on the research tab, not by re-verifying. Run the FIRST verify with the SAME input values that drove the research page: a different input value can change the result-card population ENTIRELY (a field selector grounded on the researched query may match 0 items under another query — population divergence, not a rendering failure; the verify error FIELD_MATCH_ZERO names the census). Only after a green verify, spot-check one other input. When verify reports INPUT_VALUE_SUSPECT (zero containers on the page — no result items at all), the input VALUE itself is the prime suspect: the site may simply have no content for it (an obscure keyword, an over-specific filter) — that is not a selector bug. Re-run verify.run with {"input": {<param>: <a DIFFERENT, more common value>}} BEFORE hardening selectors; if the alternate value succeeds, adopt it with service.update({testInput: {...}}) (steps-less update is allowed for adoption) and re-verify without an override; note the input-value sensitivity in the ledger. BUT read the differential first: when the error says SELECTOR_OVERFILTERED (or the census carries [differential: ...] showing the stripped base selector matched >0), the page HAS items and your own trailing :not()/:has() clause(s) removed them — that is a selector problem, NOT an input-value problem: census each clause (count with/without it; attrStats descendant form) and drop or fix the fatal clause instead of re-testing input values. A "no containers matched" probe error carries the same differential inline.',
      '9. EARLY contract confirmation: right after the first page.open and a coarse look at the repeating item\'s structure (list card, table row, or detail block), propose the input/output contract with io.confirm({inputSchema, outputSchema, testInput, note}) and WAIT for the user — service.update is REJECTED until the user confirms. Before that coarse look, make sure the page is RENDERED, not just loaded: ready/bodyTextChars from page.open says the tab loaded; a shell-sized body or empty-looking page on a JS-heavy site is usually still hydrating — call page.settle and only then probe (probing an unhydrated shell yields "empty page" evidence about timing, not about the page). annotate.request is likewise rejected until the confirmation lands: user annotation picks elements for output FIELDS, so settle the contract first. Apply every revision the user returns and re-confirm. Once confirmed, do NOT re-propose the same contract — a re-proposal whose shape AND test values match the confirmed ones auto-confirms without prompting the user; propose again only when the user asks for a change or evidence forces a MATERIAL renegotiation. Adding/renaming/removing fields or changing types later is a MATERIAL change: call io.confirm again with the new schemas before service.update (description-only edits are exempt). After confirmation you may send service.update with steps only — the confirmed schemas attach to the artifact automatically; a schema-only service.update ({inputSchema, outputSchema} alone, no steps) also lands the contract when the artifact already exists. PROPOSE THE TEST REQUEST VALUES TOGETHER WITH THE SCHEMAS: pass testInput ({keyword:"...",count:N} — the concrete values every verify.run sends) in the same io.confirm; the user confirms or edits them in the same panel and they become the artifact\'s testInput. Propose the values you actually researched with; omitting testInput shows the artifact\'s current values for blessing. Changing test values later is a MATERIAL change: service.update({testInput:...}) with values differing from the confirmed ones is rejected with TEST_INPUT_UNCONFIRMED — re-confirm via io.confirm with the same schemas and the new testInput first.',
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
    // Twenty-first log: the FULL schemas behind the confirmed shape. Shape
    // alone could never land in the artifact — every steps-only update left
    // the artifact schema-blind (verify score 0 over real data), and the
    // model's only way out was re-sending schemas the DRIFT gate then
    // rejected. The full copy lets service.update attach the confirmed
    // contract automatically and the DRIFT error quote it verbatim.
    let ioConfirmedSchemas = null;
    let ioConfirmedTestInput = null;
    // Sixty-ninth review F7(a): the inputSchema SHAPE at confirmation time.
    // Prefilling prior-confirmed test values into a RENEGOTIATED contract
    // (different input shape) blessed stale parameters for fields that may
    // no longer exist — the prefill chain is shape-keyed now.
    let ioConfirmedTestInputShape = null;
    const IO_LEDGER_MARKER = 'I/O CONTRACT CONFIRMED';

    // Forty-sixth log: the test request values are part of the confirmed
    // contract. Equality must be key-ORDER-insensitive (the model resending
    // {count,keyword} after confirming {keyword,count} is not a drift), so
    // compare a sorted-key serialization. null = "no testInput at all"
    // (parameterless service / legacy confirmations) — two nulls are equal.
    function testInputKey(ti) {
      if (!ti || typeof ti !== 'object' || Array.isArray(ti)) return null;
      const parts = [];
      for (const k of Object.keys(ti).sort()) {
        let v;
        try { v = JSON.stringify(ti[k]); } catch (e) { v = String(ti[k]); }
        parts.push(k + ':' + v);
      }
      return parts.join('|');
    }

    function isPlainObjectValue(v) {
      return !!v && typeof v === 'object' && !Array.isArray(v);
    }

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
          // Forty-sixth log: the marker may carry ' testInput: {...}' AFTER
          // the shape JSON — slice it off before parsing or the parse dies
          // on trailing content and every resumed session loses the dedup.
          const tiAt = f.indexOf(' testInput: ', at);
          const end = tiAt === -1 ? -1 : tiAt;
          const slice = end === -1 ? f.slice(at + ' shape: '.length) : f.slice(at + ' shape: '.length, end);
          return JSON.parse(slice);
        }
      } catch (e) { return null; }
      return null;
    }

    // Full schemas the ledger marker recorded (twenty-first log). The marker
    // embeds them BEFORE the shape JSON (' schemas: {...} shape: {...}'), so
    // the slice runs from ' schemas: ' to the next ' shape: '. Legacy markers
    // (shape only / field-name lists only) return null — callers fall back to
    // not attaching anything, which is the pre-fix behavior (safe default).
    function ledgerConfirmedSchemas(ctx) {
      try {
        const ser = (ctx && ctx.ledger && typeof ctx.ledger.serialize === 'function')
          ? ctx.ledger.serialize() : null;
        const entries = (ser && Array.isArray(ser.entries)) ? ser.entries : [];
        for (let i = entries.length - 1; i >= 0; i--) {
          const f = entries[i] && typeof entries[i].finding === 'string' ? entries[i].finding : '';
          if (f.indexOf(IO_LEDGER_MARKER) === -1) continue;
          const at = f.indexOf(' schemas: ');
          if (at === -1) return null;
          const end = f.indexOf(' shape: ', at);
          const slice = end === -1 ? f.slice(at + ' schemas: '.length) : f.slice(at + ' schemas: '.length, end);
          const parsed = JSON.parse(slice);
          return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
        }
      } catch (e) { return null; }
      return null;
    }

    // Confirmed test request values the ledger marker recorded (forty-sixth
    // log). Legacy markers (pre-F1) carry no ' testInput: ' section and
    // return null — the adoption path then stays lenient, preserving the
    // pre-fix behavior for sessions resumed from old ledgers.
    function ledgerConfirmedTestInput(ctx) {
      try {
        const ser = (ctx && ctx.ledger && typeof ctx.ledger.serialize === 'function')
          ? ctx.ledger.serialize() : null;
        const entries = (ser && Array.isArray(ser.entries)) ? ser.entries : [];
        for (let i = entries.length - 1; i >= 0; i--) {
          const f = entries[i] && typeof entries[i].finding === 'string' ? entries[i].finding : '';
          if (f.indexOf(IO_LEDGER_MARKER) === -1) continue;
          const at = f.indexOf(' testInput: ');
          if (at === -1) return null;
          const parsed = JSON.parse(f.slice(at + ' testInput: '.length));
          return isPlainObjectValue(parsed) ? parsed : null;
        }
      } catch (e) { return null; }
      return null;
    }

    // Thirty-first log: the confirm panel rendered raw schemas, and a
    // renegotiation that moved a field OUT of items.required (dropping the
    // REQUIRED_FIELD_EMPTY guarantee) was approved in ~90 seconds — the user
    // confirmed "something changed" without the requirement change being
    // readable. Compute the exact diff against the confirmed contract so the
    // panel renders WHAT changes (fields leaving/entering required, fields
    // added/removed, type changes), not just that the JSON differs.
    function contractDiffLines(prevOut, nextOut) {
      const lines = [];
      const prev = (prevOut && typeof prevOut === 'object') ? prevOut : {};
      const next = (nextOut && typeof nextOut === 'object') ? nextOut : {};
      const reqOf = (s) => (Array.isArray(s.required) ? s.required.map(String) : []);
      const propsOf = (s) => (s.properties && typeof s.properties === 'object' && !Array.isArray(s.properties)) ? s.properties : {};
      const typeOf = (v) => (v && Array.isArray(v.type)) ? v.type.join('|') : ((v && v.type) ? String(v.type) : '-');
      const reqDiff = (scope, a, b) => {
        for (const f of a.filter((x) => b.indexOf(x) === -1)) {
          lines.push(scope + ' "' + f + '" LEAVING required — it was contractually demanded for every record and becomes optional or dropped');
        }
        for (const f of b.filter((x) => a.indexOf(x) === -1)) {
          lines.push(scope + ' "' + f + '" ENTERING required — now contractually demanded for every record');
        }
      };
      const propsDiff = (scope, prevProps, nextProps) => {
        const a = Object.keys(prevProps);
        const b = Object.keys(nextProps);
        for (const f of a.filter((x) => b.indexOf(x) === -1)) lines.push(scope + ' "' + f + '" REMOVED from the output');
        for (const f of b.filter((x) => a.indexOf(x) === -1)) lines.push(scope + ' "' + f + '" ADDED to the output');
        for (const f of a.filter((x) => b.indexOf(x) !== -1)) {
          const ta = typeOf(prevProps[f]);
          const tb = typeOf(nextProps[f]);
          if (ta !== tb) lines.push(scope + ' "' + f + '" type ' + ta + ' → ' + tb);
        }
      };
      const pp = propsOf(prev);
      const np = propsOf(next);
      reqDiff('output key', reqOf(prev), reqOf(next));
      propsDiff('output key', pp, np);
      for (const key of Object.keys(np)) {
        const ni = np[key] && np[key].items;
        if (!ni || typeof ni !== 'object') continue;
        const pi = (pp[key] && pp[key].items) || null;
        const scope = 'record field of "' + key + '"';
        reqDiff(scope, pi && Array.isArray(pi.required) ? pi.required.map(String) : [], Array.isArray(ni.required) ? ni.required.map(String) : []);
        propsDiff(scope, (pi && pi.properties && typeof pi.properties === 'object' && !Array.isArray(pi.properties)) ? pi.properties : {},
          (ni.properties && typeof ni.properties === 'object' && !Array.isArray(ni.properties)) ? ni.properties : {});
      }
      return lines;
    }

    // Thirty-sixth log: a confirmed amendment updated only the runtime
    // ioConfirmedSchemas — the artifact kept the PREVIOUS schema until the
    // next service.update, and verify prefers the artifact-attached schema,
    // so a verify run between amendment and update judged the stale
    // REQUIRED contract (reporting "the confirmed contract lists it as
    // REQUIRED" about fields the user had just waived, burning the final
    // turns). The confirmation IS the moment the contract changes: land it
    // on the artifact immediately. The shape guard keeps it idempotent —
    // re-confirming the standing contract (or the ledger-recovery
    // re-proposal of a resumed session) attaches nothing.
    function attachConfirmedSchemas(schemas) {
      const currentSteps = (typeof d.getSteps === 'function' ? (d.getSteps() || []) : []);
      if (!currentSteps.length) return false; // no artifact yet — service.update attaches on landing
      const artifactOut = (typeof d.getOutputSchema === 'function') ? d.getOutputSchema() : null;
      const artifactIn = (typeof d.getInputSchema === 'function') ? d.getInputSchema() : null;
      const outDrift = !artifactOut || schemaShape(artifactOut) !== schemaShape(schemas.outputSchema);
      const inDrift = !!schemas.inputSchema && (!artifactIn || schemaShape(artifactIn) !== schemaShape(schemas.inputSchema));
      if (!outDrift && !inDrift) return false;
      try {
        d.applyArtifact({ steps: currentSteps, inputSchema: schemas.inputSchema, outputSchema: schemas.outputSchema });
        if (lastVerify) lastVerify.staleArtifact = true;
        return true;
      } catch (e) { return false; }
    }

    // Forty-sixth log: the user-blessed test request values must land on the
    // artifact at the moment of confirmation (same contract as
    // attachConfirmedSchemas — a verify between confirmation and the next
    // service.update must already run the confirmed values, not the model's
    // silent pick). Shape guard keeps re-confirmation idempotent.
    function attachConfirmedTestInput(ti) {
      if (!isPlainObjectValue(ti) || !Object.keys(ti).length) return false;
      const currentSteps = (typeof d.getSteps === 'function' ? (d.getSteps() || []) : []);
      if (!currentSteps.length) return false; // no artifact yet — service.update attaches on landing
      const current = (typeof d.getTestInput === 'function') ? d.getTestInput() : null;
      if (testInputKey(current) === testInputKey(ti)) return false;
      try {
        d.applyArtifact({ steps: currentSteps, testInput: ti });
        if (lastVerify) lastVerify.staleArtifact = true;
        return true;
      } catch (e) { return false; }
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
      // Fifty-second log: likes/comments/shares/htmlSnippet/hoverCards were
      // declared at the items level OUTSIDE properties and admitted — the
      // strays were invisible to every schema-driven gate for the whole
      // session (the never-extracted lint never enumerated them, `role: ''`
      // sat hardcoded through seven artifact versions with no receipt).
      // Fifty-ninth log: a renegotiation carried "postId": {"type":"type",
      // "description":"placeholder"} — a literal unfilled stub — and the
      // panel showed it to the USER, who had to reject it twice. Placeholder-
      // shaped schemas are rejected before the panel: the user is the
      // authority on the CONTRACT, not the lint layer for stub values.
      const outStubs = (typeof WU.detectSchemaPlaceholderFields === 'function')
        ? WU.detectSchemaPlaceholderFields(a.outputSchema) : null;
      if (outStubs) {
        return {
          confirmed: false,
          error: 'PLACEHOLDER_SCHEMA: outputSchema contains unfilled stub field(s) — ' +
            outStubs.map((h) => h.field + ' (' + h.problems.join('; ') + ')').join(', ') +
            '. Fill every field with a real type from the JSON-Schema set (object/string/number/integer/boolean/array/null) and a real description, then re-propose.'
        };
      }
      const outStrays = (typeof WU.detectStrayFieldDeclarations === 'function')
        ? WU.detectStrayFieldDeclarations(a.outputSchema) : null;
      if (outStrays) {
        const allStrays = [];
        for (const h of outStrays) allStrays.push.apply(allStrays, h.strays);
        return {
          confirmed: false,
          error: 'SCHEMA_STRAY_FIELD_DECLS: outputSchema declares field definition(s) OUTSIDE "properties" — [' + Array.from(new Set(allStrays)).sort().join(', ') + '] sit at ' +
            outStrays.map((h) => h.at).join('; ') + ' as siblings of "properties"/"required", not inside them. Stray declarations are INVISIBLE to every schema-driven gate: scoring required-coverage, the empty/junk censuses, and the never-extracted lint never read them (a session shipped role 10/10 empty through seven artifact versions this way). Move each declaration under its parent object\'s "properties" and re-confirm.'
        };
      }
      // Forty-sixth log (user request): the TEST REQUEST VALUES are
      // confirmed together with the schemas. The model had been picking
      // {keyword, count} silently — every verify.run executed values the
      // user never saw. The proposal may carry testInput; when it omits it,
      // the artifact's CURRENT values are what the user is asked to bless.
      if (a.testInput != null && !isPlainObjectValue(a.testInput)) {
        return {
          error: 'TEST_INPUT_NOT_OBJECT: testInput must be a plain object of concrete request parameter values like {"keyword":"machine learning","count":5} — the user confirms these exact values alongside the schemas.'
        };
      }
      const liveTestInput = (typeof d.getTestInput === 'function') ? d.getTestInput() : null;
      const liveHasValues = isPlainObjectValue(liveTestInput) && Object.keys(liveTestInput).length > 0;
      // Sixty-ninth review F7: the fallback chain must reach the SESSION's
      // confirmed values too — at the incident turn the artifact did not
      // exist yet, so liveTestInput was empty and the panel prefilled {},
      // which the user then blessed; TEST_INPUT_UNCONFIRMED persisted from
      // there. Order: model proposal → artifact's current values → the
      // confirmed values from THIS session (runtime flag, then ledger
      // marker). The user can never bless an EMPTY testInput when prior
      // confirmed values exist anywhere.
      // F7(a) shape-key: prior confirmed values prefill ONLY when the
      // proposal's inputSchema shape matches the shape recorded at
      // confirmation time — a renegotiated contract gets no stale prefill
      // (the panel shows the proposal as-is).
      // F7(b) explicit-empty: a PRESENT-but-empty {} testInput is treated as
      // omitted for the prefill chain (the model virtually never means to
      // bless {}) — {} stays the proposal only when inputSchema declares
      // zero properties (a genuinely parameterless service).
      const incomingInputShape = schemaShape(a.inputSchema);
      const ledgerPriorShape = ledgerConfirmedShape(ctx);
      const priorTI = (
        (ioConfirmedTestInput && ioConfirmedTestInputShape === incomingInputShape) ? ioConfirmedTestInput : null
      ) || (
        (ledgerPriorShape && ledgerPriorShape.input === incomingInputShape) ? ledgerConfirmedTestInput(ctx) : null
      );
      const priorHasValues = isPlainObjectValue(priorTI) && Object.keys(priorTI).length > 0;
      const inPropCount = Object.keys((a.inputSchema && a.inputSchema.properties) || {}).length;
      const modelTI = isPlainObjectValue(a.testInput)
        ? ((Object.keys(a.testInput).length > 0 || inPropCount === 0) ? a.testInput : null)
        : null;
      const proposedTestInput = modelTI || (liveHasValues ? liveTestInput : (priorHasValues ? priorTI : null));
      // Dedup: a contract the user already confirmed is NOT re-prompted while
      // its shape is unchanged (rejections of revisions leave the original
      // standing). Only a materially different proposal pops the panel again.
      const incoming = { input: schemaShape(a.inputSchema), output: schemaShape(a.outputSchema) };
      const priorShape = ioConfirmedShape || ledgerConfirmedShape(ctx);
      // Forty-sixth log: same-shape dedup survives ONLY while the test
      // request values are unchanged too — re-proposing new test values is a
      // MATERIAL change the user must bless, even with identical schemas.
      const priorTestInput = ioConfirmedTestInput || ledgerConfirmedTestInput(ctx);
      const testInputUnchanged = testInputKey(proposedTestInput) === testInputKey(priorTestInput);
      if (ioContractConfirmed(ctx) && priorShape &&
          priorShape.input === incoming.input && priorShape.output === incoming.output &&
          testInputUnchanged) {
        ioConfirmed = true; // resume path: the runtime flag catches up
        ioConfirmedShape = incoming;
        // A same-shape re-proposal carries the full schemas — capture them
        // too (legacy markers stored shape only; this is the recovery path
        // by which a resumed legacy session starts attaching the contract).
        ioConfirmedSchemas = { inputSchema: a.inputSchema, outputSchema: a.outputSchema };
        if (proposedTestInput) ioConfirmedTestInput = proposedTestInput;
        if (ioConfirmedTestInput) ioConfirmedTestInputShape = incomingInputShape;
        const recoveredAttached = attachConfirmedSchemas(ioConfirmedSchemas);
        return {
          confirmed: true,
          note: 'contract already confirmed — same contract, proceeding without re-prompting the user'
            + (recoveredAttached ? '; recovered schemas applied to the current artifact' : '')
        };
      }
      const sess = (ctx && ctx.session) || null;
      let res;
      if (sess && typeof sess.parkBegin === 'function') sess.parkBegin('io.confirm', typeof a.note === 'string' ? a.note.slice(0, 200) : 'contract confirmation');
      try {
        // Thirty-first log: a renegotiation must show the user WHAT changes
        // against the confirmed contract (a field leaving items.required is
        // losing its REQUIRED_FIELD_EMPTY guarantee) — not raw JSON only.
        const priorSchemas = ioConfirmedSchemas || ledgerConfirmedSchemas(ctx);
        const diffLines = (priorSchemas && priorSchemas.outputSchema)
          ? contractDiffLines(priorSchemas.outputSchema, a.outputSchema)
          : [];
        res = await bridge.request({
          inputSchema: a.inputSchema,
          outputSchema: a.outputSchema,
          testInput: proposedTestInput || {},
          // F7(c): whether the MODEL supplied testInput on this proposal —
          // the wizard-side second-layer prefill substitutes its stored
          // values ONLY when this is false.
          testInputProvided: modelTI != null,
          note: typeof a.note === 'string' ? a.note : '',
          diffLines: diffLines
        });
      } finally {
        if (sess && typeof sess.parkEnd === 'function') sess.parkEnd();
      }
      if (res && res.confirmed) {
        ioConfirmed = true;
        ioConfirmedShape = { input: schemaShape(a.inputSchema), output: schemaShape(a.outputSchema) };
        ioConfirmedSchemas = { inputSchema: a.inputSchema, outputSchema: a.outputSchema };
        // The panel may return user-EDITED values; they win over the
        // proposal (the user is the authority on test request parameters).
        // Legacy bridges that resolve without testInput keep the proposal.
        const userTestInput = isPlainObjectValue(res.testInput) ? res.testInput : null;
        const confirmedTestInput = userTestInput || proposedTestInput || null;
        ioConfirmedTestInput = confirmedTestInput;
        ioConfirmedTestInputShape = incomingInputShape;
        const ledger = (ctx && ctx.ledger) || null;
        if (ledger) {
          try {
            ledger.add({
              finding: IO_LEDGER_MARKER + ' — inputs: [' + Object.keys((a.inputSchema && a.inputSchema.properties) || {}).join(', ') +
                '] outputs: [' + Object.keys((a.outputSchema && a.outputSchema.properties) || {}).join(', ') +
                '] schemas: ' + JSON.stringify({ inputSchema: a.inputSchema, outputSchema: a.outputSchema }) +
                ' shape: ' + JSON.stringify({ input: incoming.input, output: incoming.output }) +
                (confirmedTestInput ? ' testInput: ' + JSON.stringify(confirmedTestInput) : ''),
              evidence: 'io.confirm (user approved the proposed contract' + (userTestInput ? ' and test request values' : '') + ')',
              confidence: 'high',
              provenance: 'user',
              selectors: []
            });
          } catch (e) { /* ledger secondary — the runtime flag already holds */ }
        }
        const attachedNow = attachConfirmedSchemas(ioConfirmedSchemas);
        const attachedTI = attachConfirmedTestInput(confirmedTestInput);
        return {
          confirmed: true,
          note: 'contract approved — author the steps and call service.update (schemas optional: the confirmed contract attaches automatically)'
            + (confirmedTestInput ? '; test request parameters confirmed: ' + JSON.stringify(confirmedTestInput) : '')
            + (attachedNow ? '; amended contract applied to the current artifact — verify.run scores against it now' : '')
            + (attachedTI ? '; confirmed test values applied to the current artifact' : '')
        };
      }
      return {
        confirmed: false,
        feedback: String((res && res.feedback) || '(no revision note)'),
        note: 'user requested changes — revise the schemas, then call io.confirm again'
      };
    }

    // Harness 对标（2026-09-11 用户指示 ①）：人类传感器。研究过程感知不到
    // 页面行为（弹层是否真的可见挂载、登录/地区差异、两次运行条数不同）
    // 时随时问用户——一个用户观察胜过数轮盲探，且等待不消耗会话时钟。
    async function userObserve(args, ctx) {
      const a = args && typeof args === 'object' ? args : {};
      const q = typeof a.question === 'string' ? a.question.trim() : '';
      if (!q) return { error: 'question (required) — what you want the user to look at on the page, phrased for a human (e.g. "hover the first post timestamp — does a tooltip with a full date appear?")' };
      if (!d.observeBridge || typeof d.observeBridge.request !== 'function') {
        return { error: 'user observation bridge not wired in this host' };
      }
      const sess = (ctx && ctx.session) || null;
      if (sess && typeof sess.parkBegin === 'function') sess.parkBegin('user.observe', q.slice(0, 200));
      let res;
      try {
        // Code-review P3 (reliability): a bridge crash (panel DOM missing,
        // chrome error) must degrade into a tool-level error teaching the
        // fallback — an unhandled rejection here would kill the whole turn.
        res = await d.observeBridge.request({ question: q.slice(0, 500), hint: typeof a.hint === 'string' ? a.hint.slice(0, 300) : '' });
      } catch (e) {
        return { error: 'observe bridge failed: ' + String((e && e.message) || e) + ' — fall back to probing, never guess' };
      } finally {
        if (sess && typeof sess.parkEnd === 'function') sess.parkEnd();
      }
      // F14: a cancel REASON from the bridge (e.g. 'superseded' by a newer
      // request) propagates — the model reading "superseded" retries the
      // observation instead of concluding the user dismissed it.
      if (!res || res.cancelled) return { cancelled: true, note: (res && typeof res.note === 'string' && res.note) ? res.note : 'user dismissed the question — fall back to probing, never guess' };
      const ledger = (ctx && ctx.ledger) || null;
      if (ledger && res.answer) ledger.add({ finding: 'user observation: ' + q + ' → ' + String(res.answer).slice(0, 300), evidence: 'user.observe', confidence: 'high', provenance: 'user', selectors: [] });
      return { answer: String(res.answer || '') };
    }

    // Fifty-second log: five identical consecutive verify disclosures
    // (location 5/5, hoverCards[].role 10/10, postTime relative) burned the
    // whole 60-turn budget with zero research-tab probes between updates —
    // the model re-verified the same broken shape and nothing told it the
    // loop was stuck. Track the disclosure signature across verify.run calls
    // (per session-tools instance = per session) and fire an advisory on the
    // THIRD identical consecutive signature.
    let verifySignatureHistory = [];
    let probesSinceLastVerify = 0;

    // Fifty-second log: wrap every probe so the stagnation census can see
    // research activity between verifies.
    function wrapProbe(fn) {
      return async function (args, ctx) {
        probesSinceLastVerify += 1;
        return fn(args, ctx);
      };
    }

    async function verifyRun(args, ctx) {
      const service = d.getDraftService();
      if (!service || !Array.isArray(service.steps) || !service.steps.length) {
        return { error: 'no artifact yet — author the step graph and call service.update first' };
      }
      const a = args && typeof args === 'object' ? args : {};
      const input = (a.input && typeof a.input === 'object' && !Array.isArray(a.input)) ? a.input : d.getTestInput();
      // Twenty-first log: an artifact authored before confirmation (or a
      // resumed session whose wizardState lost the schema) verifies
      // SCHEMA-BLIND. The confirmed contract is the authority the user
      // signed off on — fall back to it when the artifact carries no
      // outputSchema.
      const outputSchema = d.getOutputSchema() ||
        ((ioConfirmedSchemas || ledgerConfirmedSchemas(ctx) || {}).outputSchema) || null;
      const out = await d.runVerify({ service: service, input: input, outputSchema: outputSchema });
      lastVerify = { events: out.events || [], report: out.report, raw: out.raw, at: Date.now() };
      const report = out.report || {};
      // Fifty-second log stagnation census: the signature is the sorted
      // partial-empty paths+counts, the junk field set, and the relative
      // timestamp paths — unchanged across three consecutive verifies means
      // the current approach is not moving these fields.
      //
      // Sixty-second log: exact-signature equality was too brittle — the
      // incident session ran three reds (v3/v4/v5) all failing the SAME
      // REQUIRED_FIELD_EMPTY gate on the same 4/4-empty fields, but an
      // OPTIONAL field flapped across the empty-ratio threshold between runs
      // (hoverExtensions 2/4 → 0/4 → 2/4), so no two signatures were
      // byte-identical and the streak never formed. The stagnation question
      // is about the PERSISTENT core, not the flapping periphery: fire when
      // the last three verifies SHARE disclosure entries (set intersection),
      // and name the shared entries — fields stuck across all three verifies
      // are exactly the ones "not moving". Monotone progress still escapes
      // (a fixed field drops out of the intersection), and the fifty-sixth
      // all-empty guard is preserved structurally (empty signatures
      // intersect to nothing).
      try {
        const det = report.detectors || {};
        const pe = Array.isArray(det.partialEmptyFields) ? det.partialEmptyFields
          .map((f) => String(f.path || f.field) + ':' + (f.emptyCount != null ? f.emptyCount : '?') + '/' + (f.totalCount != null ? f.totalCount : '?')) : [];
        const jf = det.junkValues && Array.isArray(det.junkValues.fields) ? det.junkValues.fields.map((f) => String(f.field)) : [];
        const rt = Array.isArray(det.relativeTimestamps) ? det.relativeTimestamps.map((f) => String(f.path || f.field)) : [];
        const sig = { pe: pe.slice().sort(), jf: jf.slice().sort(), rt: rt.slice().sort() };
        verifySignatureHistory.push(sig);
        if (verifySignatureHistory.length > 6) verifySignatureHistory.shift();
        const lastThree = verifySignatureHistory.slice(-3);
        if (lastThree.length === 3) {
          const intersect = (key) => lastThree[0][key].filter((x) =>
            lastThree[1][key].indexOf(x) !== -1 && lastThree[2][key].indexOf(x) !== -1);
          const commonPe = intersect('pe');
          const commonJf = intersect('jf');
          const commonRt = intersect('rt');
          if (commonPe.length || commonJf.length || commonRt.length) {
            const lines = commonPe.length
              ? commonPe.join(', ')
              : (commonJf.length ? ('junk: ' + commonJf.join(', ')) : commonRt.join(', '));
            report.stagnationNote = 'STAGNANT_DISCLOSURES: the THIRD consecutive verify.run still discloses these PERSISTENT entries (' + lines + ') — they have not moved across three verifies, so re-verifying this artifact shape cannot fix them. Pick ONE exit: (a) probe the NAMED records/fields on the RESEARCH tab (it is still open — probe.sample/probe.attrStats/probe.labelledby on the empty/junk fields\' elements) and fix the selector/assembly from evidence; (b) renegotiate the contract via io.confirm (drop or adjust fields the page genuinely lacks); (c) accept and disclose honestly in finish. Do not call verify.run again before doing (a) or (b).' +
              (probesSinceLastVerify === 0 ? ' Note: you have not run a single research-tab probe between these verifies.' : '');
            report.events = Array.isArray(report.events) ? report.events.concat(['STAGNANT_DISCLOSURES']) : ['STAGNANT_DISCLOSURES'];
          }
        }
      } catch (_) { /* the stagnation census must never break the verify result */ }
      probesSinceLastVerify = 0;
      return report;
    }

    // Contract-state analysis view (twenty-first log, per the analysis-tools
    // principle): the model's recurring question — "will my verify be
    // schema-blind?" — answered from state, not inference. Available BEFORE
    // any verify run; it is a census, not a post-mortem.
    function contractView(ctx) {
      const confirmed = ioContractConfirmed(ctx);
      const confirmedSchemas = ioConfirmedSchemas || ledgerConfirmedSchemas(ctx);
      const artifactSchema = (typeof d.getOutputSchema === 'function') ? d.getOutputSchema() : null;
      const view = {
        confirmed: confirmed,
        artifactOutputSchema: artifactSchema ? 'present' : 'MISSING',
        verifyWillBeSchemaBlind: !artifactSchema && !confirmedSchemas
      };
      if (confirmedSchemas) {
        view.confirmedOutputFields = Object.keys((confirmedSchemas.outputSchema && confirmedSchemas.outputSchema.properties) || {});
        if (!artifactSchema) {
          view.hint = 'the confirmed contract is not in the artifact yet — a service.update with steps ONLY attaches the confirmed schemas automatically; a schema-only service.update also works against the existing artifact';
        }
      } else if (confirmed) {
        view.hint = 'this confirmation predates full-schema capture (legacy session) — re-propose the SAME contract via io.confirm: a same-shape proposal auto-confirms without prompting and captures the full schemas';
      } else {
        view.hint = 'no confirmed contract yet — call io.confirm({inputSchema, outputSchema}) before service.update';
      }
      return { contract: view };
    }

    async function diagRead(args, ctx) {
      const a = args && typeof args === 'object' ? args : {};
      const kind = typeof a.kind === 'string' && a.kind ? a.kind : 'all';
      if (kind === 'contract') return contractView(ctx);
      if (!lastVerify) return { error: 'no verify run yet in this session — run verify.run first' };
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
      if (kind === 'all' || kind === 'unusedCaptures') {
        const uc = (lastVerify.report && lastVerify.report.detectors && lastVerify.report.detectors.unusedCaptures) || null;
        if (uc) out.unusedCaptures = uc;
        else if (kind === 'unusedCaptures') out.unusedCaptures = null;
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
      if (sess && typeof sess.parkBegin === 'function') sess.parkBegin('annotate.request', 'annotation window');
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

    // Twenty-first log: the DRIFT rejection used to name the drifted schema
    // but withhold the confirmed one — "resend exactly these schemas" was
    // unanswerable, and nine turns burned trying. Embed the confirmed
    // schemas verbatim and give both repair paths.
    function driftTeaching(drift, ctx) {
      const confirmedNow = ioConfirmedSchemas || ledgerConfirmedSchemas(ctx);
      return 'I/O CONTRACT DRIFT — ' + drift.join(' and ') +
        ' differ materially from the contract the user confirmed (fields added/removed/renamed or types changed; cosmetic description edits are fine).' +
        (confirmedNow ? ' The user-confirmed schemas, verbatim: ' + JSON.stringify(confirmedNow) + '.' : '') +
        ' Either resend service.update with steps ONLY (omit the schemas — the confirmed contract attaches to the artifact automatically), or, if the field list itself must change, call io.confirm with the NEW schemas and wait for the user.';
    }

    // Forty-sixth log: adopting DIFFERENT test request values changes what
    // every verify.run executes and what the deployed service defaults to —
    // the user blessed specific values at io.confirm, so a differing
    // testInput at service.update is a MATERIAL contract change that must be
    // re-confirmed. Returns a teaching error string or null.
    function testInputDriftError(a, ctx) {
      if (a.testInput == null) return null;
      if (!isPlainObjectValue(a.testInput)) {
        return 'TEST_INPUT_NOT_OBJECT: testInput must be a plain object of request parameter values like {"keyword":"machine learning","count":5}, not ' + JSON.stringify(a.testInput) + '.';
      }
      const confirmedTI = ioConfirmedTestInput || ledgerConfirmedTestInput(ctx);
      if (!confirmedTI) return null; // parameterless service / legacy pre-F1 confirmation — lenient
      if (testInputKey(a.testInput) === testInputKey(confirmedTI)) return null;
      return 'TEST_INPUT_UNCONFIRMED: the test request parameters differ from the ones the user confirmed (' +
        JSON.stringify(confirmedTI) + '). These values drive every verify.run and the deployed service\'s default input, so different values need the user\'s blessing: re-confirm with io.confirm({inputSchema, outputSchema, testInput: ' +
        JSON.stringify(a.testInput) + ', note: "why the test values change"}) — the SAME schemas, the NEW testInput — then resend this update.';
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
      // Fifty-second log: stray field declarations (schema-shaped objects
      // sitting OUTSIDE properties) must not land here either — same blind
      // spot as above, one level subtler.
      if (a.outputSchema != null && typeof WU.detectSchemaPlaceholderFields === 'function') {
        const updStubs = WU.detectSchemaPlaceholderFields(a.outputSchema);
        if (updStubs) {
          return {
            error: 'PLACEHOLDER_SCHEMA: outputSchema contains unfilled stub field(s) — ' +
              updStubs.map((h) => h.field + ' (' + h.problems.join('; ') + ').').join(' ') +
              ' Fill every field with a real JSON-Schema type and description, then re-send.'
          };
        }
      }
      if (a.outputSchema != null && typeof WU.detectStrayFieldDeclarations === 'function') {
        const updStrays = WU.detectStrayFieldDeclarations(a.outputSchema);
        if (updStrays) {
          const allS = [];
          for (const h of updStrays) allS.push.apply(allS, h.strays);
          return {
            error: 'SCHEMA_STRAY_FIELD_DECLS: outputSchema declares field definition(s) OUTSIDE "properties" — [' + Array.from(new Set(allS)).sort().join(', ') + '] at ' + updStrays.map((h) => h.at).join('; ') + '. Stray declarations are invisible to every schema-driven gate (scoring, empty/junk censuses, the never-extracted lint). Move them under the parent object\'s "properties" and re-send (io.confirm again if the contract is changing).'
          };
        }
      }
      // Runtime-flag path: a materially different contract must be
      // re-confirmed. The ledger-marker recovery path (session resume /
      // reload) intentionally skips this — the user is already driving
      // those continuations via feedback.
      if (ioConfirmed && ioConfirmedShape && (a.inputSchema != null || a.outputSchema != null)) {
        const drift = [];
        if (a.inputSchema != null && schemaShape(a.inputSchema) !== ioConfirmedShape.input) drift.push('inputSchema');
        if (a.outputSchema != null && schemaShape(a.outputSchema) !== ioConfirmedShape.output) drift.push('outputSchema');
        if (drift.length) return { error: driftTeaching(drift, ctx) };
      }
      // Forty-sixth log: test request values are user-confirmed alongside
      // the schemas — a differing testInput (adoption or steps-bearing) is
      // rejected here, before any branch that could apply it.
      const tiErr = testInputDriftError(a, ctx);
      if (tiErr) return { error: tiErr };
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
      // Twenty-first log: a steps-less schema-only amendment — the model
      // landing the confirmed contract into an artifact authored without
      // schemas (turn 57 of that log, previously rejected with "steps
      // (non-empty array) required"). The DRIFT gate above has already
      // rejected a mismatched shape by this point, so whatever arrives here
      // matches the confirmed contract (or rides the lenient legacy-resume
      // path, same as every other amendment).
      if (!steps.length && (a.inputSchema != null || a.outputSchema != null)) {
        if (!currentSteps.length) {
          return { error: 'no artifact yet — a schema-only update needs an existing step graph; author it with service.update({steps,...}) first' };
        }
        const confirmedNow = ioConfirmedSchemas || ledgerConfirmedSchemas(ctx);
        const amend = { steps: currentSteps };
        if (a.inputSchema != null) amend.inputSchema = a.inputSchema;
        else if (confirmedNow && confirmedNow.inputSchema) amend.inputSchema = confirmedNow.inputSchema;
        if (a.outputSchema != null) amend.outputSchema = a.outputSchema;
        else if (confirmedNow && confirmedNow.outputSchema) amend.outputSchema = confirmedNow.outputSchema;
        try {
          d.applyArtifact(amend);
          if (lastVerify) lastVerify.staleArtifact = true;
        } catch (e) {
          return { error: 'artifact apply failed: ' + String((e && e.message) || e) };
        }
        return { updated: true, schemasAttached: true, note: 'schemas applied to the current artifact — run verify.run again before finishing' };
      }
      // Twentieth log: the engine wrapper used to reject every steps-less
      // call before this branch existed — a waiver the model sent alone
      // (as the tool spec and the grounding-gate suggestion both describe)
      // failed with "steps (non-empty array) required" and burned turns.
      // Waivers are recorded stickily by the engine; this branch just
      // acknowledges the amendment against the current artifact.
      if (!steps.length && a.overrides != null && a.testInput == null) {
        if (!currentSteps.length) {
          return { error: 'no artifact yet — a steps-less waiver needs an existing step graph; author it with service.update({steps,...}) first' };
        }
        return { updated: true, waiverRecorded: true, note: 'waiver recorded against the current artifact — it stays in force for later service.update calls in this session' };
      }
      const chain = WU.validateChain(steps);
      if (!chain || chain.valid !== true) {
        return { error: 'step chain invalid: ' + String((chain && chain.error) || 'validation failed') };
      }
      // Thirtieth log: `const n = $count(sel)` without await passes chain
      // validation and lands — then burns turns at verify with a misleading
      // POLL_EXHAUSTED (n holds a Promise, `n > 0` is false forever). Lint
      // every incoming step script and put the hits in the receipt as a
      // NON-BLOCKING advisory — the artifact still applies; verify-runner's
      // failure-time arm remains the backstop for anything that slips past.
      const staticLint = [];
      if (typeof WU.detectUnawaitedDollarCalls === 'function') {
        for (const s of steps) {
          for (const h of WU.detectUnawaitedDollarCalls(String((s && s.script) || ''))) {
            staticLint.push('step "' + ((s && s.name) || String(s && s.id)) + '": ' + h.api + '() called without await — a bare $ call returns a Promise, so every comparison on it is false/undefined forever; add await (near: ' + h.near + ')');
          }
        }
      }
      // Fifty-seventh log: invented Playwright-style pseudo-classes
      // (:textless — the fifty-first log had :textish) inside service
      // selectors; browsers reject them at querySelectorAll time. Same
      // advisory-only contract as the un-awaited-$ lint above.
      if (typeof WU.detectNonStandardPseudoSelectors === 'function') {
        for (const h of (WU.detectNonStandardPseudoSelectors(steps) || [])) {
          staticLint.push('step "' + String(h.stepId) + '": non-standard pseudo-class ' + h.pseudo + ' in a selector — browsers reject it at query time. STANDARD CSS ONLY: express text-matching with attribute selectors ([aria-label*=…], [href*=…]) or structural pseudos (:has/:not/:nth-of-type). Playwright-only pseudo-classes (near: ' + h.near + ') do not exist in querySelectorAll.');
        }
      }
      // Thirty-first log: comments/shares shipped as `comments: "", shares:
      // ""` hardcoded literals — schema record fields no step ever extracts.
      // Verify stayed green (a literal satisfies shape checks) and only the
      // user noticed. Name the pattern at landing time, same advisory-only
      // contract as the un-awaited-$ lint above.
      // Forty-second log: use VERIFY's schema precedence — artifact first,
      // confirmed contract as fallback. A resumed service carries its full
      // schema on the artifact while the session confirms nothing, and the
      // lint read only the confirmed contract: verify's partial-empty census
      // enumerated posts.location from the artifact schema while the lint
      // stayed blind to the very `location:''` literal it exists to name. A
      // DEGRADED artifact schema (no .properties — the pre-confirmation
      // placeholder) must not shadow a rich confirmed contract, so only a
      // properties-bearing artifact schema takes precedence.
      const lintArtifactSchema = (typeof d.getOutputSchema === 'function') ? d.getOutputSchema() : null;
      const lintArtifactUsable = !!(lintArtifactSchema && lintArtifactSchema.properties && typeof lintArtifactSchema.properties === 'object' && !Array.isArray(lintArtifactSchema.properties));
      const lintSchema = (a.outputSchema != null) ? a.outputSchema
        : ((lintArtifactUsable ? lintArtifactSchema : null)
          || (ioConfirmedSchemas || ledgerConfirmedSchemas(ctx) || {}).outputSchema) || null;
      if (lintSchema && typeof WU.detectNeverExtractedFields === 'function') {
        for (const f of WU.detectNeverExtractedFields(steps, lintSchema)) {
          staticLint.push('schema field "' + f.path + '" appears ONLY as hardcoded string literal(s) in the step scripts — no step extracts it (no fieldMap entry, no assignment). A literal verifies green while carrying no data: bind the field in a fieldMap or compute it, or renegotiate the contract with io.confirm if the page genuinely lacks it.');
        }
      }
      // Fortieth log: two sessions in a row hand-wrote
      // `r.popoverHtml || r.__popover.html` off $extractWithHover records —
      // a field that does not exist — and shipped hoverCards:[] while the
      // popovers mounted fine (the user watched them). The envelope was
      // undocumented, so the invented name is understandable but
      // categorically empty; reject at landing with the envelope spelled
      // out (compile-error class, not a heuristic).
      for (const s of steps) {
        const src = String((s && s.script) || '');
        if (src.indexOf('$extractWithHover') !== -1 && /(\.popoverHtml\b|__popover\b)/.test(src)) {
          return {
            error: 'EXTRACT_WITH_HOVER_FIELD_MISS: step "' + ((s && s.name) || String(s && s.id)) + '" reads `.popoverHtml`/`__popover` off an $extractWithHover record — no such field exists, so the hover-card output is structurally ALWAYS empty (popovers can mount perfectly and the record still carries nothing). $extractWithHover returns one record per container; each record carries its hover results in `hovercards[]`, one entry per matched anchor: {hovered, htmlSnippet, popoverSelector, reason, observedPopover, anchorIndex, anchorHref, anchorText, labelledbyText, labelledbyAttr}. Build the output hover-card fields from r.hovercards — htmlSnippet is the captured popover DOM, anchorHref/anchorText tell you WHICH anchor produced it, and labelledbyText is the anchor\'s accessible label (aria-labelledby/aria-describedby referenced text, harvested at dwell time — the full tooltip value for label anchors like timestamps).'
          };
        }
      }
      try {
        // Twenty-first log: the confirmed contract must land in the artifact
        // even when the update omits schemas (steps-only updates were the
        // norm — and left the artifact SCHEMA_BLIND at verify). Fill any
        // absent schema with the confirmed one before applying.
        const confirmedNow = ioConfirmedSchemas || ledgerConfirmedSchemas(ctx);
        const merged = Object.assign({}, a);
        let attached = false;
        if (confirmedNow) {
          if (merged.inputSchema == null && confirmedNow.inputSchema) { merged.inputSchema = confirmedNow.inputSchema; attached = true; }
          if (merged.outputSchema == null && confirmedNow.outputSchema) { merged.outputSchema = confirmedNow.outputSchema; attached = true; }
        }
        // Fiftieth log: the confirmed TEST VALUES must land too. When the
        // contract was confirmed before any artifact existed,
        // attachConfirmedTestInput deferred with "service.update attaches on
        // landing" — but the landing merge filled only schemas, so the
        // artifact shipped without testInput and the first verify.run (no
        // override) died on "Missing URL template parameter". Same merge
        // precedent as the schemas: fill it when the update omits it.
        let attachedTestInput = false;
        if (merged.testInput == null) {
          const confirmedTI = ioConfirmedTestInput || ledgerConfirmedTestInput(ctx);
          const currentTI = (typeof d.getTestInput === 'function') ? d.getTestInput() : null;
          if (confirmedTI && testInputKey(currentTI) !== testInputKey(confirmedTI)) {
            merged.testInput = confirmedTI;
            attachedTestInput = true;
          }
        }
        d.applyArtifact(merged);
        if (lastVerify) lastVerify.staleArtifact = true;
        if (attached || attachedTestInput) {
          const st = ctx && ctx.session ? ctx.session.state() : null;
          const version = (st && st.session && Array.isArray(st.session.artifactVersions))
            ? st.session.artifactVersions.length + 1
            : 1;
          const parts = [];
          if (attached) parts.push('the confirmed I/O contract was attached (your update omitted schemas) — verify.run now scores against it');
          if (attachedTestInput) parts.push('the confirmed test request values were attached (your update omitted testInput) — verify.run WITHOUT an override now runs them');
          return Object.assign({ updated: true, version: version, schemasAttached: attached, testInputAttached: attachedTestInput, note: parts.join('; ') }, staticLint.length ? { staticLint: staticLint } : {}, endgameWarning(ctx));
        }
      } catch (e) {
        return { error: 'artifact apply failed: ' + String((e && e.message) || e) };
      }
      const st = ctx && ctx.session ? ctx.session.state() : null;
      const version = (st && st.session && Array.isArray(st.session.artifactVersions))
        ? st.session.artifactVersions.length + 1
        : 1;
      return Object.assign({ updated: true, version: version }, staticLint.length ? { staticLint: staticLint } : {}, endgameWarning(ctx));
    }

    // Sixty-seventh log: the final turns wrote artifact v7 that could never
    // be verified — 8 blind service.update calls with zero probe.snippet
    // uses burned the whole 60-turn budget. When the endgame is in sight
    // (≤2 turns left), the update receipt itself warns that an unverifiable
    // rewrite leaves CURRENT ARTIFACT UNVERIFIED and routes toward the next
    // verify.run or an honest finish.
    function endgameWarning(ctx) {
      const spend = ctx && ctx.session && ctx.session.spend;
      const budgets = ctx && ctx.session && ctx.session.budgets;
      if (!spend || !budgets || typeof spend.turns !== 'number' || typeof budgets.maxTurns !== 'number') return {};
      // Sixty-ninth review F5 (off-by-one): spend.turns counts turns ALREADY
      // taken including THIS one — after THIS update N = maxTurns -
      // spend.turns - 1 remain. The old `turnsLeft > 2` gate fired a
      // "N left" warning the turn BEFORE the last usable verify and said
      // "0 left" on the still-usable last turn.
      const afterThis = Math.max(0, budgets.maxTurns - spend.turns - 1);
      if (afterThis > 2) return {};
      if (afterThis >= 1) {
        return { warning: 'after this update ' + afterThis + ' turn(s) remain — the next verify.run costs 1; an update you cannot verify leaves CURRENT ARTIFACT UNVERIFIED; prefer refining toward the next verify.run, or finish honestly with disclosed limits' };
      }
      return { warning: 'this is the LAST turn — no verify can follow this update; prefer finishing honestly with disclosed limits over an unverifiable rewrite' };
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

    // Thirty-sixth log RC-E: the session had no wait/settle tool — the
    // model probed an unhydrated shell repeatedly (page.open reported
    // ready:true on a splash-scripts-only body) and burned ~8 turns
    // concluding "empty page" while client rendering was still in flight.
    // Settle = one $waitForStable poll over the page body (or a narrower
    // sel) plus a text census, with a receipt. Pure composition over the
    // DSL — no new page-side code.
    async function pageSettle(args) {
      const a = (args && typeof args === 'object') ? args : {};
      const sel = (typeof a.sel === 'string' && a.sel.trim()) ? a.sel.trim() : 'body';
      const maxMs = (typeof a.timeoutMs === 'number' && a.timeoutMs > 0)
        ? Math.min(Math.round(a.timeoutMs), 60000) : 15000;
      const startedAt = Date.now();
      const snippet =
        'var st = await $waitForStable(' + JSON.stringify(sel) + ', { interval: 800, stableChecks: 3, maxMs: ' + maxMs + ' });' +
        'var chars = null; var textHead = null;' +
        'try { var t = await $extract(' + JSON.stringify(sel) + ', null, 3000); chars = (t || "").length; textHead = (t || "").slice(0, 200); } catch (e) { /* census best-effort */ }' +
        'return { settled: st === true, chars: chars, textHead: textHead };';
      const env = await d.rail.executeDsl(snippet);
      if (env && typeof env === 'object' && typeof env.error === 'string') {
        return { error: env.error + ' — settle needs an open page; call page.open first' };
      }
      let r = null;
      if (env && typeof env === 'object' && !Array.isArray(env) && env.result && typeof env.result === 'object') r = env.result;
      else if (env && typeof env === 'object' && !Array.isArray(env) && typeof env.settled !== 'undefined') r = env;
      if (!r) return { error: 'settle failed: unexpected DSL result' };
      const out = {
        settled: r.settled === true,
        sel: sel,
        chars: (typeof r.chars === 'number') ? r.chars : null,
        waitedMs: Date.now() - startedAt
      };
      if (typeof r.textHead === 'string' && r.textHead) out.textHead = r.textHead;
      lateBoundLog.record({ tool: 'page.settle', selectors: [sel], summary: 'settled=' + out.settled + ' chars=' + out.chars });
      if (!out.settled) {
        out.note = 'content never stabilized within ' + maxMs + 'ms' +
          ((out.chars !== null && out.chars < 200)
            ? ' and the body is only ' + out.chars + ' chars — likely an UNHYDRATED SHELL (client JS still rendering). Re-run page.settle with a larger timeoutMs, or probe.scroll to force lazy loading, before concluding the page is empty'
            : ' (it may still be streaming — re-run page.settle or probe the population directly)');
      }
      return out;
    }

    const tools = {
      'page.open': pageOpen,
      'page.state': d.rail.pageState,
      'page.settle': pageSettle,
      // Fifty-second log: the stagnation advisory needs to know whether ANY
      // research-tab probe ran between two verifies — a bare update↔verify
      // loop with zero probes is the exact shape that burned 60 turns.
      'probe.count': wrapProbe(probes.count),
      'probe.text': wrapProbe(probes.text),
      'probe.attrStats': wrapProbe(probes.attrStats),
      'probe.labelledby': wrapProbe(probes.labelledby),
      'probe.sample': wrapProbe(probes.sample),
      'probe.hover': wrapProbe(probes.hover),
      'probe.scroll': wrapProbe(probes.scroll),
      'probe.scrollUntil': wrapProbe(probes.scrollUntil),
      'probe.extract': wrapProbe(probes.extract),
      'probe.timestamp': wrapProbe(probes.timestamp),
      'probe.loginState': wrapProbe(probes.loginState),
      'probe.snippet': wrapProbe(probes.snippet),
      'diag.read': diagRead,
      'verify.run': verifyRun,
      'annotate.request': annotateRequest,
      'io.confirm': ioConfirm,
      'user.observe': userObserve,
      'service.update': serviceUpdate
    };

    const toolSpecs = [
      { name: 'page.open', args: '{url?}', returns: '{tabId,url,ready,bodyTextChars?,warning?} — {{param}} placeholders are filled from the test input; a URL that still has one is rejected (never probe the literal placeholder page). bodyTextChars censuses the rendered body text: ready:true only means the tab loaded, and a tiny body means an unhydrated shell' },
      { name: 'page.state', args: '{}', returns: '{open,tabId,url,title,status}' },
      { name: 'page.settle', args: '{sel?,timeoutMs?}', returns: '{settled,sel,chars,waitedMs,textHead?,note?} — polls until the content stops changing ($waitForStable over the sel, default body). JS-heavy pages report loaded/ready long BEFORE client rendering fills the body: settle (or re-check bodyTextChars from page.open) before concluding a page is empty' },
      { name: 'probe.count', args: '{sel}', returns: '{count}' },
      { name: 'probe.text', args: '{sel}', returns: '{total,items[]}' },
      { name: 'probe.attrStats', args: '{containerSel, attr}', returns: '{totalItems,values[{value,items,pct}],absentPct,note?} — note appears when absentPct is 100: the attr is not ON the matched elements; :has() sees DESCENDANTS, so census the descendant form containerSel + " [attr]" to know what a :not()/:has() clause actually filters' },
      { name: 'probe.labelledby', args: '{sel, attr?}', returns: '{text,attr,refCount,missingIds?,note?,viaDescendant?} — resolves the ARIA reference attr (default aria-labelledby; pass aria-describedby) on the first match and concatenates the referenced elements\' text; when the match carries NEITHER reference attribute, resolution descends to its first descendant that carries one (viaDescendant + note disclose it). Use it when a tooltip/hovercard value never renders visually: the referenced span is usually hidden but readable' },
      { name: 'probe.sample', args: '{sel, opts:{index,wantHtml,clean}}', returns: '{match,total,element,html?} — clean:true strips scripts/styles/noise from the HTML (prefer it when reading structure)' },
      { name: 'probe.hover', args: '{anchorSel, popoverSel?, opts:{index,timeoutMs}}', returns: '{hovered,htmlSnippet,popoverSelector,popoverSelectorNote?,reason,observedPopover?,rejectedAddedTexts?,budgetNote?,timeoutMs?} — on reason:popover_timeout the result carries the budget it waited (timeoutMs+budgetNote): absence at N ms says nothing about a larger budget, retry with a bigger opts.timeoutMs before concluding the popover never renders' },
      { name: 'probe.scroll', args: "{mode?:'bottom'|'by', sel?, by?}", returns: '{scrolled,prevY,newY} — mode:"by" takes a SIGNED pixel count: negative scrolls UP (re-examine the top of the feed after scrolling down)' },
      { name: 'probe.scrollUntil', args: '{sel, targetCount, maxRounds?, settleMs?, by?, scrollSel?}', returns: '{satisfied,finalCount,targetCount,rounds,trace[{count,y,h}],reason,note?} — one call does the scroll→settle→count loop and stops the MOMENT the sel population reaches targetCount. reason=count_frozen means page height grew while the sel count never moved: the selector matches static page chrome, not the growing population (re-target sel, do not scroll more); reason=at_bottom means the SCROLL ROOT tested is exhausted (window-bottom evidence — when the feed scrolls in an inner overflow container the window sits still while the feed has more; read the note, and retry with scrollSel pointing at the feed\'s own scrollable container); reason=max_rounds means it was still growing (re-run to continue)' },
      { name: 'probe.extract', args: '{containerSel, fieldMap, multi?, allowEmpty?}', returns: '{total,records[3],emptyFields{field:emptyCount}}' },
      { name: 'probe.loginState', args: '{}', returns: '{loggedIn, loginWall, evidence{passwordFields,loginLinks,logoutMarkers}, note} — the generic login/logout marker census. BEFORE concluding "requires login" or "unauthenticated" in any finding or finish, call this and quote the numbers — page shape alone (recommendation cards, empty feeds) is NOT login-state evidence' },
      { name: 'probe.timestamp', args: '{containerSel, anchorSel?, index?}', returns: '{heuristicValue, value(alias), absolute, absoluteSource, relative, candidates[{value,source,relative}], note?} — heuristicValue 是日历通用正则的便捷默认，优先自行判断 candidates 原文（机械-语义分离）；ONE call does the whole timestamp dance on one card: hovers its time-ish anchors, harvests labelledby/aria-label/text (hover-mounted included), and returns date-shaped candidates ONLY, preferring an ABSOLUTE value over a relative age. THE first move whenever postTime comes back relative or junk: try it on one card before rewriting fieldMaps' },
      { name: 'diag.read', args: '{stepId?, kind?}', returns: '{selectorDiagnostics, failingStep?, popover, counters, lastError?} — kind:"contract" (no verify needed) reports whether the I/O contract is confirmed and whether the artifact carries the schemas, so you can see schema-blindness BEFORE verify.run; kind:"unusedCaptures" 返回 verify 报告的未消费弹层捕获普查（原文样本）' },
      { name: 'verify.run', args: '{input?} — optional object overriding the test input for THIS run (the mechanism for alternate-value re-tests when INPUT_VALUE_SUSPECT says the site may have no content for the current value)', returns: '{ok,score,scoreNote?,error,detectors,steps,resultDebug?,finalResult,schemaOk} — detectors.partialEmptyFields lists confirmed fields that came back empty with their emptyRatio (empty/total records): ratio 1 means fix the binding or renegotiate the contract, not ship it. Each entry also carries emptyRecordSamples — WHICH records are empty (1-based ordinal + a content hint from that record; nested paths use parentIndex.subIndex) — so "postId 2/4" becomes "empty: #2 (photo post), #4 (text-only note)": match the named records against steps[].resultPreview, then probe THOSE record shapes on the research tab instead of blind-rewriting the selector. detectors.emptyFieldDiagnostics (beside it) carries per-field falsification crumbs lifted from the owning step\'s LAST iteration diagnostics — an aria reference that resolves to nothing (missingIds), a sub-selector matching 0 containers, an absent attribute — read it BEFORE re-probing: it names WHERE and WHY the empty field died. resultDebug surfaces your step result\'s SMALL non-record keys (debug payloads you attached to the return) ahead of the sampled records, so you can read your own instrumentation. A field you SAW populated on the research tab but empty in verify means the mechanism depends on page state the research tab ACCUMULATED (earlier hovers mounting hidden spans, long dwell hydrating extras) — a fresh load does not reproduce it: re-derive the read on a freshly opened page, do not iterate the same binding blind' },
      { name: 'annotate.request', args: '{why, fields?, containerSel?}', returns: '{annotations[{selector,purpose,outputField}]} | {cancelled} — REQUIRES a confirmed I/O contract (io.confirm first)' },
      { name: 'user.observe', args: '{question, hint?}', returns: '{answer} | {cancelled} — ASK THE USER what they observe on the page when the harness cannot perceive it (popovers that never visibly mount, login/geo variance, count variance between runs). Their eyes are the best sensor available; quote the answer as evidence (it lands in the ledger). AVOID GUESSING page behavior: if two probes disagree or a receipt is blind to what matters, one user.observe beats rounds of blind re-probing. The wait does not consume the session clock.' },
      { name: 'probe.snippet', args: '{code, timeoutMs?}', returns: '{result, truncated?} — run an ARBITRARY $-DSL snippet (async function body, top-level await + return) on the research tab and get the RAW result (JSON, capped). Test-before-artifact: verify extraction/assembly logic here BEFORE writing it into service.update — a broken fieldMap or regex shows its actual output in one call instead of a red verify round. timeoutMs (default 30000, max 90000) sizes the budget to the work: each hovered anchor burns ~5-10s, so a 30-container hover batch needs maxContainers narrowing or a larger timeoutMs — resending the identical oversized snippet cannot change the outcome.' },
      { name: 'io.confirm', args: '{inputSchema, outputSchema, testInput?, note?}', returns: '{confirmed:true} | {confirmed:false, feedback} — propose the contract EARLY and wait for the user; service.update is rejected until a confirmation lands; a SAME-shape re-proposal (schemas AND test values unchanged) auto-confirms without prompting. testInput carries the CONCRETE test request values (e.g. {"keyword":"machine learning","count":5}) — propose the values you actually researched with; the user confirms or edits them in the SAME panel and they become the artifact\'s testInput (omit testInput and the artifact\'s current values are shown for blessing). Changing test values later is a MATERIAL change: service.update({testInput:...}) with values differing from the confirmed ones is rejected with TEST_INPUT_UNCONFIRMED until re-confirmed here. outputSchema MUST declare its fields (properties + required); a fieldless {"type":"object"} verifies blind and is rejected' }
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
