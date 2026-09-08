// stampSourcePageId(target, pageId) — non-destructively attach sourcePageId
// to every record in the result, per the spec's attachment rules:
//   - if target is an array: stamp each object element
//   - if target is an object: for every value that is an array of objects,
//     stamp each element of that array; otherwise (flat object) stamp top-level
//   - never overwrite an existing sourcePageId (script-set provenance wins)
// Single-level only: nested arrays (object containing array containing
// objects containing another array of objects) only stamp at the outermost
// array — inner arrays are left to the script to manage. This keeps the
// stamping predictable and avoids surprising deep mutation.
//
// Note: the orchestrator's caller-side guard (`!Array.isArray(result)`) rejects
// bare-array results before reaching this helper, so the array branch in the
// early-return below is defensive only. Scripts that return a bare array of
// records should wrap as `{items: [...]}` for provenance stamping to apply.
function stampSourcePageId(target, pageId) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return;
  const arrays = Object.values(target).filter(v => Array.isArray(v));
  if (arrays.length === 0) {
    // Flat object: stamp top-level only.
    if (target.sourcePageId === undefined) target.sourcePageId = pageId;
    return;
  }
  for (const arr of arrays) {
    for (const rec of arr) {
      if (rec && typeof rec === 'object' && !Array.isArray(rec) && rec.sourcePageId === undefined) {
        rec.sourcePageId = pageId;
      }
    }
  }
}

// Top of file — load PageTracker for RC16 page-list tracking.
// In Node tests, require() scopes the class to this module; mirror the
// runtime by also attaching to global. (Same pattern as UrlTemplate.)
let _PageTracker = null;
try {
  if (typeof require === 'function') {
    _PageTracker = require('./page-tracker').PageTracker;
  }
} catch { /* fall through to global lookup below */ }
const PageTrackerRef = _PageTracker || (typeof PageTracker !== 'undefined' ? PageTracker : null);

// Twenty-ninth log: result previews were head-only slices, so summary keys a
// script placed at the END of its return value (instrumented counts like a
// timeMapSize probe — the evidence that discriminates "value never extracted"
// from "value lost downstream") were destroyed before any report could show
// them. Canonical impl: wizard-utils.headTailSlice (head ~70% + '…' + tail).
// Node resolves it via require at load; in the service worker the global only
// appears once sibling importScripts finish, so resolution retries at call
// time — importScripts order stays irrelevant.
let _HeadTailSlice = null;
try {
  if (typeof require === 'function') {
    const _wu = require('./wizard-utils');
    if (_wu && typeof _wu.headTailSlice === 'function') _HeadTailSlice = _wu.headTailSlice;
  }
} catch { /* fall through to the call-time global lookup */ }

function previewOf(result, cap) {
  const s = JSON.stringify(result);
  if (typeof s !== 'string') return s;
  const fn = _HeadTailSlice || (typeof headTailSlice === 'function' ? headTailSlice : null);
  if (fn) return fn(s, cap);
  return s.slice(0, cap);
}

