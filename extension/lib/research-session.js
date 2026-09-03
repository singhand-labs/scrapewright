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
    { name: 'service.update', args: '{steps, inputSchema?, outputSchema?, testInput?, name?, overrides?} — REPLACES the whole artifact (send the complete steps array every time); overrides waives grounding receipts (an array of selector strings, or {"selectors":[...]}) and never carries steps; testInput (sample input values) is REQUIRED when the target URL has {{param}} placeholders, or verify.run fails with MISSING_URL_PARAM; inputSchema/outputSchema, when sent, MUST be JSON Schema objects like {"type":"object","required":["posts"],"properties":{"posts":{"type":"array","items":{"type":"object"}}}} — natural-language maps ({"posts":"array of post objects"}) are rejected: verify scoring reads "required"/"properties" and cannot see through descriptions', returns: '{version} | {grounding:"rejected", rejections}' }
  ];

  const DEFAULTS = {
    budgets: { maxTurns: 60, maxTokensPerCall: 8192, tokenCap: 2000000, wallClockMs: 1800000 },
    retry: { attempts: 3, backoffMs: 400 },
    compaction: { thresholdChars: 60000, keepTurns: 6 },
    toolResultCapChars: 4000
  };

  function isErrorResult(r) {
    if (!r || typeof r !== 'object') return false;
    if (typeof r.error === 'string') return true;
    // Grounding rejections (§8) are failures the model must act on — but the
    // transcript/mirror flagged them "ok" because they carry no .error
    // (fourth-live-log G3).
    if (r.grounding === 'rejected') return true;
    return false;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Seventh-live-log J1: the 60-turn session spent turns 1-55 on research,
  // authored at 56-59 and hit its FIRST verify at turn 60 — the model had no
  // visibility into the remaining budget, so whatever ceiling G5 raises gets
  // filled with research. Two carriers: a persistent budget line in the
  // session-state block (every call) and one-shot directional advisories at
  // 50/75/90%.
  const BUDGET_ADVISORIES = [
    {
      key: 'half', pct: 0.5,
      text: (used, max) => 'BUDGET ADVISORY (half the turn budget spent: ' + used + ' of ' + max + '): keep research focused — prefer the cheapest probe that answers the current question, and do not re-confirm selectors you already hold receipts for.'
    },
    {
      key: 'author', pct: 0.75,
      text: (used, max) => 'BUDGET ADVISORY (75% of the turn budget spent: ' + used + ' of ' + max + '): move to authoring now — dry-run the fieldMap with probe.extract in the live tab, then service.update. If the I/O contract is not confirmed yet, complete io.confirm first. Leave the remaining turns for verify.run and fixing its findings.'
    },
    {
      key: 'finalize', pct: 0.9,
      text: (used, max) => 'BUDGET ADVISORY (90% of the turn budget spent: ' + used + ' of ' + max + ' — only ' + (max - used) + ' left): FINALIZE — submit your best-grounded artifact via service.update immediately and run verify.run; spend what remains ONLY on defects verify reports. (If the contract is still unconfirmed, io.confirm comes first.)'
    }
  ];

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
    // Audit C3: the live rail's page epoch, consulted at service.update so
    // receipts recorded before a mid-session tab reload count as stale.
    const epochOf = typeof cfg.epochOf === 'function' ? cfg.epochOf : null;
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
      spend: { turns: 0, llmCalls: 0, promptTokens: 0, completionTokens: 0, estimated: false, parkedMs: 0 },
      attachedUnits: [],
      artifactVersions: [],
      elapsedMs: 0,
      stopped: null,
      budgetAdvisories: []
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

    // Audit C4: user-parked bridges (io.confirm / annotate.request) hold the
    // loop open — abort/stop must cancel them or run() hangs forever and
    // `running` stays true (deadlock). Pause deliberately does NOT cancel:
    // the user may answer while paused and the parked clock does not run.
    const userBridges = Array.isArray(cfg.userBridges)
      ? cfg.userBridges.filter((b) => b && typeof b.cancel === 'function')
      : [];
    const cancelledBridges = new Set();
    function cancelUserBridges(reason) {
      for (const b of userBridges) {
        if (cancelledBridges.has(b)) continue; // abort() then stop() must not double-cancel
        cancelledBridges.add(b);
        try { b.cancel(reason); } catch (e) { /* bridge cancellation must never throw into the engine */ }
      }
    }

    // Audit C1: time the engine spends parked on a user bridge (io.confirm /
    // annotate.request) is user time, not research time. Track it separately;
    // wallClock consumption is computed NET of parked windows, and the report
    // discloses parkedMs so nobody wonders where the clock went.
    let parkedTotal = 0;
    let parkedThisSegment = 0;
    let parkOpenSince = null;
    function parkBegin() { if (parkOpenSince == null) parkOpenSince = now(); }
    function parkEnd() {
      if (parkOpenSince == null) return;
      const d = now() - parkOpenSince;
      parkOpenSince = null;
      parkedTotal += d;
      parkedThisSegment += d;
    }
    function netSegmentMs() {
      let seg = now() - segmentStart - parkedThisSegment;
      if (parkOpenSince != null) seg -= (now() - parkOpenSince);
      return Math.max(0, seg);
    }

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
        spend: Object.assign({}, state.spend, { parkedMs: parkedTotal }),
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

    // Audit C12: persist() lands on the debounce trailing edge — a stop (or
    // pause) followed immediately by SW suspension / window close would lose
    // the terminal state. Terminal points force the flush.
    async function persistFinal() {
      await persist();
      if (persistence && typeof persistence.flush === 'function') {
        try { await persistence.flush(); }
        catch (e) { emit('persist_error', { error: 'flush: ' + String((e && e.message) || e) }); }
      }
    }

    async function stop(reason, detail) {
      cancelUserBridges('session stopped: ' + reason);
      state.status = 'stopped';
      state.stopped = { reason: reason, detail: detail == null ? null : detail };
      emit('stopped', { reason: reason, detail: state.stopped.detail });
      await persistFinal();
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

    function applyTurnState(turn) {
      const g = turn.goalUpdates;
      if (g) {
        if (g.push) state.goals.push({ id: 'g' + (state.goals.length + 1), text: g.push, status: 'open' });
        else if (g.complete) {
          const target = state.goals.find(x => x.id === g.complete || x.text === g.complete);
          if (target) target.status = 'done';
        }
      }
      const h = turn.hypothesisUpdates;
      if (h) {
        if (h.add) state.hypotheses.push({ n: state.hypotheses.length + 1, text: h.add, verdict: null });
        else if (h.resolve) {
          const t = state.hypotheses.find(x => x.n === h.resolve.n);
          if (t) t.verdict = h.resolve.verdict;
        }
      }
    }

    function buildSessionStateBlock() {
      const parts = [];
      // J1: the model is the only actor that can pace the session, and it
      // never saw the budget. First line, every call, always present.
      parts.push('Turn budget: ' + state.spend.turns + ' used / ' + budgets.maxTurns + ' max — ' +
        Math.max(0, budgets.maxTurns - state.spend.turns) + ' left. Pace the work: research early, author mid-session, verify and fix at the end.');
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

    function attachedUnitBodies() {
      return KB.queryUnits(knowledge.units, state.attachedUnits);
    }

    function attachKnowledge(result) {
      const events = (result && Array.isArray(result.events))
        ? result.events.filter(x => typeof x === 'string') : [];
      if (!events.length || !knowledge.units.length) return;
      const matched = KB.matchUnits(knowledge.units, events);
      for (const u of matched) {
        if (state.attachedUnits.indexOf(u.id) === -1) {
          state.attachedUnits.push(u.id);
          emit('knowledge_attached', { id: u.id, trigger: events.join(',') });
        }
      }
    }

    function handleLedgerAdd(args) {
      const a = args || {};
      if (typeof a.finding !== 'string' || !a.finding.trim()) {
        return { error: 'finding (non-empty string) required' };
      }
      const added = ledger.add({
        finding: a.finding.trim(),
        evidence: typeof a.evidence === 'string' ? a.evidence : '',
        confidence: a.confidence,
        provenance: 'session',
        selectors: Array.isArray(a.selectors) ? a.selectors.filter(s => typeof s === 'string') : []
      });
      emit('ledger_add', { finding: a.finding.trim() });
      return { added: true, id: added.id };
    }

    function normalizeOverrides(raw) {
      const list = Array.isArray(raw)
        ? raw
        : (raw && typeof raw === 'object' && Array.isArray(raw.selectors) ? raw.selectors : []);
      return list.filter(s => typeof s === 'string' && s);
    }

    async function handleServiceUpdate(args) {
      const a = args || {};
      const steps = Array.isArray(a.steps) ? a.steps : [];
      if (!steps.length) return { error: 'steps (non-empty array) required' };
      const autoVerify = typeof tools['probe.count'] === 'function'
        ? async (sel) => {
            const r = await tools['probe.count'](sel);
            return (r && typeof r.count === 'number') ? r.count : null;
          }
        : null;
      const gateEpochRaw = epochOf ? epochOf() : undefined;
      const gateEpoch = (typeof gateEpochRaw === 'number') ? gateEpochRaw : undefined;
      const v = await Gate.validateGrounding({
        steps: steps,
        observationLog: observationLog,
        ledger: ledger,
        autoVerify: autoVerify,
        epoch: gateEpoch,
        // Sixth-live-log I2a: the model sent {"selectors":[...]} and the
        // bare Array.isArray check silently dropped it — an explicit waiver
        // must never be lost to a shape mismatch. Accept both shapes.
        overrides: normalizeOverrides(a.overrides)
      });
      if (!v.ok) return { grounding: 'rejected', rejections: v.rejections };
      const handler = tools['service.update'];
      if (typeof handler !== 'function') return { error: 'no service.update handler wired' };
      const out = await handler(a, { observationLog: observationLog, ledger: ledger, session: publicApi });
      // The handler is the authority on whether an artifact was actually
      // created (chain/schema validation, apply). A handler error means NO
      // version exists — announcing one anyway (fourth-log turn 19) sent the
      // session and the UI off to verify a phantom artifact.
      if (out && typeof out === 'object' && typeof out.error === 'string') return out;
      const version = state.artifactVersions.length + 1;
      state.artifactVersions.push({ version: version, steps: steps, at: now() });
      emit('artifact_version', { version: version });
      return (out && typeof out === 'object') ? out : { version: version };
    }

    function handleKnowledgeQuery(args) {
      const a = args || {};
      const ids = Array.isArray(a.ids) ? a.ids.filter(x => typeof x === 'string') : [];
      if (!ids.length) return { error: 'ids (array of unit ids) required — see the knowledge index in the system prompt' };
      return { units: KB.queryUnits(knowledge.units, ids).map(u => ({ id: u.id, title: u.title, body: u.body })) };
    }

    function transcriptChars() {
      let n = 0;
      for (const e of state.transcript) {
        if (e.kind === 'tool') {
          n += 'TOOL RESULT '.length + String(e.name || '').length
            + String(e.summary || '').length + JSON.stringify(e.result === undefined ? null : e.result).length;
        } else {
          n += String(e.text || '').length;
        }
      }
      return n;
    }

    const DIGEST_CAP = 24000;

    function maybeCompact() {
      const keepEntries = Math.max(2, compaction.keepTurns * 2);
      const chars = transcriptChars();
      if (chars <= compaction.thresholdChars) return;
      if (state.transcript.length <= keepEntries) return;
      const keep = state.transcript.slice(-keepEntries);
      const old = state.transcript.slice(0, state.transcript.length - keepEntries);
      const lines = [];
      for (const e of old) {
        if (e.kind === 'assistant') {
          const t = Protocol.parseAssistantTurn(e.text);
          // Audit C6: the WHY a hypothesis was abandoned lived only in think
          // text and was dropped on compaction — resumed sessions re-walked
          // dead ends. Keep a 200-char excerpt next to the action.
          const thinkBit = (t.ok && t.turn && t.turn.think) ? ' — ' + String(t.turn.think).slice(0, 200) : '';
          lines.push('- ' + (t.ok && t.turn.tool
            ? t.turn.tool + ' ' + JSON.stringify(t.turn.args)
            : 'assistant turn') + thinkBit);
        } else if (e.kind === 'tool') {
          lines.push('  → ' + String(e.summary || '').slice(0, 200));
        } else {
          lines.push('- [protocol nudge]');
        }
      }
      state.digest = (state.digest ? state.digest + '\n' : '') + lines.join('\n');
      // Audit C6: the digest only ever grew — long sessions carried an
      // unbounded block into every prompt. Cap head 70% / tail 30% with a
      // disclosed elision marker (never silent truncation).
      if (state.digest.length > DIGEST_CAP) {
        const headLen = Math.floor(DIGEST_CAP * 0.7);
        const tailLen = DIGEST_CAP - headLen;
        const elided = state.digest.length - DIGEST_CAP;
        state.digest = state.digest.slice(0, headLen) +
          '\n… ' + elided + ' chars elided (digest cap ' + DIGEST_CAP + ') …\n' +
          state.digest.slice(-tailLen);
      }
      state.transcript = keep;
      emit('compaction', { collapsed: old.length, charsBefore: chars });
    }

    // Fires the HIGHEST due unsent advisory once and marks every due bucket
    // as sent — a resume that skipped past 50% (and 75%) shows only the
    // strongest directive instead of replaying stale ones.
    function maybeBudgetAdvisory() {
      if (!Array.isArray(state.budgetAdvisories)) state.budgetAdvisories = [];
      let due = null;
      for (const adv of BUDGET_ADVISORIES) {
        if (state.spend.turns >= Math.floor(budgets.maxTurns * adv.pct) &&
            state.budgetAdvisories.indexOf(adv.key) === -1) {
          due = adv;
        }
      }
      if (!due) return;
      for (const adv of BUDGET_ADVISORIES) {
        if (state.spend.turns >= Math.floor(budgets.maxTurns * adv.pct) &&
            state.budgetAdvisories.indexOf(adv.key) === -1) {
          state.budgetAdvisories.push(adv.key);
        }
      }
      state.transcript.push({ kind: 'system', text: due.text(state.spend.turns, budgets.maxTurns) });
      emit('budget_advisory', { key: due.key, turns: state.spend.turns, maxTurns: budgets.maxTurns });
    }

    function assembleMessages() {
      const sys = Protocol.buildSystemPrompt({
        base: cfg.systemPrompt || '',
        toolSpecs: toolSpecs(),
        knowledgeIndex: knowledge.index,
        attachedUnits: attachedUnitBodies()
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
      if (name === 'knowledge.query') return sanitizeToolResult(handleKnowledgeQuery(args));
      if (name === 'ledger.add') return sanitizeToolResult(handleLedgerAdd(args));
      if (name === 'service.update') return sanitizeToolResult(await handleServiceUpdate(args));
      // Probe tools (probe-tools.js) take POSITIONAL args; the protocol carries
      // one args object — probe-tools accepts BOTH shapes (object-first or
      // positional), so dispatch every user tool uniformly as fn(args, ctx).
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
      // Tenth-log N3: the feedback continuation resets its budget segment
      // (turns 0) but carries the full transcript — that history is what
      // makes it a continuation, so the flag must key on either signal.
      const resuming = state.spend.turns > 0 || (Array.isArray(state.transcript) && state.transcript.length > 0);
      state.status = 'running';
      state.stopped = null;
      segmentStart = now();
      emit('session_start', { sessionId: state.id, resuming: resuming });
      let report = null;
      try {
        while (true) {
          if (abortFlag) { report = await stop('aborted', abortReason); break; }
          if (pauseFlag) {
            pauseFlag = false;
            state.elapsedMs += netSegmentMs();
            parkedThisSegment = 0;
            state.status = 'paused';
            state.stopped = { reason: 'paused', detail: null };
            emit('paused', {});
            await persistFinal();
            report = buildReport();
            break;
          }
          if (state.spend.turns >= budgets.maxTurns) {
            report = await stop('maxTurns', state.spend.turns > 0
              ? 'budget exhausted at ' + state.spend.turns + '/' + budgets.maxTurns + ' turns — raise the budget (maxTurns) in the resume seed to continue'
              : null);
            break;
          }
          if (state.elapsedMs + netSegmentMs() >= budgets.wallClockMs) {
            report = await stop('wallClock', 'time budget exhausted after ~' + Math.round((state.elapsedMs + netSegmentMs()) / 1000) + 's (parked ' + Math.round(parkedTotal / 1000) + 's excluded) — raise the budget (wallClockMs) in the resume seed to continue');
            break;
          }
          if (state.spend.promptTokens + state.spend.completionTokens >= budgets.tokenCap) { report = await stop('tokenCap'); break; }
          maybeBudgetAdvisory();

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
          let parsed = Protocol.parseAssistantTurn(content);
          if (!parsed.ok) {
            emit('protocol_violation', { violation: parsed.violation, detail: parsed.detail || null });
            // The detail names the REAL failure (parse position, keys seen) —
            // "missing-action" alone sent the model hunting for an action it
            // had already written while the true problem was unescaped quotes
            // (third live log).
            let nudgeText = 'PROTOCOL VIOLATION (' + parsed.violation + (parsed.detail ? ' — ' + parsed.detail : '') + '): reply with ONE JSON object with exactly one of "tool" or "finish". No prose outside the JSON. A token/position error usually means unescaped double quotes inside a string value — escape them (\") or do not quote text with ".';
            // Fifth-live-log turn 21: BOTH the original and the repair reply
            // were cut off before the closing braces (finish_reason "stop").
            // Generic advice made the model resend at the same length and
            // truncate again — name the class and demand a shorter resend.
            if (parsed.detail && /cut-off|Unterminated string|Unexpected end/i.test(parsed.detail)) {
              nudgeText += ' Your previous reply was CUT OFF before the JSON closed. Resend the SAME turn much SHORTER: a one-sentence think, then tool/args, then the closing braces — long replies are the ones that get truncated.';
            }
            state.transcript.push({ kind: 'system', text: nudgeText });
            let repaired = null;
            try {
              repaired = await callLlm(assembleMessages());
            } catch (err) {
              const s = llmStopFromError(err);
              report = await stop(s[0], s[1]);
              break;
            }
            parsed = Protocol.parseAssistantTurn(repaired);
            if (!parsed.ok) {
              report = await stop('protocol', parsed.violation);
              break;
            }
            content = repaired;
          }
          const turn = parsed.turn;
          applyTurnState(turn);
          state.spend.turns += 1;

          state.transcript.push({ kind: 'assistant', text: content });
          await persist();
          if (turn.finish) {
            // Thirteenth log: five consecutive RED verifies still finished as a
            // plain 'completed' — an honest ship note must not read as green.
            let detail = turn.finish.summary || null;
            if (state.lastVerifyOk === false) {
              detail = (detail ? detail + ' ' : '') +
                '[LAST VERIFY FAILED — shipped best-effort; the review panel shows the failing run]';
            } else if (state.lastVerifySchemaBlind) {
              // Seventeenth log: a fieldless outputSchema made every
              // schema-reading check blind — the last verify came back GREEN
              // at score 0 over an all-empty record. Green-but-unverifiable
              // must not read as a clean ship.
              detail = (detail ? detail + ' ' : '') +
                '[VERIFY SCHEMA-BLIND — outputSchema declares no fields, so this green is unverifiable. Renegotiate the contract with io.confirm (fielded properties + required), service.update the artifact to match, and re-verify]';
            } else if (state.lastVerifyEmptyFields) {
              // Sixteenth log: a GREEN verify carrying confirmed fields that
              // are empty in every record (time:"", location:"") completed
              // with no disclosure — the model had rationalized the empties
              // as "virtualization timing". Green-with-holes must not read
              // as fully green either.
              detail = (detail ? detail + ' ' : '') +
                '[VERIFY PARTIAL-EMPTY — confirmed field(s) empty in every record: ' + state.lastVerifyEmptyFields.join(', ') + ']';
            }
            report = await stop('completed', detail);
            break;
          }
          emit('tool_call', { tool: turn.tool, args: turn.args });
          const result = await dispatchTool(turn.tool, turn.args);
          let verifyDigest = null;
          if (turn.tool === 'verify.run') {
            state.lastVerifyOk = !!(result && typeof result === 'object' && result.ok === true);
            const pe = (result && result.detectors && Array.isArray(result.detectors.partialEmptyFields))
              ? result.detectors.partialEmptyFields
              : [];
            state.lastVerifyEmptyFields = pe.length
              ? pe.slice(0, 6).map((f) => String(f.path || f.field) + ' ' + (f.emptyCount || 0) + '/' + (f.totalCount || 0) + ' empty')
              : null;
            state.lastVerifySchemaBlind = !!(Array.isArray(result && result.events) && result.events.indexOf('SCHEMA_BLIND') !== -1);
            // The tool_result event's summary is capped at 200 chars — too
            // short for the verify report's verdict. Attach a compact digest
            // (sixteenth log: tags and detector findings were invisible in
            // exported console logs, so green-with-empties was undiagnosable
            // from the log alone).
            verifyDigest = {
              ok: state.lastVerifyOk,
              score: (result && result.score && typeof result.score.score === 'number') ? Math.round(result.score.score) : null,
              tags: Array.isArray(result.events) ? result.events.slice(0, 8) : [],
              partialEmpty: state.lastVerifyEmptyFields || []
            };
          }
          // Replay/persistence must carry WHAT was probed (the args), not just
          // the result — a resumed context still shows the selector used.
          const callLabel = turn.tool + ' ' + JSON.stringify(turn.args || {});
          const summary = Protocol.summarizeToolResult(callLabel, result, toolResultCapChars);
          state.transcript.push({ kind: 'tool', name: turn.tool, ok: !isErrorResult(result), result: result, summary: summary });
          const toolResultPayload = { tool: turn.tool, ok: !isErrorResult(result), summary: summary.slice(0, 200) };
          if (verifyDigest) toolResultPayload.verify = verifyDigest;
          emit('tool_result', toolResultPayload);
          attachKnowledge(result);
          maybeCompact();
          await persist();
        }
      } finally {
        running = false;
      }
      return report || buildReport();
    }

    function abort(reason) {
      abortFlag = true;
      abortReason = String(reason || 'user');
      cancelUserBridges('user aborted session');
    }
    function pause() { pauseFlag = true; }

    const publicApi = {
      run: loop,
      abort: abort,
      pause: pause,
      parkBegin: parkBegin,
      parkEnd: parkEnd,
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
