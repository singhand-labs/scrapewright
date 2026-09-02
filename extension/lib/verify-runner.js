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
      detectHoverAnchorsBlind: w.detectHoverAnchorsBlind,
      detectCountSelectorBlind: w.detectCountSelectorBlind,
      detectFrozenZeroCounter: w.detectFrozenZeroCounter,
      findEmptyExtractionFields: w.findEmptyExtractionFields,
      findUpstreamExtractionStepId: w.findUpstreamExtractionStepId,
      detectDuplicateRecords: w.detectDuplicateRecords,
      detectCountShortfall: w.detectCountShortfall,
      validateOutputAgainstSchema: w.validateOutputAgainstSchema,
      scoreAttemptResult: w.scoreAttemptResult,
      stripSnapshotsFromTestResult: w.stripSnapshotsFromTestResult,
      sampleRecordsForLLMContext: w.sampleRecordsForLLMContext
    };
    const missing = [];
    for (const k of Object.keys(bag)) {
      if (k.indexOf('FROZEN_') !== 0 && typeof bag[k] !== 'function') { bag[k] = function () { return null; }; missing.push(k); }
    }
    if (missing.length) {
      try { console.warn('[verify-runner] wizard-utils functions unavailable (detectors degraded): ' + missing.join(', ')); } catch (e) { /* warn is best-effort */ }
      bag.__missing = missing;
    }
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

  function isQueryBlob(v) {
    return typeof v === 'string' && v.length > 3 && /^\?[^=]+=/.test(v);
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

  function scanRecords(recs, fieldPath, urlishHints, rawishHints, fields) {
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
      for (const r of recs) {
        const v = r[rk];
        if (typeof v === 'string') {
          if (isQueryBlob(v)) { blobs += 1; if (!blobSample) blobSample = v; }
          if (!isRawishName(rk, rawishHints) && isMarkupDump(v)) { dumps += 1; if (!dumpSample) dumpSample = v; }
        } else if (Array.isArray(v)) {
          for (const x of v) {
            if (typeof x !== 'string') continue;
            dataTotal += 1;
            if (x.indexOf('data:') === 0) { dataJunk += 1; }
          }
        }
      }
      if (blobs) fields.push({ field: fieldPath + '.' + rk, kind: 'queryBlob', count: blobs, sample: capSample(blobSample) });
      if (dataJunk && isUrlishName(rk, urlishHints)) fields.push({ field: fieldPath + '.' + rk, kind: 'dataUri', junkCount: dataJunk, total: dataTotal });
      if (dumps) fields.push({ field: fieldPath + '.' + rk, kind: 'markupDump', count: dumps, sample: capSample(dumpSample) });
    }
  }

  function detectJunkValues(data, schema) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const urlishHints = collectFieldHints(schema, /(url|link|href|src|image|photo|picture|media|avatar)/i);
    const rawishHints = collectFieldHints(schema, /(html|markup|raw source|embedded)/i);
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
          if (recs.length) scanRecords(recs, fieldPath, urlishHints, rawishHints, fields);
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
        '. Structurally green but these values are junk: bare query strings ("?a=b…") are redirect/tracking href fragments, data: URIs inside url/media arrays are inline UI icons, markup dumps are raw HTML leaking into a data field. Fix the selector to read the real value, filter arrays in the step script (keep http(s) entries), or renegotiate the contract with io.confirm to drop/redefine the field. A green score with junk-valued fields is NOT a finished service.'
    };
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
            let createTimedOut = false;
            const createPromise = d.createTab(url).then((created) => {
              if (createTimedOut) {
                d.removeTab(created).catch(() => {});
                throw new Error('Tab arrived after the create timeout — closed to avoid a leaked background tab.');
              }
              return created;
            });
            try {
              tab = await withTimeout(createPromise, 10000, 'Failed to create tab (10s timeout)');
            } catch (e) {
              createTimedOut = true;
              throw e;
            }
            log('Opening ' + url + '...');
            return tab;
          },
          waitForTabLoad: async (tabId) => {
            await withTimeout(d.waitForTabLoad(tabId), 60000, 'Page load timeout (60s)');
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
      const detectors = { emptyFields: [], duplicateFields: [], countShortfall: null, shapeDistribution: null, stepNoReturn: null, junkValues: null };
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

      if (error) {
        augmentError(error, stepsDefs, events);
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
            error = toError(
              'CLICK_CONTAINERS_EMPTY: step "' + (stepDefCE ? stepDefCE.name : containersEmpty.stepId) + '" called $clickInList' +
              (containersEmpty.containerSelector ? ' with container selector ' + JSON.stringify(containersEmpty.containerSelector) : '') +
              ' — that container selector matched 0 element(s) on every call (' + containersEmpty.calls + ' call(s)), so the click action never had anything to operate on. ' +
              'Fix the container selector (check SELECTOR DIAGNOSTICS and the page HTML for the real list structure — prefer descendant selectors over rigid child-combinator chains), and propagate the same fix to every step that references this list.',
              containersEmpty.stepId);
          }
        }
        if (!error && typeof WU.detectHoverAnchorsBlind === 'function') {
          const hoverBlind = WU.detectHoverAnchorsBlind(events);
          if (hoverBlind) {
            const stepDefHB = stepsDefs.find((s) => String(s.id) === String(hoverBlind.stepId));
            error = toError(
              'HOVER_ANCHORS_BLIND: step "' + (stepDefHB ? stepDefHB.name : hoverBlind.stepId) + '" called $extractWithHover' +
              (hoverBlind.anchorSel ? ' with opts.hover.anchorSel ' + JSON.stringify(hoverBlind.anchorSel) : '') +
              ' — that anchorSel matched 0 anchor elements inside EVERY processed container (' +
              hoverBlind.processedCalls + ' call(s), ' + hoverBlind.containersProcessed + ' container(s) total), so hover never ran and every record got hovercards:[] with ZERO entries. ' +
              'This is NOT "hovered but no card appeared" — the anchor was never found. anchorSel is evaluated as container.querySelectorAll(anchorSel): it must match INSIDE each container subtree. ' +
              'The real interactive link is often nested inside wrapper elements (e.g. an <object> wrapper or an aria-hidden shell around the visible link), or sits in a different branch than the intermediate block named in the selector chain — ' +
              "prefer a short, container-scoped tag+[attr] form and verify it against one container's HTML in SELECTOR DIAGNOSTICS. Fix anchorSel and propagate the fix to every step that uses the same anchor, or drop the hover option and use $extractList if hovercard data is not required.",
              hoverBlind.stepId);
          }
        }
        if (!error) {
          const emptyFields = WU.findEmptyExtractionFields(finalData, outputSchema) || []; // null when degraded (C11)
          if (emptyFields.length > 0) {
            const nominalStepId = lastStepEntry && lastStepEntry.stepId;
            detectors.emptyFields = emptyFields;
            error = toError(
              'EMPTY_EXTRACTION: required field(s) [' + emptyFields.join(', ') + '] are present but every extracted item has only empty values, or no items were extracted at all. The script found list items but the field selectors are wrong.',
              walkBack(nominalStepId),
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
        if (!error && typeof WU.detectCountShortfall === 'function') {
          // Report-only: forcing retries toward an unreachable count is the
          // ZERO-TRAP deadlock; surface it and let the human/LLM judge.
          detectors.countShortfall = WU.detectCountShortfall(finalData, input, outputSchema) || null;
        }
        if (!error && RSD && typeof RSD.formatShapeDistributionFromData === 'function') {
          // Report-only: 2+ field-population signatures across the extracted
          // records mean the selector kept mixed card types — a card-policy
          // signal, not an error. The CARD_POLICY tag auto-attaches the
          // card-type-heterogeneity / card-polarity knowledge units.
          detectors.shapeDistribution = RSD.formatShapeDistributionFromData(finalData, outputSchema) || null;
        }
        if (!error) {
          // Report-only (tenth-log N2): the human may have confirmed a
          // contract that wants these values — surface, teach, never block.
          detectors.junkValues = detectJunkValues(finalData, outputSchema);
        }
      }

      const oc = (result ? WU.validateOutputAgainstSchema(finalData, outputSchema) : { ok: true, missing: [] }) || { ok: true, missing: [] };

      const compactSteps = result && Array.isArray(result.steps)
        ? result.steps.map((s) => ({
            stepId: s.stepId,
            stepName: s.stepName,
            skipped: !!s.skipped,
            skipReason: s.skipReason || null,
            iterations: events.filter((e) => e && e.type === 'STEP_ITERATION' && String(e.stepId) === String(s.stepId)).length
          }))
        : [];

      // hoisted — declared after the return for top-down reading
      function eventTags() {
        const tags = [];
        const add = (t) => { if (tags.indexOf(t) === -1) tags.push(t); };
        const msg = error ? String(error.message) : '';
        if (/ZERO_COUNTER_FROZEN/.test(msg)) add('COUNTER_FROZEN');
        if (/COUNT_SELECTOR_BLIND/.test(msg)) add('SELECTOR_ZERO_MATCH');
        if (/POLL_EXHAUSTED/.test(msg) && !/COUNT_SELECTOR_BLIND/.test(msg) && !/ZERO_COUNTER_FROZEN/.test(msg)) add('SELECTOR_ZERO_MATCH');
        if (/EMPTY_EXTRACTION/.test(msg)) add('EMPTY_EXTRACTION');
        if (/DUPLICATE_RECORDS/.test(msg)) add('DUPLICATE_RECORDS');
        if (/SCRIPT_TIMEOUT/.test(msg)) add('SCRIPT_TIMEOUT');
        if (/HOVER_ANCHORS_BLIND/.test(msg)) add('HOVER_NO_SIGNAL');
        if (detectors.emptyFields.length) add('EMPTY_FIELDS');
        if (detectors.countShortfall) add('COUNT_SHORTFALL');
        if (detectors.shapeDistribution) add('CARD_POLICY');
        if (detectors.stepNoReturn) add('STEP_NO_RETURN');
        if (detectors.junkValues) add('JUNK_VALUES');
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
      function scoreMismatchNote(score, data, schema) {
        if (!score || score.score !== 0 || !score.isData) return null;
        if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
        const dataKeys = Object.keys(data);
        if (!dataKeys.length) return null;
        const props = (schema && schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) ? Object.keys(schema.properties) : [];
        const req = (schema && Array.isArray(schema.required)) ? schema.required.filter(k => typeof k === 'string') : [];
        const want = req.length ? req : props;
        if (!want.length) return null;
        const which = req.length ? 'required' : 'properties';
        return 'score is 0 although extraction produced data. Scoring reads the schema\'s ' + which + ' keys against the RESULT\'s top-level keys — result keys [' + dataKeys.join(', ') + '] vs schema ' + which + ' [' + want.join(', ') + ']. Align them: rename the step\'s output field(s) or the schema so the same key appears on both sides; a key-name mismatch scores 0 no matter how complete the data is.';
      }

      const score = WU.scoreAttemptResult(finalData, outputSchema);
      const report = {
        ok: !error,
        error: error ? { message: error.message, stepId: error.stepId || null } : null,
        aborted: !!(error && /TEST_ABORTED/.test(error.message)),
        score: score,
        scoreNote: scoreMismatchNote(score, finalData, outputSchema),
        schemaOk: !!oc.ok,
        schemaMissing: oc.missing || [],
        detectors: detectors,
        steps: compactSteps,
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
            const blind = WU.detectCountSelectorBlind(evts);
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
            e.message += ' — NOTE: the step script has UNBALANCED brackets — it never compiled. The common authoring shape is an arrow function returning an object literal inside a call, e.g. .map((r) => ({ field: r.field })) — that needs BOTH closers })) (the object\'s } then the call\'s ). The script text is placed after `return`, so every ( { [ opened anywhere in it must be closed before the end. Re-send the step with balanced brackets.';
          }
        } catch (_) { /* augmentation must never mask the original error */ }
        return e;
      }
    };
  }

  const api = { createVerifyRunner, detectJunkValues };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.VerifyRunner = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
