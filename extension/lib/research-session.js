// extension/lib/research-session.js
//
// The ResearchSession turn loop (spec §4). Drives an LLM through a
// tool-call protocol (session-protocol.js) with: goal/hypothesis state,
// transcript compaction, budgets & breakers, RC55-class LLM failure
// discipline, persistence hooks, and the §8 grounding chokepoint on
// service.update. Everything external is injected (llm, tools,
// persistence, clock, events) so the engine is fully testable offline.
//
// Site-independent by construction. IIFE-wrapped per RC30.

(function (global) {

  function resolveLib(requirePath, globalName) {
    if (typeof require !== 'undefined') {
      try { return require(requirePath); } catch (e) { /* fall through */ }
    }
    return (typeof global !== 'undefined' && global[globalName]) || null;
  }

  const Protocol = resolveLib('./session-protocol', 'SessionProtocol');
  const Gate = resolveLib('./grounding-gate', 'GroundingGate');
  const Obs = resolveLib('./observation-log', 'ObservationLogLib');
  const LedgerLib = resolveLib('./findings-ledger', 'FindingsLedgerLib');
  const KB = resolveLib('./knowledge-base', 'KnowledgeBase');

  const INTERNAL_TOOL_SPECS = [
    { name: 'ledger.add', args: '{finding, evidence?, confidence?, selectors?}', returns: '{added:true, id}' },
    { name: 'knowledge.query', args: '{ids:["unitId"]}', returns: '{units:[{id,title,body}]}' },
    { name: 'service.update', args: '{steps, overrides?}', returns: '{version} | {grounding:"rejected", rejections}' }
  ];

  const DEFAULTS = {
    budgets: { maxTurns: 40, maxTokensPerCall: 8192, tokenCap: 2000000, wallClockMs: 1800000 },
    retry: { attempts: 3, backoffMs: 400 },
    compaction: { thresholdChars: 60000, keepTurns: 6 },
    toolResultCapChars: 4000
  };

  function isErrorResult(r) {
    return !!r && typeof r === 'object' && typeof r.error === 'string';
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function createResearchSession(config) {
    const cfg = config || {};
    if (typeof cfg.llm !== 'function') throw new Error('createResearchSession requires an llm({messages,maxTokens}) function');
    if (!Protocol) throw new Error('session-protocol lib required');
    if (!Gate || !Obs || !LedgerLib || !KB) throw new Error('Plan-1 libs (grounding-gate, observation-log, findings-ledger, knowledge-base) required');

    const llm = cfg.llm;
    const tools = (cfg.tools && typeof cfg.tools === 'object') ? cfg.tools : {};
    const now = typeof cfg.now === 'function' ? cfg.now : () => Date.now();
    const onEvent = typeof cfg.onEvent === 'function' ? cfg.onEvent : () => {};
    const persistence = cfg.persistence || null;
    const budgets = Object.assign({}, DEFAULTS.budgets, cfg.budgets || {});
    const retry = Object.assign({}, DEFAULTS.retry, cfg.retry || {});
    const compaction = Object.assign({}, DEFAULTS.compaction, cfg.compaction || {});
    const toolResultCapChars = typeof cfg.toolResultCapChars === 'number' ? cfg.toolResultCapChars : DEFAULTS.toolResultCapChars;
    const knowledge = {
      units: Array.isArray(cfg.knowledge && cfg.knowledge.units) ? cfg.knowledge.units : [],
      index: Array.isArray(cfg.knowledge && cfg.knowledge.index) ? cfg.knowledge.index : []
    };

    const observationLog = Obs.createObservationLog(cfg.seed && cfg.seed.observation);
    const ledger = LedgerLib.createFindingsLedger(cfg.seed && cfg.seed.ledger);

    let SEQ = 0;
    let state = {
      id: 'rs-' + now() + '-' + (++SEQ),
      status: 'idle',
      requirement: String(cfg.requirement || ''),
      goals: [],
      hypotheses: [],
      transcript: [],
      digest: '',
      spend: { turns: 0, llmCalls: 0, promptTokens: 0, completionTokens: 0, estimated: false },
      attachedUnits: [],
      artifactVersions: [],
      elapsedMs: 0,
      stopped: null
    };
    if (cfg.seed && cfg.seed.session) {
      state = JSON.parse(JSON.stringify(cfg.seed.session));
      state.status = 'idle';
      state.stopped = null;
    }

    let abortFlag = false, abortReason = 'user';
    let pauseFlag = false;
    let running = false;
    let segmentStart = now();

    function emit(type, data) {
      try { onEvent(Object.assign({ type: type, at: now() }, data || {})); } catch (e) { /* never throw from UI */ }
    }

    function openQuestions() {
      const qs = state.goals.filter(g => g.status === 'open')
        .map(g => ({ kind: 'goal', id: g.id, text: g.text }));
      for (const h of state.hypotheses) {
        if (!h.verdict) qs.push({ kind: 'hypothesis', n: h.n, text: h.text });
      }
      return qs;
    }

    function buildReport() {
      return {
        sessionId: state.id,
        status: state.status,
        stopped: state.stopped,
        openQuestions: openQuestions(),
        turns: state.spend.turns,
        spend: Object.assign({}, state.spend),
        artifactVersions: state.artifactVersions.length,
        ledgerEntries: ledger.serialize().entries.length,
        observations: observationLog.size()
      };
    }

    function stateForPersist() {
      return {
        engine: 1,
        session: state,
        observation: observationLog.serialize(),
        ledger: ledger.serialize()
      };
    }

    async function persist() {
      if (!persistence || typeof persistence.save !== 'function') return;
      try {
        await persistence.save(stateForPersist());
        emit('persist', { turn: state.spend.turns });
      } catch (err) {
        emit('persist_error', { error: String((err && err.message) || err) });
      }
    }

    async function stop(reason, detail) {
      state.status = 'stopped';
      state.stopped = { reason: reason, detail: detail == null ? null : detail };
      emit('stopped', { reason: reason, detail: state.stopped.detail });
      await persist();
      return buildReport();
    }

    function toolSpecs() {
      if (Array.isArray(cfg.toolSpecs) && cfg.toolSpecs.length) {
        return cfg.toolSpecs.concat(INTERNAL_TOOL_SPECS);
      }
      const names = Object.keys(tools).filter(n => n !== 'service.update');
      return INTERNAL_TOOL_SPECS.concat(names.map(n => ({ name: n, args: '(see contract)', returns: '(tool result JSON)' })));
    }

    function availableToolNames() {
      return INTERNAL_TOOL_SPECS.map(s => s.name).concat(Object.keys(tools));
    }

    function buildSessionStateBlock() {
      const parts = [];
      if (state.goals.length) {
        parts.push('# Goals\n' + state.goals.map(g => '- [' + g.status + '] ' + g.id + ': ' + g.text).join('\n'));
      }
      if (state.hypotheses.length) {
        parts.push('# Hypotheses\n' + state.hypotheses.map(h =>
          h.n + '. ' + h.text + (h.verdict ? ' — ' + h.verdict : ' — OPEN')).join('\n'));
      }
      const entries = ledger.serialize().entries.slice(-10);
      if (entries.length) {
        parts.push('# Findings ledger\n' + entries.map(e =>
          '- ' + e.finding + ' (' + e.confidence + (e.selectors.length ? '; ' + e.selectors.join(' ') : '') + ')').join('\n'));
      }
      if (state.digest) parts.push('# Earlier investigation (digest)\n' + state.digest);
      if (!parts.length) return '';
      return 'SESSION STATE\n' + parts.join('\n\n');
    }

    function assembleMessages() {
      const sys = Protocol.buildSystemPrompt({
        base: cfg.systemPrompt || '',
        toolSpecs: toolSpecs(),
        knowledgeIndex: knowledge.index,
        attachedUnits: []   // Task 10 fills this in
      });
      const messages = [
        { role: 'system', content: sys },
        { role: 'user', content: 'Service requirement:\n' + state.requirement }
      ];
      const block = buildSessionStateBlock();
      if (block) messages.push({ role: 'system', content: block });
      const messages2 = messages.concat(
        state.transcript.map(entry => {
          if (entry.kind === 'assistant') return { role: 'assistant', content: entry.text };
          if (entry.kind === 'tool') return { role: 'user', content: 'TOOL RESULT ' + entry.summary };
          return { role: 'user', content: entry.text };
        })
      );
      return messages2;
    }

    function accountUsage(messages, res) {
      const u = res && res.usage;
      if (u && typeof u.prompt_tokens === 'number') {
        state.spend.promptTokens += u.prompt_tokens;
        state.spend.completionTokens += typeof u.completion_tokens === 'number' ? u.completion_tokens : 0;
      } else {
        let chars = 0;
        for (const m of messages) chars += String((m && m.content) || '').length;
        chars += String((res && res.content) || '').length;
        state.spend.promptTokens += Math.ceil(chars / 4);
        state.spend.estimated = true;
      }
    }

    async function callLlm(messages) {
      let attempt = 0;
      while (true) {
        attempt += 1;
        let res = null;
        let err = null;
        try {
          res = await llm({ messages: messages, maxTokens: budgets.maxTokensPerCall });
        } catch (e) { err = e; }
        if (!err) {
          state.spend.llmCalls += 1;
          accountUsage(messages, res);
          const content = res && typeof res.content === 'string' ? res.content : '';
          const finish = res && typeof res.finish_reason === 'string' ? res.finish_reason : '';
          emit('llm_reply', { chars: content.length, finish_reason: finish });
          if (!content.trim() && finish === 'length') {
            // RC55: empty + length is deterministic budget exhaustion — a retry
            // burns the same completion budget again. Non-retryable.
            throw Object.assign(new Error('empty content with finish_reason=length (completion budget exhausted pre-content)'), { code: 'EMPTY_LENGTH' });
          }
          if (content.trim()) return content;
          // empty without length: transient shape — retry
        }
        if (attempt >= retry.attempts) {
          if (err) throw Object.assign(new Error(String((err && err.message) || err)), { code: 'LLM_ERROR' });
          throw Object.assign(new Error('empty LLM reply (no finish_reason=length) after ' + attempt + ' attempts'), { code: 'LLM_EMPTY' });
        }
        if (retry.backoffMs > 0) await sleep(retry.backoffMs * Math.pow(2, attempt - 1));
      }
    }

    function llmStopFromError(err) {
      if (err && err.code === 'EMPTY_LENGTH') return ['llm:length', String(err.message || err)];
      return ['llm:error', String((err && err.message) || err)];
    }

    // Transcripts are persisted and state()-copied via JSON round-trips, so
    // the dispatch boundary OWNS serializability: a cyclic/undefined tool
    // result must degrade to an error result, never crash persist()/state().
    function sanitizeToolResult(r) {
      try {
        const s = JSON.stringify(r);
        if (typeof s === 'string') return r;
      } catch (e) { /* fall through */ }
      return { error: 'unserializable result (cyclic or non-JSON value)' };
    }

    async function dispatchTool(name, args) {
      const fn = tools[name];
      if (typeof fn !== 'function') {
        return { error: 'unknown tool: ' + name, available: availableToolNames() };
      }
      try {
        return sanitizeToolResult(await fn(args, { observationLog: observationLog, ledger: ledger, session: publicApi }));
      } catch (err) {
        return { error: String((err && err.message) || err) };
      }
    }

    async function loop() {
      if (running) return buildReport();
      if (state.stopped && state.stopped.reason !== 'paused') return buildReport();
      running = true;
      state.status = 'running';
      state.stopped = null;
      segmentStart = now();
      emit('session_start', { sessionId: state.id, resuming: state.spend.turns > 0 });
      let report = null;
      try {
        while (true) {
          if (abortFlag) { report = await stop('aborted', abortReason); break; }
          if (pauseFlag) {
            pauseFlag = false;
            state.elapsedMs += now() - segmentStart;
            state.status = 'paused';
            state.stopped = { reason: 'paused', detail: null };
            emit('paused', {});
            await persist();
            report = buildReport();
            break;
          }
          if (state.spend.turns >= budgets.maxTurns) { report = await stop('maxTurns'); break; }
          if (state.elapsedMs + (now() - segmentStart) >= budgets.wallClockMs) { report = await stop('wallClock'); break; }
          if (state.spend.promptTokens + state.spend.completionTokens >= budgets.tokenCap) { report = await stop('tokenCap'); break; }

          emit('turn_start', { turn: state.spend.turns + 1 });
          const messages = assembleMessages();
          let content;
          try {
            content = await callLlm(messages);
          } catch (err) {
            const s = llmStopFromError(err);
            report = await stop(s[0], s[1]);
            break;
          }
          const parsed = Protocol.parseAssistantTurn(content);
          if (!parsed.ok) { report = await stop('protocol', parsed.violation); break; }
          const turn = parsed.turn;
          state.spend.turns += 1;

          state.transcript.push({ kind: 'assistant', text: content });
          if (turn.finish) {
            report = await stop('completed', turn.finish.summary || null);
            break;
          }
          emit('tool_call', { tool: turn.tool, args: turn.args });
          const result = await dispatchTool(turn.tool, turn.args);
          const summary = Protocol.summarizeToolResult(turn.tool, result, toolResultCapChars);
          state.transcript.push({ kind: 'tool', name: turn.tool, ok: !isErrorResult(result), result: result, summary: summary });
          emit('tool_result', { tool: turn.tool, ok: !isErrorResult(result), summary: summary.slice(0, 200) });
          await persist();
        }
      } finally {
        running = false;
      }
      return report || buildReport();
    }

    function abort(reason) { abortFlag = true; abortReason = String(reason || 'user'); }
    function pause() { pauseFlag = true; }

    const publicApi = {
      run: loop,
      abort: abort,
      pause: pause,
      state: () => JSON.parse(JSON.stringify(stateForPersist())),
      report: buildReport,
      get observationLog() { return observationLog; },
      get ledger() { return ledger; }
    };
    return publicApi;
  }

  const api = { createResearchSession };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.ResearchSessionLib = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