class StepOrchestrator {
  static async execute(service, input, deps, options = {}) {
    debugLogger.log('info', 'step-orchestrator', 'execute start', {
      targetUrl: service.targetUrl,
      stepCount: service.steps?.length,
      input,
      timeoutMs: service.config?.timeoutMs ?? 30000,
      maxStepIterations: service.config?.maxStepIterations ?? 50
    });

    const startTime = Date.now();
    const emit = (type, payload = {}) => {
      if (typeof options.onEvent !== 'function') return;
      try {
        options.onEvent({ type, ts: Date.now(), ...payload });
      } catch (_) {
        // Swallow — UI layer may not break execution.
      }
    };

    emit('EXECUTION_START', { totalSteps: service.steps.length, targetUrl: service.targetUrl });

    if (!Array.isArray(service.steps) || service.steps.length === 0) {
      debugLogger.log('error', 'step-orchestrator', 'No steps defined');
      throw new Error('Service must have at least one step');
    }

    const config = service.config || {};
    const timeoutMs = config.timeoutMs ?? 30000;
    const maxStepIterations = config.maxStepIterations ?? 50;
    const autoCloseTab = config.autoCloseTab ?? true;

    const resolvedUrl = UrlTemplate.resolveTargetUrl(service.targetUrl, input);
    if (resolvedUrl !== service.targetUrl) {
      debugLogger.log('info', 'step-orchestrator', 'Resolved URL template', {
        template: service.targetUrl, resolvedUrl
      });
    }
    const tab = await deps.createTab(resolvedUrl);
    const tabId = tab.id;
    debugLogger.log('info', 'step-orchestrator', 'Tab created', { tabId, url: resolvedUrl });
    const stepOutputs = [];
    // RC16: the tracker may be supplied externally (background.js shares it
    // with handleOpenTabExecute so sub-tab captures reach the same list).
    // Fall back to instantiating one locally for backward compat with tests
    // and other call sites that don't supply options.tracker.
    const tracker = options.tracker || (PageTrackerRef
      ? new PageTrackerRef({
          capturePages: config.capturePages !== false,
          maxPagesCaptured: config.maxPagesCaptured
        })
      : null);
    let currentPageId = null;
    const stepIterationCounts = {};
    const enteredStepIds = new Set();

    try {
      // Forty-first log: step scripts execute in the sandbox iframe's SHARED
      // global scope — a script that parks state on globalThis (a scroll-stall
      // counter) leaves it for the NEXT orchestration run, and a later
      // unrelated verify run read the stale counter and declared "feed
      // exhausted" after one iteration. Scrub non-framework globals at every
      // run boundary (best-effort). Within-run poll-step persistence is
      // untouched: this runs once per execute(), not per step iteration.
      try {
        await deps.executeScript(tabId,
          'if (typeof globalThis.__scrapewrightScrubSandbox === "function") { try { globalThis.__scrapewrightScrubSandbox(); } catch (e) {} }\nreturn { sandboxScrubbed: true };',
          {}, 10000);
        debugLogger.log('info', 'step-orchestrator', 'Sandbox globals scrubbed for run', { tabId });
      } catch (e) {
        debugLogger.log('warn', 'step-orchestrator', 'Sandbox scrub best-effort failed', { tabId, error: e && e.message });
      }
      await deps.waitForTabLoad(tabId);
      debugLogger.log('info', 'step-orchestrator', 'Tab loaded', { tabId });
      // RC16 (console.log 2026-07-27 16:44): re-inject visibility-keepalive
      // AFTER page load completes. The early injection inside createScrapeTab's
      // afterTabOpen uses injectImmediately:true, which runs the function in
      // a transient pre-load context whose window writes are discarded by the
      // time the page actually finishes loading. Verification at the post-load
      // context reads injected:false. Re-injecting here runs in the persistent
      // post-load context, so the visibilityState override actually sticks.
      if (typeof injectVisibilityKeepalive === 'function') {
        try {
          const reinject = await injectVisibilityKeepalive(tabId);
          debugLogger.log('info', 'step-orchestrator', 'Post-load visibility keepalive injection', { tabId, ...reinject });
          if (typeof verifyVisibilityKeepalive === 'function') {
            const reverify = await verifyVisibilityKeepalive(tabId);
            debugLogger.log('info', 'step-orchestrator', 'Post-load visibility keepalive verification', { tabId, ...reverify });
          }
        } catch (e) {
          debugLogger.log('warn', 'step-orchestrator', 'Post-load visibility keepalive injection failed', { tabId, error: e && e.message });
        }
      }
      const firstStepId = service.steps[0].id;
      if (typeof firstStepId !== 'string') {
        throw new Error('Service first step must have a valid id');
      }
      let currentStepId = firstStepId;
      let lastStepResult = null;
      let globalIteration = 0;
      const stepResultsMap = {};

      // Auto-boost maxIterations for steps that are loop-back targets
      const stepsMap = new Map();
      for (const s of service.steps) stepsMap.set(s.id, { ...s });
      for (let i = 0; i < service.steps.length; i++) {
        const step = service.steps[i];
        const target = step.onSuccess;
        if (target && target !== 'TERMINATE') {
          const targetIdx = service.steps.findIndex(s => s.id === target);
          if (targetIdx >= 0 && targetIdx < i) {
            for (let j = targetIdx; j <= i; j++) {
              const sid = service.steps[j].id;
              const existing = stepsMap.get(sid);
              if (existing.maxIterations == null || existing.maxIterations === 1) {
                stepsMap.set(sid, { ...existing, maxIterations: maxStepIterations });
              }
            }
          }
        }
      }

      while (currentStepId !== 'TERMINATE' && currentStepId !== null && currentStepId !== undefined) {
        globalIteration++;
        debugLogger.log('info', 'step-orchestrator', 'Step iteration', { globalIteration, currentStepId });

        if (globalIteration > maxStepIterations) {
          debugLogger.log('error', 'step-orchestrator', 'Max step iterations exceeded', { globalIteration, maxStepIterations });
          throw new Error('STEP_ITERATION_EXCEEDED');
        }

        const step = stepsMap.get(currentStepId);
        if (!step) {
          debugLogger.log('error', 'step-orchestrator', 'Step not found', { currentStepId });
          throw new Error('STEP_NOT_FOUND');
        }

        if (!enteredStepIds.has(step.id)) {
          enteredStepIds.add(step.id);
          emit('STEP_START', {
            stepId: step.id,
            stepName: step.name,
            stepIndex: service.steps.findIndex(s => s.id === step.id),
            maxIterations: step.maxIterations ?? 1
          });
        }

        if (!step.script || !step.script.trim()) {
          debugLogger.log('error', 'step-orchestrator', 'Step has empty script', { stepId: step.id });
          const err = new Error('SCRIPT_ERROR: Step "' + step.id + '" has empty script');
          err.stepId = step.id;
          throw err;
        }

        const stepIterations = (stepIterationCounts[step.id] || 0) + 1;
        stepIterationCounts[step.id] = stepIterations;

        const maxIterations = step.maxIterations ?? 1;
        if (stepIterations > maxIterations) {
          debugLogger.log('warn', 'step-orchestrator', 'Max iterations exceeded for step', { stepId: step.id, stepIterations, maxIterations });
          stepOutputs.push({
            stepId: step.id,
            stepName: step.name,
            result: null,
            skipped: true,
            skipReason: 'MAX_ITERATIONS',
            timestamp: Date.now()
          });
          emit('STEP_DONE', {
            stepId: step.id,
            resultPreview: '(skipped: max iterations exceeded)',
            iterations: stepIterations
          });
          currentStepId = step.onFailure || 'TERMINATE';
          continue;
        }

        if (step.condition) {
          debugLogger.log('info', 'step-orchestrator', 'Evaluating condition', { stepId: step.id, condition: step.condition });
          const conditionResult = await deps.evaluateCondition(tabId, step.condition);
          debugLogger.log('info', 'step-orchestrator', 'Condition result', { stepId: step.id, result: conditionResult });
          if (!conditionResult) {
            stepOutputs.push({
              stepId: step.id,
              stepName: step.name,
              result: null,
              skipped: true,
              skipReason: 'CONDITION_FALSE',
              timestamp: Date.now()
            });
            emit('STEP_DONE', {
              stepId: step.id,
              resultPreview: '(skipped: condition false)',
              iterations: 0
            });
            currentStepId = step.onFailure || 'TERMINATE';
            continue;
          }
        }

        debugLogger.log('info', 'step-orchestrator', 'Executing script', {
          stepId: step.id,
          stepName: step.name,
          script: step.script,
          scriptLength: step.script?.length
        });

        let result;
        let snapshot = null;
        const maxIter = step.maxIterations ?? 1;
        try {
          const enrichedInput = { ...input, _stepResults: { ...stepResultsMap }, _lastResult: lastStepResult };
          if (typeof deps.resetDomActivity === 'function') {
            try { await deps.resetDomActivity(tabId); } catch (_) {}
          }
          const execResult = await deps.executeScript(tabId, step.script, enrichedInput, timeoutMs);
          // Backward compat: legacy executors resolve with the raw result.
          // New executors resolve with { result, selectorDiagnostics }.
          // Detect the envelope by checking for the 'result' key — no
          // existing fake in the test suite returns an object with a
          // 'result' key, so the shim stays unambiguous.
          const selectorDiagnostics = (execResult && typeof execResult === 'object' && Array.isArray(execResult.selectorDiagnostics))
            ? execResult.selectorDiagnostics
            : [];
          result = (execResult && typeof execResult === 'object' && 'result' in execResult)
            ? execResult.result
            : execResult;
          let domActivity = [];
          if (typeof deps.getDomActivity === 'function') {
            try { domActivity = await deps.getDomActivity(tabId) || []; } catch (_) {}
          }
          const resultPreview = previewOf(result, 500);
          debugLogger.log('info', 'step-orchestrator', 'Script executed', { stepId: step.id, resultType: typeof result, resultPreview, selectorDiagnosticCount: selectorDiagnostics.length });
          emit('STEP_ITERATION', {
            stepId: step.id,
            iteration: stepIterations,
            maxIterations: maxIter,
            domActivity,
            resultPreview,
            selectorDiagnostics
          });
        } catch (error) {
          debugLogger.log('error', 'step-orchestrator', 'Script execution failed', { stepId: step.id, error: error.message, stack: error.stack, hasSubTabSnapshot: !!error.subTabSnapshot });
          // If the failure originated inside $openTab, handleOpenTabExecute
          // already captured the sub-tab's DOM before destroying it. That
          // snapshot shows the actual page the script was operating on
          // (post-interaction state, same session as the user). Prefer it
          // over capturing the main tab, which is typically the search/list
          // page and useless for fixing a detail-page script.
          if (error.subTabSnapshot) {
            error.snapshot = error.subTabSnapshot;
            debugLogger.log('info', 'step-orchestrator', 'Using sub-tab snapshot from $openTab failure', { stepId: step.id, snapshotSize: error.subTabSnapshot.html?.length || error.subTabSnapshot.structure?.length });
          } else if (deps.captureSnapshot) {
            try {
              error.snapshot = await deps.captureSnapshot(tabId);
              debugLogger.log('info', 'step-orchestrator', 'Snapshot captured on failure', { stepId: step.id, snapshotSize: error.snapshot?.html?.length || error.snapshot?.structure?.length });
            } catch {
              error.snapshot = null;
            }
          }
          error.stepId = step.id;
          throw error;
        }

        if (deps.captureSnapshot) {
          try {
            snapshot = await deps.captureSnapshot(tabId);
            debugLogger.log('info', 'step-orchestrator', 'Snapshot captured', { stepId: step.id, snapshotSize: snapshot?.html?.length || snapshot?.structure?.length });
            if (tracker && snapshot) {
              currentPageId = tracker.record(snapshot, {
                sourceStepId: step.id,
                captureReason: 'step_iteration'
              });
            }
          } catch {
            snapshot = null;
            currentPageId = null;
          }
        }

        // Stash the (possibly stamped) result on the step output AND update lastStepResult
        // to point at the stamped version, so the finalResult carries sourcePageId.
        if (tracker && currentPageId && result && typeof result === 'object' && !Array.isArray(result)) {
          stampSourcePageId(result, currentPageId);
        }

        lastStepResult = result;
        stepResultsMap[step.id] = result;
        stepOutputs.push({
          stepId: step.id,
          stepName: step.name,
          result,
          snapshot,
          timestamp: Date.now()
        });

        // ---- Model A next-step decision -------------------------------------
        // onSuccess = advance on success; onFailure = failure / give-up; polling
        // is expressed by maxIterations>1 + a not-ready signal (no SELF sentinel).
        // A normal step (maxIterations<=1) never has its result inspected for
        // retry signals — its result is pure data and always follows onSuccess,
        // so a step that happens to return {done:false} as data cannot mis-route.
        let next = step.onSuccess ?? 'TERMINATE';
        if (result && typeof result === 'object') {
          const isFailed = result.failed === true
            || (typeof result.error === 'string' && result.error.length > 0);
          const notReady = result.done === false || result.ready === false ||
                           result.complete === false || result.finished === false ||
                           result.responseReady === false ||
                           result.generating === true || result.loading === true;
          if (isFailed) {
            // Explicit failure signal: bail to onFailure without throwing, so an
            // expected failure can branch cleanly (independent of maxIterations).
            next = step.onFailure ?? 'TERMINATE';
            debugLogger.log('warn', 'step-orchestrator', 'Result signals failure, following onFailure', { stepId: step.id, onFailure: next });
          } else if (notReady && maxIter > 1) {
            // Retry semantics only engage when the step opted in via maxIterations>1.
            if (stepIterations < maxIter) {
              // Re-invoke the same step (consumes one iteration; bounded by the
              // per-step cap above and the global maxStepIterations backstop).
              next = step.id;
              debugLogger.log('warn', 'step-orchestrator', 'Result not ready, retrying step', { stepId: step.id, stepIterations, maxIter });
            } else {
              // Budget exhausted: give up → onFailure. Route directly WITHOUT a
              // synthetic MAX_ITERATIONS skip so the real not-ready result is
              // preserved for auto-fix to inspect.
              next = step.onFailure ?? 'TERMINATE';
              if (next === 'TERMINATE') {
                // Polling exhausted AND routes straight to TERMINATE — throw a
                // clear POLL_EXHAUSTED error instead of letting the not-ready
                // value (e.g. {done:false}) flow into finalResult. Without this,
                // outputSchema validation produces a misleading "missing required
                // field" error that hides the real cause: the step ran out of
                // retries without ever producing data.
                //
                // Twenty-seventh log: the poll's own not-ready payloads
                // ({done:false, seen:n}) carry the progress trajectory (a count
                // plateau was the WHOLE diagnosis) but never reached the model —
                // err.steps has them structurally, yet every consumer reads the
                // message. Embed the last few returns inline.
                const traj = [];
                for (let ti = stepOutputs.length - 1; ti >= 0 && traj.length < 3; ti--) {
                  const so = stepOutputs[ti];
                  if (!so || String(so.stepId) !== String(step.id)) continue;
                  // sourcePageId is the engine's own bookkeeping stamp (RC16) —
                  // strip it so the trajectory shows only what the step returned.
                  let r = so.result;
                  if (r && typeof r === 'object' && !Array.isArray(r) && 'sourcePageId' in r) {
                    r = Object.assign({}, r);
                    delete r.sourcePageId;
                  }
                  let preview;
                  try {
                    preview = JSON.stringify(r);
                  } catch (e) {
                    preview = String(r);
                  }
                  if (typeof preview !== 'string') preview = String(preview);
                  traj.unshift(preview.length > 120 ? preview.slice(0, 117) + '…' : preview);
                }
                const trajNote = traj.length
                  ? '; last not-ready return(s): ' + traj.join(' -> ')
                  : '';
                const err = new Error(`POLL_EXHAUSTED: Step "${step.name || step.id}" exhausted after ${stepIterations} attempt(s) without producing a ready result${trajNote}`);
                err.code = 'POLL_EXHAUSTED';
                err.stepId = step.id;
                err.steps = stepOutputs;
                debugLogger.log('error', 'step-orchestrator', 'Poll exhausted → TERMINATE', { stepId: step.id, stepIterations });
                throw err;
              }
              debugLogger.log('warn', 'step-orchestrator', 'Result not ready and retry budget exhausted, following onFailure', { stepId: step.id, stepIterations, maxIter, onFailure: next });
            }
          }
          // else: ready / plain data / {done:true} → next stays onSuccess.
          // A non-poll step (maxIterations<=1) returning {done:false} as data
          // falls through here unchanged → onSuccess (data-collision safe).
        }

        debugLogger.log('info', 'step-orchestrator', 'Next step decision', { stepId: step.id, next });
        if (next !== step.id) {
          emit('STEP_DONE', {
            stepId: step.id,
            resultPreview: previewOf(result, 500),
            iterations: stepIterations
          });
        }
        currentStepId = next;
      }

      debugLogger.log('info', 'step-orchestrator', 'Execution complete', { finalResultType: typeof lastStepResult, stepCount: stepOutputs.length });
      emit('EXECUTION_DONE', { finalResultType: typeof lastStepResult, totalElapsedMs: Date.now() - startTime });
      const { pages, pagesTruncated } = tracker
        ? tracker.listWithMeta()
        : { pages: [], pagesTruncated: 0 };
      return { finalResult: lastStepResult, steps: stepOutputs, pages, pagesTruncated };
    } catch (error) {
      debugLogger.log('error', 'step-orchestrator', 'Execution failed', { error: error.message, stepId: error.stepId, stack: error.stack });
      if (error.stepId) {
        emit('STEP_FAILED', {
          stepId: error.stepId,
          error: error.message,
          selectorDiagnostics: Array.isArray(error.selectorDiagnostics) ? error.selectorDiagnostics : [],
          iterations: stepIterationCounts[error.stepId] || 0
        });
      }
      emit('EXECUTION_DONE', { finalResultType: 'error', totalElapsedMs: Date.now() - startTime });
      error.steps = stepOutputs;
      if (tracker) {
        const { pages, pagesTruncated } = tracker.listWithMeta();
        error.pages = pages;
        error.pagesTruncated = pagesTruncated;
      }
      throw error;
    } finally {
      if (autoCloseTab !== false) {
        await deps.removeTab(tabId);
        debugLogger.log('info', 'step-orchestrator', 'Tab removed', { tabId });
      }
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { StepOrchestrator };
} else if (typeof window !== 'undefined') {
  window.StepOrchestrator = StepOrchestrator;
}
