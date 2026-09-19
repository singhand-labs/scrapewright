// extension/lib/verify-runner.js
//
// The verify rail extracted from wizard.js testScript(): orchestrator deps
// (exec lock via the caller's ensureLock, createScrapeTab-with-timeout,
// load+PING readiness, RESET/GET_DOM_ACTIVITY, offscreen executeScript,
// snapshot capture, condition eval), the zero-counter circuit breaker,
// the post-run failure detectors, and the catch-path error augmentation.
// Report-shaped (never throws) so both callers — manual testScript and the
// session verify.run tool — interpret the same contract.
//
// The runner does NOT release the exec lock: release timing belongs to the
// caller's lifecycle (rail holds it across session turns; manual test
// releases in its finally).
//
// IIFE-wrapped per RC30. No site tokens.

(function (global) {

  function resolveLib(requirePath, globalName) {
    if (typeof require !== 'undefined') {
      try { return require(requirePath); } catch (e) { /* fall through */ }
    }
    return (typeof global !== 'undefined' && global[globalName]) || null;
  }

  // wizard-utils: module.exports in Node; individual window/self globals in page contexts.
  // Audit C11: silent sentinel degradation disclosed — __missing lists the
  // functions a host failed to export so the report can say a detector
  // never ran instead of looking complete.
  function resolveWU(forceBag) {
    if (!forceBag) {
      const m = resolveLib('./wizard-utils', '__wizardUtilsModuleMarker__');
      if (m && typeof m.scoreAttemptResult === 'function') return m;
    }
    const w = forceBag || (typeof window !== 'undefined' && window) || global || self;
    const bag = {
      parseCounterFields: w.parseCounterFields,
      isFrozenZeroNotReady: w.isFrozenZeroNotReady,
      FROZEN_ZERO_STREAK_THRESHOLD: w.FROZEN_ZERO_STREAK_THRESHOLD || 8,
      FROZEN_ZERO_MIN_ELAPSED_MS: w.FROZEN_ZERO_MIN_ELAPSED_MS || 60000,
      detectClickInListTotalFailure: w.detectClickInListTotalFailure,
      detectClickInListEmptyContainers: w.detectClickInListEmptyContainers,
      corroborateContainerZero: w.corroborateContainerZero,
      detectHoverAnchorsBlind: w.detectHoverAnchorsBlind,
      detectCountSelectorBlind: w.detectCountSelectorBlind,
      detectFrozenZeroCounter: w.detectFrozenZeroCounter,
      detectFrozenScrollCount: w.detectFrozenScrollCount,
      detectSiblingCountContrast: w.detectSiblingCountContrast,
      detectImplausibleTimeFields: w.detectImplausibleTimeFields,
      detectPositionLikeIds: w.detectPositionLikeIds,
      detectLabelPrefixedCounts: w.detectLabelPrefixedCounts,
      detectJunkShapeRecords: w.detectJunkShapeRecords,
      detectDuplicateIdValues: w.detectDuplicateIdValues,
      detectFieldMatchZero: w.detectFieldMatchZero,
      detectContainerMatchZero: w.detectContainerMatchZero,
      detectEmptyOutputFieldsByRatio: w.detectEmptyOutputFieldsByRatio,
      findEmptyExtractionFields: w.findEmptyExtractionFields,
      findUpstreamExtractionStepId: w.findUpstreamExtractionStepId,
      detectDuplicateRecords: w.detectDuplicateRecords,
      detectDuplicateEntities: w.detectDuplicateEntities,
      detectOversizedFields: w.detectOversizedFields,
      detectCountShortfall: w.detectCountShortfall,
      detectRelativeTimestamps: w.detectRelativeTimestamps,
      extractDateSubstrings: w.extractDateSubstrings,
      hasYearToken: w.hasYearToken,
      looksLikeDate: w.looksLikeDate,
      validateOutputAgainstSchema: w.validateOutputAgainstSchema,
      scoreAttemptResult: w.scoreAttemptResult,
      stripSnapshotsFromTestResult: w.stripSnapshotsFromTestResult,
      sampleRecordsForLLMContext: w.sampleRecordsForLLMContext,
      detectUnawaitedDollarCalls: w.detectUnawaitedDollarCalls,
      emptyFieldDiagnostics: w.emptyFieldDiagnostics,
      detectHtmlFieldsWithoutTags: w.detectHtmlFieldsWithoutTags,
      schemaItemRequiredForPath: w.schemaItemRequiredForPath,
      headTailSlice: w.headTailSlice
    };
    const missing = [];
    for (const k of Object.keys(bag)) {
      if (k.indexOf('FROZEN_') !== 0 && typeof bag[k] !== 'function') { bag[k] = function () { return null; }; missing.push(k); }
    }
    if (missing.length) {
      try { console.warn('[verify-runner] wizard-utils functions unavailable (detectors degraded): ' + missing.join(', ')); } catch (e) { /* warn is best-effort */ }
      bag.__missing = missing;
    }
    // Twenty-ninth log: headTailSlice must degrade to the head-only re-cap
    // at the call site, never to the detector no-op stub — a stubbed slice
    // would null every preview. The stub pass above may have replaced a
    // missing one; settle it to real-function-or-null.
    bag.headTailSlice = typeof w.headTailSlice === 'function' ? w.headTailSlice : null;
    return bag;
  }

  function previewJson(p) {
    try { return JSON.parse(String(p)); } catch (e) { return null; }
  }

  // Tenth-log N2: junk-value census over the extracted records. REPORT-ONLY —
  // structural green (score/schema ok) can hide junk VALUES: bare
  // redirect-query fragments posing as ids, inline data: URIs polluting
  // url/media arrays (UI icons), markup dumps leaking into data fields.
  // Surfaced so the model renegotiates the contract instead of shipping them.
  const URLISH_FIELD = /(url|link|href|src|image|img|media|photo|pic|avatar)/i;
  const RAWISH_FIELD = /(html|markup|raw)/i;
  // Thirty-third log D2: fields whose VALUES are legitimately opaque
  // machine identifiers — the opaqueToken junk heuristic must not fire on
  // them even when the value shape matches a random token.
  const IDISH_FIELD = /(id|hash|token|key|guid|uuid|slug|nonce|signature|checksum|ref)$/i;
  // Thirty-sixth log RC-D: fields that must hold a QUANTITY. When such a
  // field holds a pure-alphabetic string ("Like", "Comment", "赞"), the
  // extractor read the interactive control's own label (aria-label/title
  // of the button) instead of the number it renders — a non-empty value
  // that passes every empty/partial detector while carrying no data.
  const COUNTISH_FIELD = /\b(count|counts|number|num|total|qty|quantity|likes|like|shares|share|comments|comment|replies|reply|views|view|reactions|reaction|votes|vote|stars|star|rating|score)\b/i;

  // Label shape: letters (any script) + separators only, no digits, short
  // enough to be a control label rather than prose.
  function isControlLabel(v) {
    if (typeof v !== 'string') return false;
    const t = v.trim();
    if (!t || t.length > 40) return false;
    if (/\d/.test(t)) return false;
    return /^[\p{L}][\p{L}\s·|,，、]*$/u.test(t);
  }

  // camelCase field names ("likeCount") carry no \b boundary before
  // "Count" — split the case transition so \bcount\b can match.
  const splitFieldName = (k) => String(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();

  function isQueryBlob(v) {
    return typeof v === 'string' && v.length > 3 && /^\?[^=]+=/.test(v);
  }

  // Thirty-third log D2: the live decoy read raw from an anti-scraped
  // textContent ("eporntosdS9u77m62gllh0i16i81a1l5gcf7hg2taf..."). Shape:
  // one long token, letters AND digits interleaved, vowel density far below
  // any human language (~0.27 vs ~0.38+ for English). Values like this in a
  // human-readable field are obfuscation leaking through, not data.
  function isOpaqueToken(v) {
    if (typeof v !== 'string' || v.length < 24) return false;
    if (!/^[A-Za-z0-9_-]+$/.test(v)) return false;
    if (!/[A-Za-z]/.test(v) || !/[0-9]/.test(v)) return false;
    const letters = v.replace(/[^A-Za-z]/g, '');
    if (!letters.length) return false;
    const vowels = (letters.match(/[aeiouAEIOU]/g) || []).length;
    return (vowels / letters.length) < 0.3;
  }

  function isMarkupDump(v) {
    if (typeof v !== 'string' || v.length < 150) return false;
    if (v.trim().charAt(0) !== '<') return false; // audit C9: legit text can contain tags; dumps LEAD with one
    const lt = (v.match(/</g) || []).length;
    const gt = (v.match(/>/g) || []).length;
    return lt >= 3 && gt >= 3;
  }

  function capSample(v) {
    const s = String(v);
    return s.length <= 80 ? s : s.slice(0, 79) + '…';
  }

  // Audit C7/C20: the census now walks nested containers (depth <= 3) so
  // {result:{items:[...]}} is scanned like top-level arrays, and field-name
  // classification ALSO honors schema descriptions (non-English field names
  // escape the English regexes; a description mentioning links/urls or
  // embedded html is a first-class hint).
  function collectFieldHints(schema, re) {
    const names = new Set();
    (function rec(node, depth) {
      if (!node || typeof node !== 'object' || depth > 3) return;
      const props = (node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)) ? node.properties : null;
      if (props) {
        for (const k of Object.keys(props)) {
          const p = props[k];
          const desc = (p && typeof p.description === 'string') ? p.description : '';
          if (re.test(k) || re.test(desc)) names.add(k);
        }
        for (const k of Object.keys(props)) rec(props[k], depth + 1);
      }
      if (node.items) rec(node.items, depth + 1);
    })(schema, 0);
    return names;
  }

  const isUrlishName = (key, hints) => URLISH_FIELD.test(key) || hints.has(key);
  const isRawishName = (key, hints) => RAWISH_FIELD.test(key) || hints.has(key);
  const isIdishName = (key, hints) => IDISH_FIELD.test(key) || hints.has(key);

  function scanRecords(recs, fieldPath, urlishHints, rawishHints, idishHints, fields) {
    const recKeys = [];
    const seen = {};
    for (const r of recs) {
      for (const k of Object.keys(r)) {
        if (!seen[k]) { seen[k] = 1; recKeys.push(k); }
      }
    }
    for (const rk of recKeys) {
      let blobs = 0; let blobSample = '';
      let dataJunk = 0; let dataTotal = 0;
      let dumps = 0; let dumpSample = '';
      let opaque = 0; let opaqueSample = '';
      let labelish = 0; let labelSample = '';
      for (const r of recs) {
        const v = r[rk];
        if (typeof v === 'string') {
          if (isQueryBlob(v)) { blobs += 1; if (!blobSample) blobSample = v; }
          if (!isRawishName(rk, rawishHints) && isMarkupDump(v)) { dumps += 1; if (!dumpSample) dumpSample = v; }
          if (isOpaqueToken(v) && !isIdishName(rk, idishHints) && !isUrlishName(rk, urlishHints) && !isRawishName(rk, rawishHints)) {
            opaque += 1; if (!opaqueSample) opaqueSample = v;
          }
          if (COUNTISH_FIELD.test(splitFieldName(rk)) && isControlLabel(v)) { labelish += 1; if (!labelSample) labelSample = v; }
        } else if (Array.isArray(v)) {
          for (const x of v) {
            if (typeof x !== 'string') continue;
            dataTotal += 1;
            if (x.indexOf('data:') === 0) { dataJunk += 1; }
          }
        }
      }
      if (blobs) fields.push({ field: fieldPath + '.' + rk, kind: 'queryBlob', count: blobs, sample: capSample(blobSample) });
      if (opaque) fields.push({ field: fieldPath + '.' + rk, kind: 'opaqueToken', count: opaque, sample: capSample(opaqueSample) });
      if (dataJunk && isUrlishName(rk, urlishHints)) fields.push({ field: fieldPath + '.' + rk, kind: 'dataUri', junkCount: dataJunk, total: dataTotal });
      if (dumps) fields.push({ field: fieldPath + '.' + rk, kind: 'markupDump', count: dumps, sample: capSample(dumpSample) });
      if (labelish) fields.push({ field: fieldPath + '.' + rk, kind: 'controlLabel', count: labelish, total: recs.length, sample: capSample(labelSample) });
    }
  }

  function detectJunkValues(data, schema) {    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const urlishHints = collectFieldHints(schema, /(url|link|href|src|image|photo|picture|media|avatar)/i);
    const rawishHints = collectFieldHints(schema, /(html|markup|raw source|embedded)/i);
    const idishHints = collectFieldHints(schema, /(id|hash|token|key|guid|uuid|slug|nonce|signature|checksum|ref)$/i);
    const fields = [];
    (function walk(obj, path, depth) {
      if (!obj || typeof obj !== 'object' || depth > 3) return;
      for (const key of Object.keys(obj)) {
        const val = obj[key];
        const fieldPath = path.concat(key).join('.');
        if (Array.isArray(val)) {
          if (!val.length) continue;
          if (val.every((x) => typeof x === 'string')) {
            // top-level url-ish scalar-array: data: entries pollute it the same way
            if (isUrlishName(key, urlishHints)) {
              const junk = val.filter((x) => x.indexOf('data:') === 0).length;
              if (junk > 0) fields.push({ field: fieldPath, kind: 'dataUri', junkCount: junk, total: val.length });
            }
            continue;
          }
          const recs = val.filter((r) => r && typeof r === 'object' && !Array.isArray(r));
          if (recs.length) scanRecords(recs, fieldPath, urlishHints, rawishHints, idishHints, fields);
          for (const r of recs) walk(r, path.concat(key), depth + 1);
        } else if (val && typeof val === 'object') {
          walk(val, path.concat(key), depth + 1);
        }
      }
    })(data, [], 0);
    if (!fields.length) return null;
    return {
      fields: fields,
      note: 'JUNK VALUES: ' + fields.map((f) => f.field + '(' + f.kind + ')').join(', ') +
        '. Structurally green but these values are junk: bare query strings ("?a=b…") are redirect/tracking href fragments, data: URIs inside url/media arrays are inline UI icons, markup dumps are raw HTML leaking into a data field, long single-token opaque strings (random alphanumerics, no spaces, no vowel structure) are anti-scrape DECOYS leaking through a raw textContent read — the real value usually lives in the elements an ARIA reference points at, so re-read the field with the fieldMap labelledby:true option (or $labelledby) instead of textContent — and a count/quantity-typed field holding a pure-alphabetic value ("Like", "Comment", "赞") captured the control label — the interactive button\'s aria-label/title, not the number it renders: the count lives in the element (or attribute) that renders the digit — often a sibling node, an aria-label containing the count ("Liked by 12"), or a title attribute; a label-only control usually means the count is zero. Fix the selector to read the real value, filter arrays in the step script (keep http(s) entries), or renegotiate the contract with io.confirm to drop/redefine the field. A green score with junk-valued fields is NOT a finished service.'
    };
  }

  // Thirty-third log D3: v2's verify populated postingTime 1/2; v3's verify
  // zero-matched it — and the model read the flip as "session-state-dependent,
  // never reproduces on fresh loads", shipping a required field empty. The
  // real difference was the model's OWN v3 load-step edit (early no-growth
  // exit → extract at ~5s instead of ~25s; same cards, same postIds). A field
  // a prior verify POPULATED that comes back fully empty is a regression the
  // step changes likely explain — surface the cross-run delta so
  // "genuinely never exists" has to be earned against it.
  function detectFieldRegression(current, prior, currentVersion) {
    if (!prior || typeof prior !== 'object') return null;
    const curPe = (current && current.detectors && Array.isArray(current.detectors.partialEmptyFields))
      ? current.detectors.partialEmptyFields : [];
    const priPe = (prior.detectors && Array.isArray(prior.detectors.partialEmptyFields))
      ? prior.detectors.partialEmptyFields : [];
    if (!curPe.length || !priPe.length) return null;
    const priorByPath = {};
    for (const p of priPe) {
      if (p && typeof p === 'object' && p.path) priorByPath[String(p.path)] = p;
    }
    const priorVersion = (typeof prior.executedArtifactVersion === 'number')
      ? prior.executedArtifactVersion : null;
    const fields = [];
    for (const c of curPe) {
      if (!c || typeof c !== 'object' || !c.path) continue;
      const total = (typeof c.totalCount === 'number') ? c.totalCount : 0;
      const empty = (typeof c.emptyCount === 'number') ? c.emptyCount : 0;
      if (!(total > 0 && empty === total)) continue; // only fully-empty-now fields
      const p = priorByPath[String(c.path)];
      if (!p) continue;
      const pTotal = (typeof p.totalCount === 'number') ? p.totalCount : 0;
      const pEmpty = (typeof p.emptyCount === 'number') ? p.emptyCount : 0;
      if (!(pTotal > 0 && pEmpty < pTotal)) continue; // was at least partially populated before
      fields.push({
        field: c.field || null,
        path: String(c.path),
        priorEmpty: pEmpty + '/' + pTotal,
        nowEmpty: empty + '/' + total,
        priorVersion: priorVersion,
        priorSample: (Array.isArray(p.sampleNonEmpty) && p.sampleNonEmpty.length)
          ? String(p.sampleNonEmpty[0]).slice(0, 80) : '',
        sameVersion: (priorVersion !== null && priorVersion === currentVersion)
      });
    }
    if (!fields.length) return null;
    const allSame = fields.every((f) => f.sameVersion);
    const note = 'FIELD REGRESSION: ' + fields.map((f) =>
      f.path + ' was non-empty in the ' + (f.priorVersion !== null ? 'v' + f.priorVersion + ' ' : '') +
      'prior verify run (' + f.priorEmpty + ' non-empty' +
      (f.priorSample ? ', sample ' + JSON.stringify(f.priorSample) : '') + ') but is now ' + f.nowEmpty + ' empty. ' +
      (allSame
        ? 'The SAME artifact version flipped populated→empty across two runs — pure timing flakiness (late hydration, render order): add a settle wait or poll-before-extract instead of renegotiating the field away.'
        : 'The artifact CHANGED between those runs — your own step edits (earlier exit conditions, shorter settle, fewer scrolls) are the first suspect, not permanent absence. A field that extracted once can almost always extract again: restore the step shape that last populated it, or add a settle wait before extract, and re-verify BEFORE concluding the value genuinely never exists or shipping it empty.') +
      ' Do not read this regression as "session-state-dependent, never reproduces" without having re-tested the prior step shape.').join(' ');
    return { fields: fields, note: note };
  }

  // Eighteenth log: on a logged-out page that offered ONLY sponsored cards,
  // the session shipped them AS the requested records ("sponsored posts are
  // arguably posts") with the extraction container built ON an ad marker.
  // Report-only: the same marker may legitimately do EXCLUSION work inside
  // :not() — the note asks for the polarity check, not a verdict.
  function detectAdMarkerSelectors(steps) {
    const hits = [];
    for (const s of (Array.isArray(steps) ? steps : [])) {
      const script = String((s && s.script) || '');
      const markers = script.match(/\bdata-ad-[a-z0-9_-]+|\bsponsored\b/gi);
      if (markers && markers.length) {
        const uniq = [];
        for (const m of markers) if (uniq.indexOf(m) === -1) uniq.push(m);
        hits.push({ stepId: s && s.id != null ? s.id : '?', markers: uniq });
      }
    }
    return hits.length ? hits : null;
  }

  function createVerifyRunner(deps) {
    const d = deps || {};
    if (typeof d.orchestrate !== 'function') throw new Error('createVerifyRunner requires an orchestrate(service, input, orchDeps, options) function');
    // Audit C11: a host that failed to export a wizard-utils function used to
    // degrade SILENTLY (sentinel null) — the report looked complete while a
    // detector never ran. Injectable for tests; degradation is disclosed.
    const WU = (d.wizardUtils && typeof d.wizardUtils.scoreAttemptResult === 'function')
      ? resolveWU(d.wizardUtils)
      : resolveWU();
    const wuMissing = (Array.isArray(WU.__missing) && WU.__missing.length) ? WU.__missing : null;
    const RSD = resolveLib('./record-shape-distribution', 'RecordShapeDistribution');
    const log = typeof d.log === 'function' ? d.log : function () {};
    const onEventCb = typeof d.onEvent === 'function' ? d.onEvent : function () {};
    const ensureLock = typeof d.ensureLock === 'function' ? d.ensureLock : async function () {};
    const getSignal = typeof d.getSignal === 'function' ? d.getSignal : () => null;
    const withTimeout = typeof d.withTimeout === 'function'
      ? d.withTimeout
      // dev/test default — clears the loser's timer on settle so pending
      // timeouts cannot hold the event loop open; production callers inject their own
      : (promise, ms, message) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(message)), ms);
          promise.then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); }
          );
        });

    return async function runVerify(opts) {
      const o = opts || {};
      const service = o.service;
      const input = (o.input && typeof o.input === 'object') ? o.input : {};
      const outputSchema = o.outputSchema || { type: 'object' };

      const events = [];
      const zeroCounterStreaks = new Map();
      let zeroCounterBreaker = null;
      const internalAbort = { aborted: false };
      const signalAborted = () => internalAbort.aborted ||
        (getSignal() && getSignal().aborted) || false;

      await ensureLock();
      let tab = null;
      let orchestrationError = null;
      let result = null;

      try {
        result = await d.orchestrate(service, input, {
          createTab: async (url) => {
            // The 10s budget covers only site-independent work (tabs.create +
            // keepalive inject; verify runs detached in scrape-tab.js). When it
            // fires anyway, close the tab that arrives late — a leaked
            // invisible background tab has no handle otherwise.
            const attemptCreate = async () => {
              let createTimedOut = false;
              const createPromise = d.createTab(url).then((created) => {
                if (createTimedOut) {
                  d.removeTab(created).catch(() => {});
                  throw new Error('Tab arrived after the create timeout — closed to avoid a leaked background tab.');
                }
                return created;
              });
              try {
                // Sixtieth-round user directive: be tolerant of slow
                // networks / loaded browsers — 15s per window (plus the
                // fifty-sixth-log retry = up to 30s) instead of 10s.
                return await withTimeout(createPromise, 15000, 'Failed to create tab (15s timeout)');
              } catch (e) {
                createTimedOut = true;
                createPromise.catch(() => {}); // the late arrival's rejection is nobody's to observe
                throw e;
              }
            };
            // Fifty-sixth log: Chrome tab creation stalled 10s TWICE in a row
            // (transient browser load) and killed the final two verifies of a
            // 59-turn session — a possibly-green artifact shipped behind a
            // failed-verify verdict. One fresh-window retry; a double stall
            // still fails honestly.
            try {
              tab = await attemptCreate();
            } catch (e) {
              tab = await attemptCreate();
            }
            log('Opening ' + url + '...');
            return tab;
          },
          waitForTabLoad: async (tabId) => {
            // Sixtieth-round user directive: slow networks need a tolerant
            // page-load budget — 120s (the forty-fifth-log streaming probe at
            // timeoutMs-1500 still upgrades early resolves; the hard reject
            // keeps its probe evidence).
            await withTimeout(d.waitForTabLoad(tabId), 120000, 'Page load timeout (120s)');
            log('Page loaded.');
            // Wait for the content-script to be listening before the first
            // DOM_REQUEST — prevents the RELAY_FAILED (tabId:null) race.
            let ready = false;
            for (let i = 0; i < 20; i++) {
              try {
                const r = await d.sendMessage(tabId, { type: 'PING' });
                if (r && r.pong) { ready = true; break; }
              } catch (e) { /* not ready yet */ }
              await new Promise((res) => setTimeout(res, 300));
            }
            if (!ready) log('Warning: content script not responding; proceeding anyway.', 'warn');
          },
          resetDomActivity: async (tabId) => {
            await d.sendMessage(tabId, { type: 'RESET_DOM_ACTIVITY' }).catch(() => {});
          },
          getDomActivity: async (tabId) => {
            try {
              const r = await d.sendMessage(tabId, { type: 'GET_DOM_ACTIVITY' });
              return Array.isArray(r && r.activities) ? r.activities : [];
            } catch (e) { return []; }
          },
          executeScript: async (tabId, script, scriptInput, timeoutMs) => {
            if (signalAborted()) throw new Error('TEST_ABORTED');
            log('Executing script via offscreen...');
            return await d.executeScript(tabId, script, scriptInput, timeoutMs);
          },
          captureSnapshot: async (tabId) => {
            try { return await d.captureSnapshot(tabId); } catch (e) { return null; }
          },
          evaluateCondition: async (tabId, conditionExpr) => {
            try { return await d.evaluateCondition(tabId, conditionExpr); } catch (e) { return false; }
          },
          removeTab: async (tabId) => { await d.removeTab(tabId).catch(() => {}); }
        }, {
          onEvent: (evt) => {
            events.push(evt);
            try { onEventCb(evt); } catch (_) { /* UI must never kill the run */ }
            // ZERO-TRAP circuit breaker: a step whose counter fields stay 0
            // across consecutive not-ready iterations has a counting filter
            // that matches nothing — stop the run instead of scrolling to
            // maxIterations. A count that goes positive once marks the step
            // healthy forever. The streak must ALSO span a minimum elapsed
            // time so slowly-rendering pages are not misread.
            try {
              if (evt && evt.type === 'STEP_ITERATION' && evt.stepId != null) {
                const counters = WU.parseCounterFields(evt.resultPreview);
                if (counters && counters.positive && counters.positive.length > 0) {
                  zeroCounterStreaks.delete(String(evt.stepId));
                } else if (counters && WU.isFrozenZeroNotReady(evt.resultPreview)) {
                  const prev = zeroCounterStreaks.get(String(evt.stepId)) || null;
                  const streak = (prev ? prev.n : 0) + 1;
                  const since = prev ? prev.since : Date.now();
                  zeroCounterStreaks.set(String(evt.stepId), { n: streak, since: since });
                  if (streak >= WU.FROZEN_ZERO_STREAK_THRESHOLD &&
                      (Date.now() - since) >= WU.FROZEN_ZERO_MIN_ELAPSED_MS &&
                      !zeroCounterBreaker) {
                    zeroCounterBreaker = {
                      stepId: evt.stepId, streak: streak, counterFields: counters ? counters.zero : [],
                      elapsedMs: Date.now() - since
                    };
                    log('Zero-counter circuit breaker tripped for step ' + evt.stepId + ' (' + streak + ' not-ready iterations over ' + Math.round((Date.now() - since) / 1000) + 's, counters ' + (counters ? counters.zero.join(', ') : '') + ' all 0). Aborting run.', 'error');
                    internalAbort.aborted = true;
                  }
                }
              }
            } catch (_) { /* breaker must never kill the run loop */ }
          }
        });
      } catch (e) {
        orchestrationError = e;
      } finally {
        if (tab) await d.removeTab(tab.id).catch(() => {});
      }

      // ---- Post-run analysis (moved verbatim from wizard.js testScript) ----
      const stepsDefs = (service && Array.isArray(service.steps)) ? service.steps : [];
      const detectors = { emptyFields: [], duplicateFields: [], duplicateEntities: null, countShortfall: null, relativeTimestamps: null, shapeDistribution: null, stepNoReturn: null, junkValues: null, oversizedFields: null, zeroMatchFields: null, containerZero: null, clickContainersTransient: null, partialEmptyFields: null, emptyFieldDiagnostics: null, adMarkerSelectors: null, htmlNoMarkup: null, scrollCountFrozen: null, duplicateIdValues: null, siblingCountContrast: null, implausibleTimeFields: null, positionLikeIds: null, labelPrefixedCounts: null, junkShapeRecords: null, unusedCaptures: null, timeSourceUnexercised: null };
      let error = null;
      if (orchestrationError) {
        try {
          error = Object.assign(new Error(orchestrationError.message), orchestrationError);
        } catch (e) {
          error = new Error(String(orchestrationError.message));
          error.stepId = orchestrationError.stepId || null;
        }
      }

      const finalData = result ? ((result.finalResult && result.finalResult.data) || result.finalResult) : null;

      // 机械-语义分离（spec 3.C）：观测平权——SW 诊断里躺着的弹层捕获
      // 从未进入模型视野（第 65 轮：12+ 次 tooltip 捕获被 fire-and-forget
      // 脚本丢弃，模型只见"字段空"）。捕获>0 且 fieldMap 无悬停读字段时
      // 列原文样本，教 read:'hoverPopover' 绑定。
      const computeUnusedCaptures = () => {
        let total = 0; let readFields = 0; const samples = [];
        let nonConsumingCall = false;
        let declaredCall = false;
        // Code-review P1 (a)+(b): the old run-level gate (declared===0 across
        // the WHOLE run) let one consuming call whitewash every non-consuming
        // call in the same run. Per-call gate now: ANY single diagnostic with
        // captured>0 and popoverReadFields===0 fires.
        // Sixty-ninth review F12: keep-last dedupe let a trailing zero-capture
        // iteration erase the evidence (5 captured then 0 → 0). Aggregate per
        // stepId+container instead: SUM captured, MAX popoverReadFields
        // (nonzero wins), union samples (≤3).
        const byCall = new Map();
        for (const ev of events) {
          for (const d of ((ev && Array.isArray(ev.selectorDiagnostics)) ? ev.selectorDiagnostics : [])) {
            if (!d || d.api !== 'extractWithHover') continue;
            if (!d.capturedPopovers) continue;
            const k = String((ev && ev.stepId) || '') + '|' + (d.containerSelector || '');
            const cp = d.capturedPopovers;
            const captured = (d.hoverSummary && d.hoverSummary.hovercardsCaptured) || cp.captured || 0;
            const read = cp.popoverReadFields || 0;
            const prev = byCall.get(k);
            if (!prev) {
              byCall.set(k, { captured: captured, readFields: read, samples: (cp.samples || []).slice(0, 3) });
            } else {
              prev.captured += captured;
              prev.readFields = Math.max(prev.readFields, read);
              for (const s of (cp.samples || [])) {
                if (typeof s === 'string' && s && prev.samples.length < 3) prev.samples.push(s);
              }
            }
          }
        }
        for (const agg of byCall.values()) {
          total += agg.captured;
          readFields += agg.readFields;
          if (agg.captured > 0 && !(agg.readFields > 0)) nonConsumingCall = true;
          if (agg.captured > 0 && agg.readFields > 0) declaredCall = true;
          for (const s of agg.samples) {
            if (typeof s === 'string' && s && samples.length < 3) samples.push(s);
          }
        }
        if (nonConsumingCall) {
          return {
            totalCaptured: total, popoverReadFields: 0, samples: samples,
            note: 'hover popovers were CAPTURED this run but no fieldMap field consumes them (read:\'hoverPopover\') — bind the field to the popover text of its anchor selector (and filter with your own match regex), instead of discarding the capture'
          };
        }
        if (declaredCall) {
          // (c) declared-but-empty: hover-read fields were declared AND
          // popovers captured — teaching the model to CHECK whether the
          // match/selector actually consumed anything (an over-strict match
          // predicate or a non-matching field selector ships '' while the
          // raw capture sits in hovercards[].popoverText).
          // Sixty-ninth review F4: fire ONLY when the run has independent
          // emptiness evidence (partialEmptyFields / emptyFieldDiagnostics
          // censused something) — a healthy consuming run with every
          // hover-read field populated is silent, not advisory spam.
          const hasEmptyEvidence =
            !!(detectors.partialEmptyFields && detectors.partialEmptyFields.length) ||
            !!(detectors.emptyFieldDiagnostics && detectors.emptyFieldDiagnostics.length);
          if (!hasEmptyEvidence) return null;
          return {
            totalCaptured: total, popoverReadFields: readFields, samples: samples,
            declaredButEmpty: true,
            note: 'hover-read fields are declared and popovers were captured — verify the field values actually consumed them: an over-strict match predicate or a field selector that misses the anchor ships \'\' while the raw capture rides hovercards[].popoverText; loosen or rewrite the predicate (or point the selector at the hovered anchor)'
          };
        }
        return null;
      };

      if (error) {
        augmentError(error, stepsDefs, events);
        // Fiftieth log: the whole census block hangs off `else if (result)` —
        // an orchestrationError run (POLL_EXHAUSTED, SCRIPT_TIMEOUT, ...)
        // produced ZERO censuses while the terminal frozen counter rode the
        // events all along: the red run that most needed the freeze evidence
        // was the one that got none. Events-only censuses run here too;
        // data-based ones still need a result.
        if (typeof WU.detectFrozenScrollCount === 'function') {
          const fscRed = WU.detectFrozenScrollCount(events) || [];
          if (fscRed.length) detectors.scrollCountFrozen = fscRed;
        }
        // Fifty-first log: a step that THREW on zero containers (the
        // "$extractWithHover: no containers matched" shape) emits STEP_FAILED
        // with the sandbox-relayed selectorDiagnostics and no iteration —
        // the census scanned only iterations, so the red verify shipped with
        // a BARE message and zero tags. Run the container census here and
        // embed the lines into the error the model reads, honoring the
        // twenty-fifth-log lead order: a populated stripped base means the
        // caller's own clauses removed the population (SELECTOR_OVERFILTERED
        // supersedes the input-value advice).
        if (typeof WU.detectContainerMatchZero === 'function') {
          const czRed = WU.detectContainerMatchZero(events) || null;
          if (czRed && czRed.length) {
            detectors.containerZero = czRed;
            const diffHitRed = czRed.find((z) => Array.isArray(z.selectorDifferential) &&
              z.selectorDifferential.some((st) => st && st.count > 0));
            const zLinesRed = czRed.map((z) => {
              const stepDefZ = stepsDefs.find((s) => String(s.id) === String(z.stepId));
              let line = 'step "' + (stepDefZ ? stepDefZ.name : z.stepId) + '" (' + z.api + '): container ' +
                JSON.stringify(z.containerSelector) + ' matched 0 items on ' + z.calls + ' call(s)';
              if (Array.isArray(z.selectorDifferential) && z.selectorDifferential.length) {
                line += ' [differential: ' + z.selectorDifferential
                  .map((st) => JSON.stringify(String(st.sel).slice(0, 100)) + ' → ' + st.count)
                  .join(', ') + ']';
              }
              return line;
            }).join('; ');
            error.message = error.message + (diffHitRed
              ? ' — SELECTOR_OVERFILTERED: your trailing :not()/:has() clause(s) removed EVERY item the base selector matches (' + zLinesRed +
                '). Census each clause by counting with and without it (probe.count, attrStats) before re-testing input values; if the census PROVES the clause is correct and the population is genuinely empty for this input class, consider the FAIL-SOFT artifact: pass opts.allowEmpty on the extract call and return {posts:[], note:"no items for this input"} so the deployed SERVICE reports the empty result honestly instead of erroring on every such call.'
              : ' — INPUT_VALUE_SUSPECT: the page held no result items at all for this input (' + zLinesRed +
                '). Re-run verify.run with a DIFFERENT, more common input value BEFORE hardening selectors; if the alternate value also matches zero containers, the page population itself is the limit — say so instead of iterating selectors, and consider the FAIL-SOFT artifact for this input class: pass opts.allowEmpty on the extract call and return {posts:[], note:"no items for this input"} so the deployed SERVICE reports the empty result honestly instead of erroring on every such call.');
          }
        }
        detectors.unusedCaptures = computeUnusedCaptures();
      } else if (result) {
        const toError = (msg, stepId, extra) => {
          const e = new Error(msg);
          if (stepId) e.stepId = stepId;
          Object.assign(e, extra || {});
          return e;
        };
        const lastStepEntry = result.steps[result.steps.length - 1];
        const walkBack = (nominal) => {
          const upstream = (typeof WU.findUpstreamExtractionStepId === 'function')
            ? WU.findUpstreamExtractionStepId(stepsDefs, nominal)
            : nominal;
          return upstream || nominal;
        };

        // Second-live-log D1: a green orchestration where step scripts yielded
        // undefined is broken authoring, not a page problem — the async-IIFE
        // pattern without an internal `return`. No data can flow (every
        // __stepResults__ consumer reads undefined) and every downstream
        // detector stays quiet, which sent the LLM chasing page-side ghost
        // causes. Skipped steps are excluded: their result is legitimately
        // absent.
        const noReturnIds = result.steps
          .filter((s) => !s.skipped && s.result === undefined)
          .map((s) => s.stepId);
        if (noReturnIds.length) {
          detectors.stepNoReturn = noReturnIds;
          const finalEntry = result.steps[result.steps.length - 1];
          const dataEmpty = !finalData || (typeof finalData === 'object' && !Array.isArray(finalData) && Object.keys(finalData).length === 0);
          if (dataEmpty || (finalEntry && finalEntry.result === undefined)) {
            error = toError(
              'STEP_NO_RETURN: step script(s) [' + noReturnIds.join(', ') + '] produced undefined — every step script must return a value (an async IIFE needs `return <value>;` as its last line; await every $ call you depend on before returning). Later steps read __stepResults__[stepId] and got nothing, so no data could reach the output.',
              noReturnIds[noReturnIds.length - 1]);
          }
        }

        const clickFail = WU.detectClickInListTotalFailure(events);
        if (clickFail) {
          const stepDef = stepsDefs.find((s) => String(s.id) === String(clickFail.stepId));
          const allMissed = clickFail.notFoundCount === clickFail.errorCount && clickFail.errorCount > 0;
          error = toError(
            'CLICK_TARGET_NOT_FOUND: step "' + (stepDef ? stepDef.name : clickFail.stepId) + '" called $clickInList' +
            (clickFail.subSelector ? ' with sub-selector ' + JSON.stringify(clickFail.subSelector) : '') +
            ' — matched ' + clickFail.containerMatches + ' container(s), clicked 0, errored ' + clickFail.errorCount +
            (allMissed ? ' (subSel not found in EVERY container)' : '') +
            '. The click/expand action silently did nothing. Read the container HTML in SELECTOR DIAGNOSTICS to find the real clickable element — text-labeled buttons often have no aria-label; match by role or visible text instead.',
            clickFail.stepId);
        }
        if (!error) {
          const containersEmpty = WU.detectClickInListEmptyContainers(events);
          if (containersEmpty) {
            const stepDefCE = stepsDefs.find((s) => String(s.id) === String(containersEmpty.stepId));
            // Forty-eighth log: v6's expand step clicked before the feed
            // mounted (container matched 0) while the SAME run's extract
            // step matched the SAME container selector on every call — a
            // mount-timing transient flipped a completed run red. A later
            // same-run container-scoped match on the identical selector
            // proves the selector is right and the page was just late;
            // downgrade to an advisory instead of vetoing the run.
            let corroboratedBy = null;
            if (typeof WU.corroborateContainerZero === 'function') {
              corroboratedBy = WU.corroborateContainerZero(events, containersEmpty);
            }
            if (corroboratedBy) {
              detectors.clickContainersTransient = Object.assign({}, containersEmpty, {
                corroborated: true,
                corroboratedBy,
                note: 'The container selector matched 0 when this step clicked but ' +
                  JSON.stringify(containersEmpty.containerSelector) + ' matched again later in the SAME run (' +
                  corroboratedBy.map((c) => c.stepId + ': ' + c.containerMatches).join(', ') +
                  ') — mount timing, not a wrong selector. Gate the clicking step on readiness (a count poll with {done:false} under maxIterations>1, or $wait on the container) instead of rewriting the selector.'
              });
            } else {
              error = toError(
                'CLICK_CONTAINERS_EMPTY: step "' + (stepDefCE ? stepDefCE.name : containersEmpty.stepId) + '" called $clickInList' +
                (containersEmpty.containerSelector ? ' with container selector ' + JSON.stringify(containersEmpty.containerSelector) : '') +
                ' — that container selector matched 0 element(s) on every call (' + containersEmpty.calls + ' call(s)), and no later step in this run ever matched it either, so the click action never had anything to operate on. ' +
                'Fix the container selector (check SELECTOR DIAGNOSTICS and the page HTML for the real list structure — prefer descendant selectors over rigid child-combinator chains), and propagate the same fix to every step that references this list.',
                containersEmpty.stepId);
            }
          }
        }
        if (!error && typeof WU.detectHoverAnchorsBlind === 'function') {
          const hoverBlind = WU.detectHoverAnchorsBlind(events);
          if (hoverBlind) {
            const stepDefHB = stepsDefs.find((s) => String(s.id) === String(hoverBlind.stepId));
            // Eighty-fourth log: embed the blind-container anchor census so
            // the rewrite targets THIS verify population's observed anchor
            // forms — re-grounding on the research tab drifted into
            // un-scrolled fresh-tab censuses misread as population variants.
            let censusText = '';
            const ac = hoverBlind.anchorCensus;
            if (ac && ac.families && typeof ac.families === 'object') {
              const fam = Object.keys(ac.families).map((k) => k + '×' + ac.families[k]).join(', ');
              censusText = ' ANCHOR CENSUS (computed inside the failing containers on THIS verify tab): ' + fam + '.';
              if (Array.isArray(ac.hrefSamples) && ac.hrefSamples.length) {
                censusText += ' href samples: ' + JSON.stringify(ac.hrefSamples.slice(0, 5)) + '.';
              }
              if (Array.isArray(ac.ariaLabelSamples) && ac.ariaLabelSamples.length) {
                censusText += ' aria-label samples: ' + JSON.stringify(ac.ariaLabelSamples.slice(0, 5)) + '.';
              }
              censusText += ' A family with ×0 does not exist in this population — write the next anchorSel against the families that ARE present (samples are observed values from the failing containers, not research-tab guesses).';
            }
            error = toError(
              'HOVER_ANCHORS_BLIND: step "' + (stepDefHB ? stepDefHB.name : hoverBlind.stepId) + '" called $extractWithHover' +
              (hoverBlind.anchorSel ? ' with opts.hover.anchorSel ' + JSON.stringify(hoverBlind.anchorSel) : '') +
              ' — that anchorSel matched 0 anchor elements inside EVERY processed container (' +
              hoverBlind.processedCalls + ' call(s), ' + hoverBlind.containersProcessed + ' container(s) total), so hover never ran and every record got hovercards:[] with ZERO entries. ' +
              'This is NOT "hovered but no card appeared" — the anchor was never found. anchorSel is evaluated as container.querySelectorAll(anchorSel): it must match INSIDE each container subtree. ' +
              'The real interactive link is often nested inside wrapper elements (e.g. an <object> wrapper or an aria-hidden shell around the visible link), or sits in a different branch than the intermediate block named in the selector chain — ' +
              "prefer a short, container-scoped tag+[attr] form and verify it against one container's HTML in SELECTOR DIAGNOSTICS." + censusText +
              ' Fix anchorSel and propagate the fix to every step that uses the same anchor, or drop the hover option and use $extractList if hovercard data is not required.',
              hoverBlind.stepId);
          }
        }
        if (!error) {
          const emptyFields = WU.findEmptyExtractionFields(finalData, outputSchema) || []; // null when degraded (C11)
          if (emptyFields.length > 0) {
            const nominalStepId = lastStepEntry && lastStepEntry.stepId;
            detectors.emptyFields = emptyFields;
            // Thirteenth-log P1: the per-field match census exists in
            // selectorDiagnostics; an empty output on top of a field that
            // matched 0 of N containers is a SPECIFIC failure (population
            // divergence between the researched page and the verify input,
            // or the step's own JS filter dropping every record) — name it
            // instead of the generic "field selectors are wrong".
            let census = null;
            if (typeof WU.detectFieldMatchZero === 'function') {
              census = WU.detectFieldMatchZero(events) || null;
              if (census) detectors.zeroMatchFields = census;
            }
            // Fourteenth-log follow-up (user request): zero CONTAINERS on
            // every list call is a different fingerprint — the page had no
            // result items at all, which makes the input VALUE the prime
            // suspect, not the selectors.
            let containerZero = null;
            if (typeof WU.detectContainerMatchZero === 'function') {
              containerZero = WU.detectContainerMatchZero(events) || null;
              if (containerZero) detectors.containerZero = containerZero;
            }
            let msg;
            if (census && census.length) {
              const lines = census.map((c) => {
                const stepDefC = stepsDefs.find((s) => String(s.id) === String(c.stepId));
                return 'step "' + (stepDefC ? stepDefC.name : c.stepId) + '" (' + c.api + '): field "' + c.field + '" (sub-selector ' + JSON.stringify(c.subSelector) + ') matched 0 of ' + c.containerMatches + ' container(s) on every call';
              });
              msg = 'FIELD_MATCH_ZERO / EMPTY_EXTRACTION: required field(s) [' + emptyFields.join(', ') + '] are present but every extracted item has only empty values, or no items were extracted at all. Field census from SELECTOR DIAGNOSTICS — ' + lines.join('; ') + '. The containers themselves DID match, so the page has the repeating items but this field\'s sub-selector found nothing on them. Two likely mechanisms: ' +
                '(a) POPULATION DIVERGENCE — your selectors were grounded on the research page, and a different verify INPUT (different query values) can change the result-card population entirely; first re-verify with the SAME input values that drove the research page before touching selectors; ' +
                '(b) your own step JS filters records on this field (e.g. .filter(p => p.' + census[0].field + ' && ...)) and silently dropped every extracted record — a filtered-to-0 result with containers present is NOT extraction success: keep a RAW fallback count (records.length before filtering / $count(containerSel)) and treat filtered-to-0 as not-ready or an error, never as {done:true}.';
            } else if (containerZero && containerZero.length) {
              // Twenty-fifth log: when a census hit carries a live selector
              // differential whose stripped-base count is >0, the page HAS
              // the items and the caller's own trailing clauses removed
              // them — lead with that instead of the input-value advice.
              const diffHit = containerZero.find((z) => Array.isArray(z.selectorDifferential) &&
                z.selectorDifferential.some((st) => st && st.count > 0));
              const zLines = containerZero.map((z) => {
                const stepDefZ = stepsDefs.find((s) => String(s.id) === String(z.stepId));
                let line = 'step "' + (stepDefZ ? stepDefZ.name : z.stepId) + '" (' + z.api + '): container ' + JSON.stringify(z.containerSelector) + ' matched 0 items on ' + z.calls + ' call(s)';
                if (Array.isArray(z.selectorDifferential) && z.selectorDifferential.length) {
                  line += ' [differential: ' + z.selectorDifferential
                    .map((st) => JSON.stringify(String(st.sel).slice(0, 100)) + ' → ' + st.count)
                    .join(', ') + ']';
                }
                return line;
              });
              if (diffHit) {
                const weakest = diffHit.selectorDifferential[diffHit.selectorDifferential.length - 1];
                msg = 'EMPTY_EXTRACTION / SELECTOR_OVERFILTERED: no list containers matched — ' + zLines.join('; ') +
                  '. The differential above is live evidence: the stripped base ' + JSON.stringify(String(weakest.sel).slice(0, 100)) + ' matched ' + weakest.count +
                  ' element(s) on the verify page, so the page HAS items and YOUR OWN trailing :not()/:has() clause(s) removed every one of them. This is a selector problem — NOT an input-value problem (do not re-test other input values) and NOT a fieldMap problem. Census each clause: count the selector with and without it (or attrStats with the descendant form sel + " [attr]") and drop or invert the clause that zeroes the population — attribute markers whose names look promotional (data-ad-*) are often design-system attributes present on ALL cards, ads and organic alike.';
              } else {
                msg = 'EMPTY_EXTRACTION / INPUT_VALUE_SUSPECT: no list containers matched at all — ' + zLines.join('; ') + '. When the page shows ZERO result items, the input VALUE itself is the prime suspect: the site may simply have no content for it (an obscure keyword, an over-specific filter) — that is not a selector bug. Before touching selectors, re-run verify.run with {"input": {<param>: <a DIFFERENT, more common value>}} (e.g. a headword you saw populate the page during research). If the alternate value returns data, the step graph is fine: adopt it via service.update({testInput: {...}}) so the default input works, and note the input-value sensitivity. Only if a common value ALSO returns zero containers are the selectors/steps the suspects.';
              }
            } else {
              msg = 'EMPTY_EXTRACTION: required field(s) [' + emptyFields.join(', ') + '] are present but every extracted item has only empty values, or no items were extracted at all. The script found list items but the field selectors are wrong.';
            }
            error = toError(
              msg,
              walkBack(census && census.length ? census[0].stepId : nominalStepId),
              { emptyFields: emptyFields, snapshot: (lastStepEntry && lastStepEntry.snapshot) || null });
          }
        }
        if (!error) {
          const duplicateFields = WU.detectDuplicateRecords(finalData, outputSchema) || []; // null when degraded (C11)
          if (duplicateFields.length > 0) {
            const nominalStepId = lastStepEntry && lastStepEntry.stepId;
            detectors.duplicateFields = duplicateFields;
            const summary = duplicateFields.map((x) => x.field + ' (' + x.totalRecords + ' records, ' + x.uniqueSignatures + ' unique)').join('; ');
            error = toError(
              'DUPLICATE_RECORDS: array-of-objects output(s) [' + summary + '] are entirely identical across records. The script almost certainly uses a global sub-selector inside a per-record loop — every iteration captured the same first-match values. Use $extractListMulti with per-record sub-selectors (or scope queries via element.querySelector inside the loop).',
              walkBack(nominalStepId),
              { duplicateFields: duplicateFields, snapshot: (lastStepEntry && lastStepEntry.snapshot) || null });
          }
        }
        if (!error && typeof WU.detectDuplicateEntities === 'function') {
          // Fortieth log: 4 records shipped as "4 posts" while the page held
          // 2 — the container selector matched the SAME card at two nesting
          // levels (:has() matches every qualifying ancestor), so each post
          // arrived twice with identical data fields and differing wrapper
          // htmlSnippet. detectDuplicateRecords (all-identical threshold,
          // wrapper fields in the signature) cannot see such pairs; the
          // entity fingerprint below excludes bookkeeping + wrapper fields.
          const dupEnt = WU.detectDuplicateEntities(finalData, outputSchema) || [];
          if (dupEnt.length > 0) {
            const nominalStepId = lastStepEntry && lastStepEntry.stepId;
            detectors.duplicateEntities = dupEnt;
            const summary = dupEnt.map((x) => x.field + ' (' + x.duplicateCount + ' of ' + x.totalRecords + ' records share one entity signature over [' + x.signatureFields.join(', ') + ']; ' + x.distinctEntities + ' distinct entities)').join('; ');
            error = toError(
              'DUPLICATE_ENTITIES: ' + summary + ' — the page has fewer real entities than the record count. Classic cause: a NESTED container selector — \':has()\' matches EVERY qualifying ancestor and union selector lists match both wrapper and card, so each card is captured at 2+ nesting levels (data fields identical, wrapper fields like htmlSnippet differ). Fixes: probe.count a card-only selector on the research tab to cross-check the real card count; make the container selector match exactly ONE level (direct-child combinator `>` or a card-type attribute the wrapper lacks); or dedup by the entity signature when assembling the output. If the doubled capture is intentional, renegotiate the contract with io.confirm adding a distinguishing field.',
              walkBack(nominalStepId),
              { duplicateEntities: dupEnt, snapshot: (lastStepEntry && lastStepEntry.snapshot) || null });
          }
        }
        // Forty-eighth log: every report-only census below used to sit behind
        // !error, so the round a gate flipped red was exactly the round that
        // produced NO field evidence at all (v6: CLICK_CONTAINERS_EMPTY red
        // with partialEmptyFields null — the postId 2/4 census the model
        // needed most never ran). Censuses are evidence, not verdicts: they
        // run on red runs too. Only the error-SETTING gates keep !error.
        if (typeof WU.detectCountShortfall === 'function') {
          // Report-only: forcing retries toward an unreachable count is the
          // ZERO-TRAP deadlock; surface it and let the human/LLM judge.
          detectors.countShortfall = WU.detectCountShortfall(finalData, input, outputSchema) || null;
        }
        if (typeof WU.detectRelativeTimestamps === 'function') {
          // Forty-sixth log: report-only. A time-like field whose values are
          // relative ages ("a day ago") is the rendered age label, not the
          // absolute timestamp the contract describes — rebind (datetime
          // attr / labelledby reference / hovercard) or renegotiate.
          const relTs = WU.detectRelativeTimestamps(finalData, outputSchema);
          if (relTs && relTs.length) detectors.relativeTimestamps = relTs;
        }
        if (typeof WU.detectFrozenScrollCount === 'function') {
          // Forty-ninth log: report-only. A counter frozen at a NONZERO value
          // across a trailing streak of scroll iterations is either a
          // renderer-gated lazy-load (page hidden/unfocused — activation and
          // window focus are re-asserted by every scroll op now; check the
          // scroll diagnostics' pageState/frameSample) or a genuinely
          // exhausted feed (accept the count or renegotiate via io.confirm).
          // The frozen-zero trap stays the fourth-log detector's class.
          const fsc = WU.detectFrozenScrollCount(events) || [];
          if (fsc.length) detectors.scrollCountFrozen = fsc;
        }
        if (typeof WU.detectImplausibleTimeFields === 'function') {
          // Fifty-second log: report-only. A time-named field whose non-empty
          // values carry no date/time shape ("m.meCat…" — the labelledby
          // resolution of the WRONG anchor concatenating redirect domains and
          // page titles) passes the relative/empty/junk censuses. The census
          // names the field with a sample and teaches filtering candidates
          // by date shape / re-binding the timestamp anchor.
          const itf = WU.detectImplausibleTimeFields(finalData, outputSchema) || [];
          if (itf.length) detectors.implausibleTimeFields = itf;
        }
        if (typeof WU.detectPositionLikeIds === 'function') {
          // Fifty-fifth log: report-only. postId as the small ascending
          // integers 3..11 — aria-posinset (position-in-set) read as the
          // per-record identity. Identity values are long opaque tokens;
          // small integers are positions. The census names the permalink
          // route where real ids live.
          const pli = WU.detectPositionLikeIds(finalData, outputSchema) || [];
          if (pli.length) detectors.positionLikeIds = pli;
        }
        if (typeof WU.detectLabelPrefixedCounts === 'function') {
          // Fifty-eighth log: report-only. A count field shipping a control
          // label PLUS the count ("Like: 37 people") carries extractable
          // data — the census carries the parsed sample and teaches the
          // one-line parse instead of just disclosing the junk.
          const lpc = WU.detectLabelPrefixedCounts(finalData, outputSchema) || [];
          if (lpc.length) detectors.labelPrefixedCounts = lpc;
        }
        if (typeof WU.detectJunkShapeRecords === 'function') {
          // Seventy-fourth log: report-only. A subpopulation of records
          // sharing the junk shape (overlong text content, every
          // identity-ish required field empty) next to real records is a
          // POPULATION SPLIT — machine-generated prompt/media cards mixed
          // into the real feed. Rewriting identity extraction cannot fill
          // fields the junk cards structurally lack; the census teaches the
          // container-selector tightening or the contract split.
          const jsr = WU.detectJunkShapeRecords(finalData, outputSchema) || [];
          if (jsr.length) detectors.junkShapeRecords = jsr;
        }
        if (typeof WU.detectSiblingCountContrast === 'function') {
          // Fiftieth log: report-only. A count-named field empty on most
          // records while a SIBLING count field extracts real values from the
          // same family proves the family renders counts — the empty value
          // lives in an aria-label attribute / aria-labelledby reference, not
          // textContent. Renegotiating the field away before probing those
          // routes was premature (likes 5/5 empty vs shares 5/5 populated).
          const scc = WU.detectSiblingCountContrast(finalData, outputSchema) || [];
          if (scc.length) detectors.siblingCountContrast = scc;
        }
        if (typeof WU.detectDuplicateIdValues === 'function') {
          // Forty-ninth log: report-only. An id-like value shared by several
          // records means the extractor fell back to a container-level
          // shared value instead of a per-record identifier — the census
          // names the value and the record ordinals to re-probe.
          const dupIds = WU.detectDuplicateIdValues(finalData, outputSchema) || [];
          if (dupIds.length) {
            // Eighty-fifth log promotion: the feedback session shipped a
            // GREEN v13 whose records #2/#5 carried the IDENTICAL required
            // postId (an author-scoped story token). A REQUIRED identity
            // field that repeats across records breaks record identity —
            // veto; optional id fields keep the report-only lane (the
            // human may have confirmed a contract that tolerates repeats).
            for (const dup of dupIds) {
              const reqFields = (typeof WU.schemaItemRequiredForPath === 'function')
                ? WU.schemaItemRequiredForPath(outputSchema, dup.path) : null;
              const isRequired = Array.isArray(reqFields) && reqFields.indexOf(dup.field) !== -1;
              if (isRequired && !error) {
                error = new Error(
                  'DUPLICATE_ID_REQUIRED: ' + dup.path + ' carries the same value in ' + dup.count + '/' + dup.totalRecords +
                  ' records ("' + dup.value + '" on records ' + dup.indices.join(', ') + ') but the confirmed contract lists it as REQUIRED — a required identity field that repeats is a broken binding, not a page fact. ' +
                  'The usual cause is a fallback to a shared/author-scoped value (the list owner id, a base64 story token) instead of a per-record identifier: per-record ids live on per-record elements — a card link\'s own href often carries the numeric id right beside any token. ' +
                  'Re-probe ONE listed record (probe.snippet over its link hrefs), bind the per-record source, and dry-run before the next service.update. If the page legitimately repeats the record itself, dedup in the step or renegotiate via io.confirm — a required id may not ship duplicated.'
                );
                break;
              }
            }
            detectors.duplicateIdValues = dupIds;
          }
        }
        if (RSD && typeof RSD.formatShapeDistributionFromData === 'function') {
          // Report-only: 2+ field-population signatures across the extracted
          // records mean the selector kept mixed card types — a card-policy
          // signal, not an error. The CARD_POLICY tag auto-attaches the
          // card-type-heterogeneity / card-polarity knowledge units.
          detectors.shapeDistribution = RSD.formatShapeDistributionFromData(finalData, outputSchema) || null;
        }
        {
          // Report-only (tenth-log N2): the human may have confirmed a
          // contract that wants these values — surface, teach, never block.
          detectors.junkValues = detectJunkValues(finalData, outputSchema);
        }
        if (typeof WU.detectHtmlFieldsWithoutTags === 'function') {
          // Report-only (forty-seventh log): posts.htmlSnippet shipped
          // content.slice(0,500) — text under a markup-named field on a
          // green verify. A captured DOM region always contains tags;
          // surface the census + copied-from sibling, teach, never block.
          const hm = WU.detectHtmlFieldsWithoutTags(finalData) || [];
          detectors.htmlNoMarkup = hm.length ? hm : null;
        }
        if (typeof WU.detectOversizedFields === 'function') {
          // Report-only (forty-first log): htmlSnippet fields read whole-card
          // outerHTML at 82396-99278 chars each (result.json: 332KB for 3
          // posts). The read layer caps element-HTML at 50000, but a
          // multi-myriad-char field still means the selector grabbed
          // whole-card DOM where a semantic sub-element was available —
          // surface the census, teach tighter anchoring, never block (the
          // confirmed contract may honestly want the blob).
          const oversizedCensus = WU.detectOversizedFields(finalData, outputSchema) || [];
          detectors.oversizedFields = oversizedCensus.length ? oversizedCensus : null;
        }
        if (!error && detectors.junkValues && Array.isArray(detectors.junkValues.fields) && outputSchema && outputSchema.properties) {
          // Fortieth log: "Leave a comment" (the composer button label) shipped
          // as posts.comments for ALL 4 records on a green verify — the
          // controlLabel census flagged it 4/4 but stayed advisory, and the
          // session finished with the user-reported junk field intact. A
          // count-ish field whose EVERY value is a digit-less UI label is not
          // a contract nuance, it is a mis-anchored selector: block it. Below
          // 100% (or on undeclared pass-through fields) the census stays
          // report-only exactly as before.
          for (const f of detectors.junkValues.fields) {
            if (!f || f.kind !== 'controlLabel') continue;
            // Declared at the ITEM level (field shape is '<arrayField>.<subField>'):
            // an undeclared pass-through extra stays the census's business —
            // the confirmed contract is what promotes the signal to a block.
            const segs = String(f.field || '').split('.');
            if (segs.length < 2) continue;
            const rootProp = outputSchema.properties[segs[0]];
            const itemProps = rootProp && rootProp.items && typeof rootProp.items.properties === 'object'
              ? rootProp.items.properties
              : null;
            if (!itemProps || !itemProps[segs[segs.length - 1]]) continue;
            if (typeof f.total === 'number' && f.total >= 2 && f.count >= f.total) {
              error = new Error(
                'JUNK_DOMINATED_FIELD: ' + f.field + ' is a bare UI control label ("' + f.sample + '") in ' + f.count + '/' + f.total +
                ' records — the sub-selector grabbed page chrome (a button label / placeholder / aria text), not data. Count-like fields ' +
                'come from engagement counters and carry digits; a digit-less constant across every record is a mis-anchored selector. ' +
                'Fix the sub-selector against the live card (probe / record HTML), or when the field genuinely never exists on this card ' +
                'type renegotiate the contract with io.confirm.'
              );
              break;
            }
          }
        }
        // Report-only (eighteenth log): ad/sponsored markers in step
        // selectors — include-usage inverts an exclusion requirement.
        // Twenty-fifth log: UNGATED from !error — the polarity teaching is
        // most valuable exactly when extraction fails (all eight verifies of
        // the twenty-fifth session errored, so the detector never ran while
        // every shipped script carried data-ad-* markers).
        detectors.adMarkerSelectors = detectAdMarkerSelectors(stepsDefs);
        if (typeof WU.detectEmptyOutputFieldsByRatio === 'function') {
          // Report-only (sixteenth log): findEmptyExtractionFields fires only
          // when EVERY value of EVERY record is empty, so time:""/location:""
          // beside a populated content field sailed through a green verify
          // (score 133) and the session LLM rationalized the empties as
          // "virtualization timing". The per-field ratio census names the
          // pattern on-channel so the report — not the model's hindsight —
          // carries the evidence.
          const pe = WU.detectEmptyOutputFieldsByRatio(finalData, outputSchema) || [];
          detectors.partialEmptyFields = pe.length ? pe : null;
          // Thirty-first log: the census names the empty field but not the
          // WHY. The owning step's LAST STEP_ITERATION diagnostics already
          // carry falsification evidence (labelledby missingIds / "references
          // id(s) that resolve to nothing", zero-match sub-selectors,
          // attrAbsent) — lift per-field crumbs into the report so a green
          // verify still tells the model exactly where and why each empty
          // field died, instead of leaving it to conclude "state-dependent,
          // not extractable" over fifteen turns.
          if (pe.length && typeof WU.emptyFieldDiagnostics === 'function') {
            const efd = WU.emptyFieldDiagnostics(pe, stepsDefs, events) || [];
            detectors.emptyFieldDiagnostics = efd.length ? efd : null;
          }
        }
        detectors.unusedCaptures = computeUnusedCaptures();
      }

      // Twenty-sixth log: verifies 1-4 all returned ok:true (score 133) while
      // posts.postId — an items.required field — was empty in 2/3 records;
      // the finish summary read "Verified green" and only the user's
      // feedback resume fixed the field. The ok gate was purely !error. An
      // item-REQUIRED field empty at the same ratio the partial-empty
      // detector censuses (>=0.5 of >=2 records) is a contract violation,
      // not an advisory: flip the run red and teach both exits.
      if (!error && Array.isArray(detectors.partialEmptyFields) && outputSchema && outputSchema.properties) {
        const reqProps = outputSchema.properties;
        for (const pe of detectors.partialEmptyFields) {
          // Forty-seventh log: resolve the path against the DECLARING
          // array's items.required — 'posts.hoverCards[].type' is governed
          // by hoverCards' items, not the top-level posts items. Falls
          // back to the depth-1 inline form when the helper is missing.
          let itemRequired = null;
          if (typeof WU.schemaItemRequiredForPath === 'function') {
            itemRequired = WU.schemaItemRequiredForPath(outputSchema, String(pe.path || ''));
          } else {
            const key = String(pe.path || '').split('.')[0];
            const prop = reqProps[key];
            itemRequired = prop && prop.items && Array.isArray(prop.items.required) ? prop.items.required : null;
          }
          if (itemRequired && itemRequired.indexOf(pe.field) !== -1) {
            // Forty-eighth log: 'postId 2/4' across five verifies never said
            // WHICH records — the model blind-rewrote the regex five times
            // without re-probing. Name the empty record ordinals with a
            // content fingerprint each, so record #2 can be matched to the
            // photo post and probed directly.
            let whereNote = '';
            if (Array.isArray(pe.emptyRecordSamples) && pe.emptyRecordSamples.length) {
              const idx = pe.emptyRecordSamples.slice(0, 3)
                .map((s) => '#' + (s.index || (s.parentIndex + '.' + s.subIndex))).join(', ');
              const hints = pe.emptyRecordSamples.slice(0, 2)
                .map((s) => '"' + String(s.hint || '').slice(0, 40) + '"').join(' / ');
              whereNote = ' Empty record(s): ' + idx + (hints ? ' (contexts: ' + hints + ')' : '') + '.';
            }
            error = new Error(
              'REQUIRED_FIELD_EMPTY: ' + pe.path + ' is empty in ' + pe.emptyCount + '/' + pe.totalCount +
              ' records' + whereNote + ' but the confirmed contract lists it as REQUIRED for every record. ' +
              'Match the named record(s) against steps[].resultPreview in THIS report to see which step lost the value. ' +
              // Graduated-activation spec §3.B (2026-09-18): the 67th-log
              // snippet-first teaching merged with the evidence-ACTION tail —
              // one concrete re-fetch instruction instead of generalized advice.
              'Before rewriting the binding, re-fetch ONE failing record\'s fragment (probe.skeleton on its container) ' +
              'and confirm the value\'s actual source; if tools cannot see what you can, user.observe. Then dry-run the ' +
              'corrected extraction with probe.snippet on the research tab before the next service.update — one snippet ' +
              'round beats a blind update+verify pair (2 turns), and regexes written against hoped-for shapes (e.g. digit-only id ' +
              'patterns on non-numeric ids) fail every record. A second empty run without new evidence means STOP ' +
              'deriving and pick one: re-fetch / user.observe / io.confirm renegotiate. Either fix the extraction ' +
              '(the field is contractually demanded — ground a selector for it, re-check the fieldMap anchor and the ' +
              'record assembly), or renegotiate the contract with io.confirm (move the field out of required / drop it) ' +
              'when it genuinely never exists on these cards. Optional-field emptiness stays advisory; a required one does not.'
            );
            break;
          }
        }
      }

      // Eighty-first log / user directive 2026-09-18: postTime comes from
      // the hover tooltip, not the page-visible label. The 81st session
      // shipped visible-label values ("4 days ago"/"June 3") with
      // probe.timestamp called ZERO times — the 69th-round machinery MARKED
      // them partial and the 76th-round ladder allowed the disclosed ship,
      // but nothing required the tooltip route to be EXERCISED first. The
      // teaching is advisory and the model short-circuits, so the popover
      // route becomes a GATE: a REQUIRED time-named field carrying relative
      // or partial values with NO popover-route evidence this session is an
      // UNEXERCISED source, not a page fact. Red only for required fields;
      // optional time fields keep the advisory path. Full absolutes pass
      // untouched (detectRelativeTimestamps never lists them).
      if (Array.isArray(detectors.relativeTimestamps) && detectors.relativeTimestamps.length) {
        // Eighty-seventh log: the census was structurally blind — it scanned
        // only THIS run's events, so research-tab probe.timestamp receipts
        // were invisible (the model could never unlock the documented
        // disclosed-ship exit) and raw-$hover captures in step scripts were
        // invisible while the message claimed "NO tooltip evidence exists
        // this session". Evidence now has three sources and the message
        // tells the truth about WHICH route was exercised:
        //   (a) this run's extractWithHover captures (+samples),
        //   (b) hover-capture markers in step result previews (raw $hover),
        //   (c) SESSION evidence passed by session-tools (probe.timestamp
        //       call count/last receipt + the popover-capture LRU texts).
        const sessionEv = (o.sessionEvidence && typeof o.sessionEvidence === 'object') ? o.sessionEvidence : null;
        let inRunCaptured = 0;
        const inRunSamples = [];
        let previewProbeTimestamp = false;
        let previewHoverCapture = false;
        for (const ev of events) {
          const diags = (ev && Array.isArray(ev.selectorDiagnostics)) ? ev.selectorDiagnostics : [];
          for (const dg of diags) {
            const cp = (dg && dg.capturedPopovers) || null;
            const captured = (dg && dg.hoverSummary && dg.hoverSummary.hovercardsCaptured) ||
              (cp ? (cp.captured || 0) : 0);
            const samples = cp && Array.isArray(cp.samples) ? cp.samples : [];
            if (captured > 0) inRunCaptured += captured;
            for (const s of samples) {
              if (typeof s === 'string' && s) inRunSamples.push(s);
            }
          }
          const pv = String((ev && ev.resultPreview) || '');
          if (/probe\.timestamp/.test(pv)) previewProbeTimestamp = true;
          const p = previewJson(pv);
          if (p && typeof p === 'object' && (p.anchorsProbed != null || p.hoversDispatched != null)) {
            previewProbeTimestamp = true;
          }
          if (/"hovered"\s*:\s*true[\s\S]{0,600}?"htmlSnippet"\s*:\s*"</.test(pv)) previewHoverCapture = true;
        }
        const sessionSamples = (sessionEv && Array.isArray(sessionEv.popoverSamples))
          ? sessionEv.popoverSamples.filter((s) => typeof s === 'string' && s) : [];
        const probeTimestampCalls = (sessionEv && typeof sessionEv.probeTimestampCalls === 'number')
          ? sessionEv.probeTimestampCalls : 0;
        const allSamples = inRunSamples.concat(sessionSamples);
        // Date-shape scan over every captured popover text. Three levels:
        //   FULL absolute (year token) — the tooltip route demonstrably
        //     produces dates; teach binding it, never veto.
        //   ANY date shape (relative phrases included — "yesterday at 5 PM"
        //     is a time tooltip) — the time-route tooltips were captured;
        //     the exercised-route disclosed-ship contract applies.
        //   NO date shape (pure author/group cards) — the TIME anchor's
        //     tooltip was never hovered; red, with the truthful message.
        const REL_DATE_RE = /\b(?:seconds?|minutes?|hours?|hrs?|days?|weeks?|months?|years?)\s+ago\b|\byesterday\b|\btoday\b|just now|\d+\s*(?:min|sec|hr)\b/i;
        const sampleDateShape = (t) => {
          const str = String(t);
          const subs = (typeof WU.extractDateSubstrings === 'function')
            ? (WU.extractDateSubstrings(str) || []) : [];
          return subs.length > 0 || REL_DATE_RE.test(str) ||
            (typeof WU.looksLikeDate === 'function' && WU.looksLikeDate(str));
        };
        const sampleHasFullAbsolute = allSamples.some((t) => {
          const subs = (typeof WU.extractDateSubstrings === 'function')
            ? (WU.extractDateSubstrings(String(t)) || []) : [];
          return subs.some((s) => (typeof WU.hasYearToken === 'function')
            ? WU.hasYearToken(s) : /(?:19|20)\d{2}/.test(s));
        });
        const sampleAnyDateShape = allSamples.some(sampleDateShape);
        const fullAbsoluteSeen = sampleHasFullAbsolute || !!(sessionEv && sessionEv.lastFullAbsolute);
        const probedNoAbsolute = (probeTimestampCalls > 0 || previewProbeTimestamp) && !fullAbsoluteSeen;
        const capturedNoDate = !probedNoAbsolute && !sampleAnyDateShape &&
          (inRunCaptured > 0 || previewHoverCapture || sessionSamples.length > 0);
        if (!fullAbsoluteSeen && !probedNoAbsolute && !sampleAnyDateShape) {
          for (const rt of detectors.relativeTimestamps) {
            if (!rt) continue;
            let itemRequired = null;
            if (typeof WU.schemaItemRequiredForPath === 'function') {
              itemRequired = WU.schemaItemRequiredForPath(outputSchema, String(rt.path || ''));
            }
            if (!itemRequired || itemRequired.indexOf(rt.field) === -1) continue;
            const gateMsg = capturedNoDate
              ? 'TIME_SOURCE_UNEXERCISED: ' + rt.path + ' carries page-visible labels (relative/partial; sample "' +
                String(rt.sampleValue || '').slice(0, 40) + '") and popovers WERE captured this run/session — but none of the captured samples carries ANY date shape (they are author/group cards: the TIME anchor\'s tooltip specifically was never hovered). Call probe.timestamp({containerSel}) once (it hovers the time anchors and returns popover-text candidates) or hover the timestamp element itself — only after that receipt is partial/relative an honest disclosed ship; binding the page-visible label without exercising the time anchor is an unexercised source, not a page fact.'
              : 'TIME_SOURCE_UNEXERCISED: ' + rt.path + ' carries page-visible labels (relative/partial; sample "' +
                String(rt.sampleValue || '').slice(0, 40) + '") but the contract source is the hover tooltip, ' +
                'and no tooltip evidence exists in this run or the session record: call probe.timestamp({containerSel}) once ' +
                '(it hovers the time anchors and returns popover-text candidates) or bind the field via ' +
                'read:\'hoverPopover\' with your own match — only after that receipt is partial/relative an ' +
                'honest disclosed ship; without it, this is an unexercised source, not a page fact.';
            detectors.timeSourceUnexercised = detectors.timeSourceUnexercised || [];
            detectors.timeSourceUnexercised.push({ field: rt.field, path: rt.path, sampleValue: rt.sampleValue, relativeCount: rt.relativeCount, partialAbsoluteCount: rt.partialAbsoluteCount, tier: capturedNoDate ? 'captured-no-date' : 'unexercised' });
            if (!error) {
              error = new Error(gateMsg);
            } else if (!/TIME_SOURCE_UNEXERCISED/.test(String(error.message))) {
              error.message += ' | ' + gateMsg;
            }
            break; // one gate names the field; the detector rows carry the rest
          }
        }
        // probedNoAbsolute → the gate's documented contract: the route WAS
        // exercised and its best receipt is partial/relative — the disclosed
        // ship is legal. No tag, no veto; RELATIVE_TIMESTAMP (report-only)
        // already teaches the three exits.
      }

      const oc = (result ? WU.validateOutputAgainstSchema(finalData, outputSchema) : { ok: true, missing: [] }) || { ok: true, missing: [] };

      // Twenty-eighth log: the report showed {stepId, iterations} only — the
      // model knew postingTime was 10/10 empty but NOT where in the pipeline
      // the value died (extract produced timeRef? resolve returned what?),
      // and burnt ten turns blind-guessing about a tab it cannot probe
      // (probes run on the research tab; verify opens a fresh one). Each
      // step's LAST STEP_ITERATION resultPreview (already 500-capped by the
      // orchestrator) makes the pipeline legible in the report itself;
      // re-cap at 200 so a six-step graph stays inside the ~4000-char
      // tool-result window the model actually sees.
      // Twenty-ninth log: the re-cap was head-only, so a large extract
      // preview (orchestrator head+tail, 500) lost its tail AGAIN here —
      // the tail is exactly where scripts put instrumented summary keys
      // (timeMapSize etc.). Re-cap head+tail so both ends survive both
      // layers.
      const compactSteps = result && Array.isArray(result.steps)
        ? result.steps.map((s) => {
            let lastPreview = null;
            for (let i = events.length - 1; i >= 0; i--) {
              const e = events[i];
              if (e && e.type === 'STEP_ITERATION' && String(e.stepId) === String(s.stepId) && typeof e.resultPreview === 'string') {
                lastPreview = e.resultPreview;
                break;
              }
            }
            const entry = {
              stepId: s.stepId,
              stepName: s.stepName,
              skipped: !!s.skipped,
              skipReason: s.skipReason || null,
              iterations: events.filter((e) => e && e.type === 'STEP_ITERATION' && String(e.stepId) === String(s.stepId)).length
            };
            if (lastPreview !== null) {
              entry.resultPreview = (typeof WU.headTailSlice === 'function')
                ? WU.headTailSlice(lastPreview, 200)
                : (lastPreview.length > 200 ? lastPreview.slice(0, 197) + '…' : lastPreview);
            }
            return entry;
          })
        : [];

      // hoisted — declared after the return for top-down reading
      function eventTags() {
        const tags = [];
        const add = (t) => { if (tags.indexOf(t) === -1) tags.push(t); };
        const msg = error ? String(error.message) : '';
        if (/ZERO_COUNTER_FROZEN/.test(msg)) add('COUNTER_FROZEN');
        // Sixty-seventh log: the red gate existed only as the error MESSAGE —
        // the knowledge auto-attach lever (58th-log adoption mechanism) reads
        // result.events tags, so the snippet-first unit never attached on the
        // 8-blind-update death spiral. Emit the tag on the red gate itself.
        if (/REQUIRED_FIELD_EMPTY/.test(msg)) add('REQUIRED_FIELD_EMPTY');
        if (/COUNT_SELECTOR_BLIND/.test(msg)) add('SELECTOR_ZERO_MATCH');
        // Seventeenth log: budget exhaustion with NON-zero intermediate counts
        // (thin content below the step's target) was tagged SELECTOR_ZERO_MATCH —
        // a factually wrong claim that sent the model hunting healthy
        // selectors. POLL_EXHAUSTED now keeps its own tag; the
        // poll-exhaustion-differential knowledge unit attaches to it.
        if (/POLL_EXHAUSTED/.test(msg) && !/COUNT_SELECTOR_BLIND/.test(msg) && !/ZERO_COUNTER_FROZEN/.test(msg)) add('POLL_EXHAUSTED');
        if (/EMPTY_EXTRACTION/.test(msg)) add('EMPTY_EXTRACTION');
        if (/SELECTOR_OVERFILTERED/.test(msg)) add('SELECTOR_OVERFILTERED');
        if (detectors.zeroMatchFields) add('FIELD_MATCH_ZERO');
        if (detectors.containerZero && !/SELECTOR_OVERFILTERED/.test(msg)) add('INPUT_VALUE_SUSPECT');
        if (/DUPLICATE_RECORDS/.test(msg)) add('DUPLICATE_RECORDS');
        if (/DUPLICATE_ENTITIES/.test(msg)) add('DUPLICATE_ENTITIES');
        if (/JUNK_DOMINATED_FIELD/.test(msg)) add('JUNK_DOMINATED');
        if (/SCRIPT_TIMEOUT/.test(msg)) add('SCRIPT_TIMEOUT');
        if (/HOVER_ANCHORS_BLIND/.test(msg)) add('HOVER_NO_SIGNAL');
        if (detectors.emptyFields.length) add('EMPTY_FIELDS');
        // Forty-sixth log: the detector now reports EVERY shortfall; the tag
        // (and its knowledge attach) stays severe-only so 9/10 runs are not
        // nagged — the report and the finish ladder disclose the rest.
        if (detectors.countShortfall && detectors.countShortfall.severe) add('COUNT_SHORTFALL');
        if (detectors.relativeTimestamps) add('RELATIVE_TIMESTAMP');
        // Eighty-first log: tag on the red gate itself so the
        // relative-timestamp knowledge unit (with the exercise-first ladder)
        // auto-attaches on TIME_SOURCE_UNEXERCISED runs.
        if (detectors.timeSourceUnexercised) add('TIME_SOURCE_UNEXERCISED');
        if (detectors.scrollCountFrozen) add('SCROLL_COUNT_FROZEN');
        if (detectors.siblingCountContrast) add('COUNT_FIELD_HIDDEN_VALUE');
        if (detectors.implausibleTimeFields) add('TIME_FIELD_IMPLAUSIBLE');
        if (detectors.positionLikeIds) add('POSITION_LIKE_ID');
        if (detectors.labelPrefixedCounts) add('LABEL_PREFIXED_COUNT');
        if (detectors.junkShapeRecords) add('JUNK_SHAPE_RECORDS');
        if (detectors.duplicateIdValues) add('DUPLICATE_ID_VALUES');
        if (detectors.shapeDistribution) add('CARD_POLICY');
        if (detectors.stepNoReturn) add('STEP_NO_RETURN');
        if (detectors.junkValues) add('JUNK_VALUES');
        if (detectors.oversizedFields) add('OUTPUT_FIELD_SIZE');
        if (detectors.htmlNoMarkup) add('HTML_FIELD_NO_MARKUP');
        if (detectors.partialEmptyFields) add('PARTIAL_EMPTY_FIELDS');
        if (detectors.clickContainersTransient) add('CLICK_CONTAINERS_TRANSIENT');
        if (schemaBlindNote(outputSchema)) add('SCHEMA_BLIND');
        if (detectors.adMarkerSelectors) add('AD_MARKER_SELECTOR');
        for (const evt of events) {
          if (!evt || evt.type !== 'STEP_ITERATION') continue;
          const p = previewJson(evt.resultPreview);
          const fr = p && typeof p === 'object' ? p.failureReasons : null;
          if (fr && typeof fr === 'object') {
            for (const k of Object.keys(fr)) {
              if (/popover/.test(k)) add('POPOVER_TIMEOUT');
              if (/no_signal|no_hover/.test(k)) add('HOVER_NO_SIGNAL');
            }
          }
        }
        return tags;
      }

      // Sixth-live-log I4: an all-zero breakdown over real data is almost
      // always a result-vs-schema top-level KEY mismatch — invisible in the
      // bare numbers. Name both key sets so the model renames instead of
      // re-probing the page.
      // Seventeenth log: the note fired even when the key sets MATCHED (the
      // zeros came from empty values) — renaming advice then misdirects.
      // Only emit when a schema key is actually absent from the result.
      function scoreMismatchNote(score, data, schema) {
        if (!score || score.score !== 0 || !score.isData) return null;
        if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
        const dataKeys = Object.keys(data);
        if (!dataKeys.length) return null;
        const props = (schema && schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) ? Object.keys(schema.properties) : [];
        const req = (schema && Array.isArray(schema.required)) ? schema.required.filter(k => typeof k === 'string') : [];
        const want = req.length ? req : props;
        if (!want.length) return null;
        const missing = want.filter(k => dataKeys.indexOf(k) === -1);
        if (!missing.length) return null; // keys align — empty VALUES own this zero, not naming
        const which = req.length ? 'required' : 'properties';
        return 'score is 0 although extraction produced data. Scoring reads the schema\'s ' + which + ' keys against the RESULT\'s top-level keys — result keys [' + dataKeys.join(', ') + '] vs schema ' + which + ' [' + want.join(', ') + ']; the schema keys [' + missing.join(', ') + '] appear NOWHERE in the result. Align them: rename the step\'s output field(s) or the schema so the same key appears on both sides; a key-name mismatch scores 0 no matter how complete the data is.';
      }

      // Seventeenth log: {"type":"object"} with neither required nor
      // properties turned every schema-reading check blind — the report came
      // back GREEN at score 0 over real data (one all-empty record). The
      // io.confirm/service.update gates now reject fieldless schemas, but
      // resumed legacy sessions and schema-less verify calls (the
      // {type:'object'} default) still land here — disclose the blindness
      // instead of certifying it.
      function schemaBlindNote(schema) {
        const req = (schema && Array.isArray(schema.required)) ? schema.required : [];
        const props = (schema && schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) ? Object.keys(schema.properties) : [];
        if (req.length || props.length) return null;
        return 'outputSchema declares NO fields (no "required", no "properties") — scoring and every empty/junk detector are blind, so this green report is unverifiable. Run io.confirm with an outputSchema that lists the output fields under "properties" (and the must-haves in "required"), then service.update the artifact to match and re-verify.';
      }

      // Eighteenth log: the model shipped sponsored cards AS the requested
      // posts with the container built ON an ad marker. Report-only — the
      // marker may also be doing legitimate EXCLUSION work inside :not();
      // the note demands the polarity check, never a verdict.
      function adMarkerNote(hits) {
        if (!hits || !hits.length) return null;
        const lines = hits.map((h) => (h.stepId != null ? h.stepId : '?') + ': ' + h.markers.join(', ')).join('; ');
        return 'step selector(s) reference ad/sponsored markers (' + lines + '). Check the POLARITY against the requirement: if it EXCLUDES ads/recommendations, a container or content selector built ON an ad marker selects exactly what was to be removed — the exclusion form (:not() / :has()-negation over the marker) is the correct one. And if ad-marked cards are the ONLY cards the page offers, that is thin content for this input value: say so in the finish summary and prefer a more common input value instead of relabeling ad units as the requested records.';
      }

      // Twenty-fourth log: the model's own step-level instrumentation (small
      // non-record keys of finalResult, e.g. {debugTime: {...}} riding beside
      // {posts: [...]}) serialized AFTER the sampled record array, and the
      // engine renders tool results through a ~4000-char summary — htmlSnippet
      // strings filled the window and the model literally could not see its
      // own debug output ("finalResult被截断看不到debugTime"). It burnt a
      // whole turn on a debug-only step to learn a fact its payload already
      // contained. resultDebug lifts those keys AHEAD of finalResult in the
      // report key order so they survive the summary window. Record arrays
      // (arrays of objects) stay in finalResult only.
      function resultDebugDigest(finalResult) {
        if (!finalResult || typeof finalResult !== 'object' || Array.isArray(finalResult)) return null;
        const out = {};
        let used = 0;
        for (const entry of Object.entries(finalResult)) {
          if (Object.keys(out).length >= 4 || used >= 1500) break;
          const v = entry[1];
          if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object') continue;
          let s;
          try { s = JSON.stringify(v); } catch (e) { s = String(v); }
          if (typeof s !== 'string') s = String(s);
          if (s.length > 300) s = s.slice(0, 300) + '…[truncated]';
          if (used + s.length > 1500) break;
          out[entry[0]] = s;
          used += s.length;
        }
        return Object.keys(out).length ? out : null;
      }

      const score = WU.scoreAttemptResult(finalData, outputSchema);
      // Sixty-seventh log: the partial-empty census reached the model as a
      // bare tag + detector rows while it blind-rewrote the extraction 8
      // times with ZERO probe.snippet uses. Carry a short teaching note on
      // the report itself so the advisory path (non-required fields) also
      // routes snippet-first.
      const partialEmptyNote = (Array.isArray(detectors.partialEmptyFields) && detectors.partialEmptyFields.length)
        ? 'PARTIAL_EMPTY_FIELDS census: ' + detectors.partialEmptyFields
            .slice(0, 4).map((pe) => String(pe.path) + ' empty in ' + pe.emptyCount + '/' + pe.totalCount).join('; ') +
          '. Read the failing records\' source values (resultPreview / emptyRecordSamples contexts / diag.read) ' +
          'and dry-run the fix with probe.snippet before re-authoring — regexes and fieldMap selectors must be ' +
          'written against OBSERVED values, not hoped-for shapes.'
        : null;
      const report = {
        ok: !error,
        error: error ? { message: error.message, stepId: error.stepId || null } : null,
        aborted: !!(error && /TEST_ABORTED/.test(error.message)),
        score: score,
        scoreNote: scoreMismatchNote(score, finalData, outputSchema) || schemaBlindNote(outputSchema) || adMarkerNote(detectors.adMarkerSelectors),
        schemaOk: !!oc.ok,
        schemaMissing: oc.missing || [],
        detectors: detectors,
        partialEmptyNote: partialEmptyNote,
        steps: compactSteps,
        resultDebug: result ? resultDebugDigest(result.finalResult) : null,
        finalResult: result ? WU.sampleRecordsForLLMContext(result.finalResult, { recordKeep: 3, stringCap: 2000 }) : null,
        pages: result && Array.isArray(result.pages)
          ? (result.pagesTruncated ? result.pages.length + '+' : String(result.pages.length))
          : '0',
        eventCount: events.length,
        degraded: wuMissing ? ('wizard-utils functions unavailable, detectors degraded: ' + wuMissing.join(', ')) : undefined,
        // TAG strings for knowledge auto-attach — the engine reads result.events on the tool result, so this key name is contract, not preference (raw event log is the sibling top-level return field)
        events: eventTags()
      };

      return { report: report, events: events, raw: { testResult: result, error: error, breaker: zeroCounterBreaker } };

      // Catch-path augmentation (moved verbatim from wizard.js testScript):
      // re-labels bare aborts/exhaustions with precise root causes so the
      // next actor (session LLM or the user) gets a fixable signal.
      // hoisted — declared after the return for top-down reading
      function augmentError(e, stepDefsOfService, evts) {
        try {
          if (zeroCounterBreaker && /TEST_ABORTED/.test(e.message || '')) {
            const stepDefZ = stepDefsOfService.find((s) => String(s.id) === String(zeroCounterBreaker.stepId));
            e.message = 'ZERO_COUNTER_FROZEN: step "' + (stepDefZ ? stepDefZ.name : zeroCounterBreaker.stepId) + '" returned not-ready for ' + zeroCounterBreaker.streak +
              ' consecutive iterations (over ' + Math.round((zeroCounterBreaker.elapsedMs || 0) / 1000) + 's) while its counter field(s) [' + zeroCounterBreaker.counterFields.join(', ') + '] stayed 0 and never once rose. ' +
              'The counting FILTER inside the step (JS logic — e.g. a stable-detail-link filter such as a URL-pattern check) matched nothing on the page, and an exhausted exit guarded by `count > 0` can never fire at count 0, so the run scrolled toward maxIterations and was stopped by the circuit breaker. ' +
              'Fix per the zero-trap method: (1) SAMPLE the raw values before filtering — extract them (e.g. $extractListMulti(containerSel, { h: { selector: \'a[href]\', attr: \'href\' } }, { allowEmpty: true })) and inspect what the hrefs actually look like, then write the regex around the observed shapes; ' +
              '(2) remove any `count > 0` guard from the exhausted exit; (3) keep a RAW fallback counter (records.length / $count(containerSel)) so the loop can still exit when the filter matches nothing. Original error: ' + e.message;
            e.stepId = zeroCounterBreaker.stepId;
          }
          if (/POLL_EXHAUSTED/.test(e.message || '')) {
            // Thirtieth log: `const n = $count(sel)` WITHOUT await — n holds a
            // Promise, `n > 0` is always false, the poll can never go done,
            // and ten turns burned on misdiagnoses (slow cold-load, transient
            // hydration) because the clone error only surfaces later, if at
            // all. Lint the failing step's script AT FAILURE TIME and name the
            // bug in one read — more specific than the selector/zero arms, so
            // it takes precedence over them.
            let unawaitedAugmented = false;
            if (typeof WU.detectUnawaitedDollarCalls === 'function') {
              let lintScope = e.stepId ? stepDefsOfService.filter((s) => String(s.id) === String(e.stepId)) : [];
              if (!lintScope.length) lintScope = stepDefsOfService;
              const unawaited = [];
              for (const s of lintScope) {
                const lintHits = WU.detectUnawaitedDollarCalls(String((s && s.script) || ''));
                for (const h of lintHits) unawaited.push({ stepId: s && s.id, name: (s && s.name) || String(s && s.id), hit: h });
              }
              if (unawaited.length) {
                const first = unawaited[0];
                e.message = 'POLL_EXHAUSTED — root cause: UNAWAITED_ASYNC_CALL. Step "' + first.name + '" calls ' +
                  unawaited.map((u) => u.hit.api + '()').join(', ') + ' WITHOUT await — a bare $ call returns a Promise, so every comparison on it (n > 0, if (n), === expected) is false/undefined FOREVER and the step can never return done; the count you think you read was never a number. ' +
                  'Fix: await the call — const n = await ' + first.hit.api + '(sel); — near: ' + first.hit.near + '. Original error: ' + e.message;
                if (!e.stepId && first.stepId) e.stepId = first.stepId;
                unawaitedAugmented = true;
              }
            }
            const blind = !unawaitedAugmented && WU.detectCountSelectorBlind(evts);
            if (blind) {
              const stepDefB = stepDefsOfService.find((s) => String(s.id) === String(blind.stepId));
              e.message = 'POLL_EXHAUSTED — root cause: COUNT_SELECTOR_BLIND. Step "' + (stepDefB ? stepDefB.name : blind.stepId) + '" polled ' +
                blind.blindIterations + ' not-ready iteration(s), and EVERY selector it queried matched 0 elements on every iteration: [' +
                blind.selectors.map((s) => JSON.stringify(s)).join(', ') + ']. ' +
                "The step cannot see the content it is polling for. Either (a) the selector is wrong for this page's DOM structure — rigid child-combinator chains like A > div > B commonly fail on real nesting; prefer the descendant form A B — or (b) the content never rendered (viewport-gated: scroll inside the poll step). " +
                'Check SELECTOR DIAGNOSTICS for empirical match counts, and propagate any selector fix to every step referencing the same list. Original error: ' + e.message;
              if (!e.stepId) e.stepId = blind.stepId;
            }
            if (!zeroCounterBreaker && typeof WU.detectFrozenZeroCounter === 'function') {
              const frozen = WU.detectFrozenZeroCounter(evts);
              if (frozen) {
                const stepDefF = stepDefsOfService.find((s) => String(s.id) === String(frozen.stepId));
                e.message = 'POLL_EXHAUSTED — root cause: ZERO_COUNTER_FROZEN. Step "' + (stepDefF ? stepDefF.name : frozen.stepId) + '" returned not-ready for ' +
                  frozen.frozenIterations + ' iterations while its counter field(s) [' + frozen.counterFields.join(', ') + '] were 0 on EVERY iteration and never once rose' +
                  (frozen.selectorMatchedSomething ? ' — even though its selectors DID match elements (check SELECTOR DIAGNOSTICS), so a counting FILTER inside the step (JS logic such as a URL-pattern filter), not the selector, excluded everything' : '') +
                  '. Fix per the zero-trap method: sample the raw values before filtering, write the filter regex around the OBSERVED shapes, remove any `count > 0` guard from the exhausted exit, and keep a RAW fallback counter. Original error: ' + e.message;
                if (!e.stepId) e.stepId = frozen.stepId;
              }
            }
          }
          // Twenty-seventh log: v3 put `$wait(cnt)` INSIDE a count-check poll
          // loop — but $wait THROWS on an absent selector, and absence was the
          // loop's waiting condition (content not hydrated yet). The bare
          // ELEMENT_NOT_FOUND taught nothing, so the model guessed at href
          // shapes and burned another turn on a broken update.
          if (/^ELEMENT_NOT_FOUND/.test(e.message || '')) {
            const selTxt = String(e.message).replace(/^ELEMENT_NOT_FOUND:\s*/, '').split(' (')[0];
            let scope = stepDefsOfService.filter((s) => String(s.id) === String(e.stepId));
            if (!scope.length && selTxt) {
              scope = stepDefsOfService.filter((s) => String((s && s.script) || '').indexOf(selTxt) !== -1);
            }
            if (!scope.length) scope = stepDefsOfService;
            if (scope.some((s) => String((s && s.script) || '').indexOf('$wait(') !== -1)) {
              e.message += " — NOTE: $wait(sel) THROWS when its selector never appears within its cap. If this selector's absence is the waiting condition itself (content not hydrated yet inside a poll loop), $wait is the wrong tool: $count(sel) and return { done: false } so the step's maxIterations drives the wait, or $wait on a broader anchor that is present from initial load.";
            }
          }
          if (/is not a valid selector/i.test(e.message || '')) {
            e.message += " — NOTE: only standard CSS selectors are valid in querySelector/querySelectorAll. Playwright-only pseudo-classes such as :has-text(...), :text=..., :contains(...) do NOT exist here and throw instantly. Select by structure (tag/role/aria/class), then filter by visible text in JS: const els = await $list('h2, div[role=\"heading\"]'); const hit = els.find(el => /your phrase/i.test(el.textContent || ''));";
          }
          if (/could not be cloned/i.test(e.message || '')) {
            e.message += ' — NOTE: the step returned an object containing an un-awaited Promise. Every $ API call ($count, $extract, $extractList, ...) is async: await it first (const n = await $count(sel);) before using its value, and never place a bare call inside the returned object.';
          }
          if (/querySelectorAll is not a function|\.closest is not a function/i.test(e.message || '')) {
            e.message += ' — NOTE: $list (and element data from $) returns serializable DATA objects — plain snapshots with text/attrs — not live DOM nodes: you cannot call querySelector(All)/closest on them. Query the page itself instead ($extractList with per-field sub-selectors) or read the snapshot properties directly.';
          }
          // Seventh-live-log J2: the session burned its ENTIRE turn budget on
          // research and died at its first verify because the authored step
          // script had one missing ')'. A bare engine message gives the model
          // nothing structural to fix — teach the shape that produces it.
          if (/missing \) after argument list|missing \} after property list/i.test(e.message || '')) {
            e.message += ' — NOTE: the step script has UNBALANCED brackets — it never compiled. The common authoring shape is an arrow function returning an object literal inside a call, e.g. .map((r) => ({ field: r.field })) — that needs BOTH closers })) (the object\'s } then the call\'s ). The script runs as the BODY of an async function, so every ( { [ opened anywhere in it must be closed before the end. Re-send the step with balanced brackets.';
          }
        } catch (_) { /* augmentation must never mask the original error */ }
        return e;
      }
    };
  }

  const api = { createVerifyRunner, detectJunkValues, detectFieldRegression };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.VerifyRunner = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
