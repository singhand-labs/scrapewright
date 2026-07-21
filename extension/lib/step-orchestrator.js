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
    const stepIterationCounts = {};

    try {
      await deps.waitForTabLoad(tabId);
      debugLogger.log('info', 'step-orchestrator', 'Tab loaded', { tabId });
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

        emit('STEP_START', {
          stepId: step.id,
          stepName: step.name,
          stepIndex: service.steps.findIndex(s => s.id === step.id),
          maxIterations: step.maxIterations ?? 1
        });

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
          result = await deps.executeScript(tabId, step.script, enrichedInput, timeoutMs);
          let domActivity = [];
          if (typeof deps.getDomActivity === 'function') {
            try { domActivity = await deps.getDomActivity(tabId) || []; } catch (_) {}
          }
          const resultPreview = JSON.stringify(result)?.slice(0, 500);
          debugLogger.log('info', 'step-orchestrator', 'Script executed', { stepId: step.id, resultType: typeof result, resultPreview });
          emit('STEP_ITERATION', {
            stepId: step.id,
            iteration: stepIterations,
            maxIterations: maxIter,
            domActivity,
            resultPreview
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
          } catch {
            snapshot = null;
          }
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
                const err = new Error(`POLL_EXHAUSTED: Step "${step.name || step.id}" exhausted after ${stepIterations} attempt(s) without producing a ready result`);
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
            resultPreview: JSON.stringify(result)?.slice(0, 500),
            iterations: stepIterations
          });
        }
        currentStepId = next;
      }

      debugLogger.log('info', 'step-orchestrator', 'Execution complete', { finalResultType: typeof lastStepResult, stepCount: stepOutputs.length });
      emit('EXECUTION_DONE', { finalResultType: typeof lastStepResult, totalElapsedMs: Date.now() - startTime });
      return { finalResult: lastStepResult, steps: stepOutputs };
    } catch (error) {
      debugLogger.log('error', 'step-orchestrator', 'Execution failed', { error: error.message, stepId: error.stepId, stack: error.stack });
      if (error.stepId) {
        emit('STEP_FAILED', {
          stepId: error.stepId,
          error: error.message,
          iterations: stepIterationCounts[error.stepId] || 0
        });
      }
      emit('EXECUTION_DONE', { finalResultType: 'error', totalElapsedMs: Date.now() - startTime });
      error.steps = stepOutputs;
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
