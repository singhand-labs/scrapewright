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
  const VR = resolveLib('./verify-runner', 'VerifyRunner');
  const Dossier = resolveLib('./evidence-dossier', 'EvidenceDossier');
  // Eighty-seventh-round live gap: a wizard.html load-order slip left this
  // const null for the page lifetime and the per-turn evidence dossier
  // (STEP PLAN included) silently never rode — node tests resolve via
  // require and stayed green. A null dossier lib must be LOUD.
  if (!Dossier) {
    try { console.warn('[research-session] EvidenceDossier lib unresolved — the per-turn evidence dossier ([STEP PLAN]/skeleton/verify census/artifact lineage) is OFF; check script load order in wizard.html'); } catch (e0) { /* best-effort */ }
  }

  const INTERNAL_TOOL_SPECS = [
    { name: 'ledger.add', args: '{finding, evidence?, confidence?, selectors?}', returns: '{added:true, id}' },
    { name: 'knowledge.query', args: '{ids:["unitId"]}', returns: '{units:[{id,title,body}]}' },
    { name: 'service.update', args: '{steps, more?, abortChunk?, inputSchema?, outputSchema?, testInput?, name?, overrides?} — CHUNKED SENDS: when the full steps payload is long (providers cut replies at ~4-5K chars mid-JSON), send it in parts: service.update({steps:[first part], more:true}) buffers; repeat for middle parts; the FINAL chunk (steps without more) assembles and applies everything — keep every reply comfortably under ~3000 chars — REPLACES the whole artifact (a single send carries the complete steps array; chunked sends assemble to the same effect); the receipt discloses the id delta whenever a send REPLACES a standing artifact (a shrink warns you — a final chunk on an empty buffer is a REPLACE, not a merge); patch:true is the ONE-TURN re-author: {steps:[one complete step], patch:true} merges it BY ID into the current artifact (same id replaced, new id appended, every other step untouched, all gates still run) — use it to fix a single step after a red verify instead of re-sending every chunk; abortChunk:true clears buffered chunks (steps sent WITH the abort become the new chunk 1, not a discard); overrides waives grounding receipts (an array of selector strings, or {"selectors":[...]}) and never carries steps — a waiver stays in force for the rest of the session, you do NOT need to resend it with later updates; testInput (sample input values) is REQUIRED when the target URL has {{param}} placeholders, or verify.run fails with MISSING_URL_PARAM; testInput values are user-confirmed alongside the contract (io.confirm carries them in the same panel) — sending values that DIFFER from the confirmed ones is rejected with TEST_INPUT_UNCONFIRMED: re-confirm via io.confirm (same schemas, new testInput) first; inputSchema/outputSchema, when sent, MUST be JSON Schema objects like {"type":"object","required":["posts"],"properties":{"posts":{"type":"array","items":{"type":"object"}}}} — natural-language maps ({"posts":"array of post objects"}) are rejected: verify scoring reads "required"/"properties" and cannot see through descriptions; once the user has confirmed the contract you may OMIT the schemas — the confirmed contract attaches to the artifact automatically — and sending schemas that MATERIALLY differ from the confirmed ones is rejected (renegotiate via io.confirm first)', returns: '{version} | {updated, waiverRecorded} | {updated, testInputAdopted} | {updated, schemasAttached} | {updated, patched, stepsNow} | {grounding:"rejected", rejections} | {buffered:true,...} | {aborted:true,...} | {updated, replacedStepIds}' }
  ];

  const DEFAULTS = {
    budgets: { maxTurns: 60, maxTokensPerCall: 8192, tokenCap: 2000000, wallClockMs: 1800000 },
    retry: { attempts: 3, backoffMs: 400 },
    compaction: { thresholdChars: 60000, keepTurns: 6 },
    toolResultCapChars: 4000,
    // 89th-round T3: verify.run receipts carry the decision-critical
    // detectors/finalResult — a verify costs 65-110s, a 20K receipt is
    // affordable next to a 4K budget that elided exactly those rows.
    // Hundred-third-round audit C: probe.hover receipts carry the hover
    // evidence payload (8000-char htmlSnippet head + rejectedAddedHtml
    // fragments + identity + texts) — compactObjectForLLM divides the budget
    // EQUALLY across keys, so the 4000 default sliced every one of those to
    // ~400 chars of noise (the fragment channel would starve one layer after
    // being fixed in the layer below).
    toolResultCaps: { 'verify.run': 20000, 'probe.hover': 12000 },
    // tool_result EVENT summaries ride the console mirror (wizard.js slices
    // at 600), so the event budget matches it exactly.
    eventSummaryCapChars: 600,
    // Thirty-second log RC-B: the exported console log is the debugging
    // lifeline, and the 600-char one-liner hid the report body the diagnosis
    // needed (v2-v4 mirror truncated mid-error). The event also carries a
    // key-preserving compact DETAIL (all keys alive, long strings head+tail
    // with disclosed elision) that the wizard mirror chunk-logs in full.
    eventDetailCapChars: 12000
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

  // Sixty-ninth review F10: canonical (key-order-insensitive, recursive) args
  // serialization — the repeated-failure tracker must see {a:1,b:2} and
  // {b:2,a:1} as the SAME call.
  function canonicalizeArgs(v) {
    if (Array.isArray(v)) return v.map(canonicalizeArgs);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).sort()) o[k] = canonicalizeArgs(v[k]);
      return o;
    }
    return v;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Eighteenth log: splice a continuation onto a cut-off reply. The final
  // artifact write (service.update) is an inherently long payload — "resend
  // SHORTER" cannot shrink it, so the repair resend came back LONGER and cut
  // off again (1224 → 2886 chars, finish_reason "stop"). The continuation
  // round asks for only the remainder; the model often repeats the last
  // tokens it emitted before continuing, so find the longest suffix/prefix
  // overlap and merge past it. Keep the raw splice and the continuation
  // standalone too (the model may have resent the whole object) — parse
  // validation picks whichever is the real turn.
  function continuationCandidates(base, cont) {
    const raw = String(cont == null ? '' : cont);
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const cleaned = ((fence && fence[1] && fence[1].trim()) ? fence[1] : raw).trim();
    if (!cleaned) return [];
    const out = [];
    const maxOv = Math.min(240, base.length, cleaned.length);
    for (let n = maxOv; n >= 8; n--) {
      if (base.slice(base.length - n) === cleaned.slice(0, n)) {
        out.push(base + cleaned.slice(n));
        break;
      }
    }
    out.push(base + cleaned);
    out.push(cleaned);
    return out;
  }

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
      // Nineteenth log: artifact v1 landed at turn 55/60 — the static "move
      // to authoring now" was not imperative enough, so verify feedback had
      // zero runway. With NO artifact yet the text escalates to a direct
      // order; once a draft exists it reverts to the pacing advice.
      text: (used, max, hasArtifact) => 'BUDGET ADVISORY (75% of the turn budget spent: ' + used + ' of ' + max + '): ' + (hasArtifact
        ? 'move to authoring now — dry-run the fieldMap with probe.extract in the live tab, then service.update. If the I/O contract is not confirmed yet, complete io.confirm first. Leave the remaining turns for verify.run and fixing its findings.'
        : 'NO ARTIFACT YET — submit a complete draft via service.update in your NEXT turn. Verify-run feedback loops need runway; a perfect research phase with no artifact and no verify at the cap is a failed session. If the I/O contract is not confirmed yet, complete io.confirm first, then submit.')
    },
    {
      key: 'finalize', pct: 0.9,
      text: (used, max) => 'BUDGET ADVISORY (90% of the turn budget spent: ' + used + ' of ' + max + ' — only ' + (max - used) + ' left): FINALIZE — submit your best-grounded artifact via service.update immediately and run verify.run; spend what remains ONLY on defects verify reports. (If the contract is still unconfirmed, io.confirm comes first.) If the next verify is red and ≤1 turn remains, do NOT write another update you cannot verify — finish with the last verified artifact and disclose.'
    }
  ];

  // 117th log: the session died at tokenCap with detail=null and ZERO
  // warning — the advisory family above keys on TURNS only, so a
  // prompt-weighted feedback chain (21 pinned entries, ~31K tokens/turn)
  // crept past 2M tokens at turn ~50 with the turn counter far from 60.
  // Token-fraction advisories mirror the turn family; the stop itself now
  // carries an honest breakdown with the three exits.
  const TOKEN_BUDGET_ADVISORIES = [
    {
      key: 'token-half', pct: 0.5,
      text: (used, max) => 'TOKEN BUDGET ADVISORY (half the token budget spent: ' + used.toLocaleString() + ' of ' + max.toLocaleString() + ' — this session is PROMPT-weighted): prefer the cheapest probe that answers the question, reuse captured evidence over re-probing, and avoid full verify.run rounds where probe.snippet answers the same question.'
    },
    {
      key: 'token-author', pct: 0.75,
      text: (used, max) => 'TOKEN BUDGET ADVISORY (75% of the token budget spent: ' + used.toLocaleString() + ' of ' + max.toLocaleString() + '): converge — compact the evidence you send (smaller test input, fewer probed pages), finish the current repair, and reserve tokens for the final verify.'
    },
    {
      key: 'token-finalize', pct: 0.9,
      text: (used, max) => 'TOKEN BUDGET ADVISORY (90% of the token budget spent: ' + used.toLocaleString() + ' of ' + max.toLocaleString() + ' — ~' + Math.max(1, Math.floor((max - used) / 31000)) + ' turns left at the current prompt size): FINALIZE — submit your best-grounded artifact now and run the LAST verify; if that verify is red, finish with the last verified artifact and disclose instead of writing updates you cannot verify.'
    }
  ];

  function buildTokenCapDetail(spend, budgets) {
    try {
      const sp = spend || {};
      const p = sp.promptTokens || 0;
      const c = sp.completionTokens || 0;
      const calls = sp.llmCalls || 0;
      const avg = calls > 0 ? Math.round(p / calls) : 0;
      return 'token budget exhausted: prompt ' + p.toLocaleString() + ' + completion ' + c.toLocaleString() +
        ' ≥ cap ' + (budgets && budgets.tokenCap || 0).toLocaleString() +
        (sp.estimated ? ' (estimated)' : '') +
        '. This session is prompt-dominated (输入占 ' + (p + c > 0 ? Math.round(p * 100 / (p + c)) : 0) + '%; avg ~' + avg.toLocaleString() + ' tokens/call over ' + calls + ' calls)' +
        '. Exits: (a) send another feedback to resume — compact first (smaller test input, reuse captured evidence, prefer probe.snippet over re-verify); (b) ship the last VERIFIED artifact — the review banner shows the version and one-click rollback; (c) raise budgets.tokenCap in the engine config if this site genuinely needs the runway.';
    } catch (e) {
      return 'token budget exhausted (detail unavailable: ' + (e && e.message) + ')';
    }
  }

  // Window-dedup helper (2026-09-18 user directive): blocks of repeated
  // instruction text (DSL guide, tool catalogs) are replaced by a one-line
  // marker wherever they appear in HISTORY, so only the current system prompt
  // carries the full text.
  function makeInstructionStripper(blocks) {
    const list = (Array.isArray(blocks) ? blocks : [])
      .filter(b => b && typeof b.text === 'string' && b.text.length > 200 && typeof b.label === 'string' && b.label);
    return function (text) {
      let t = String(text == null ? '' : text);
      for (const b of list) {
        if (t.indexOf(b.text) !== -1) {
          t = t.split(b.text).join('[stripped instruction block: ' + b.label + ' — current copy lives in the system prompt]');
        }
      }
      return t;
    };
  }

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
    const toolResultCaps = Object.assign({}, DEFAULTS.toolResultCaps, (cfg.toolResultCaps && typeof cfg.toolResultCaps === 'object') ? cfg.toolResultCaps : {});
    // 89th-round T3: per-tool budget resolver — verify.run gets the larger
    // receipt so detectors rows and finalResult field values survive.
    function toolResultCapFor(toolName) {
      const t = String(toolName || '');
      if (toolResultCaps[t] && typeof toolResultCaps[t] === 'number' && toolResultCaps[t] > 0) return toolResultCaps[t];
      return toolResultCapChars;
    }
    const eventSummaryCapChars = typeof cfg.eventSummaryCapChars === 'number' ? cfg.eventSummaryCapChars : DEFAULTS.eventSummaryCapChars;
    const eventDetailCapChars = typeof cfg.eventDetailCapChars === 'number' ? cfg.eventDetailCapChars : DEFAULTS.eventDetailCapChars;
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
      fixProblems: [], // 123rd round: per-problem fix plan seeded from multi-problem feedback (see [FIX PLAN])
      cutOffNudgeCount: 0, // 129th-round review fix: persisted cut-off streak — the old transcript scan died to compaction (see the streak check in the turn loop)
      artifactVersions: [],
      elapsedMs: 0,
      stopped: null,
      budgetAdvisories: [],
      waivedSelectors: [],
      stepPlan: [],
      priorVerifyReport: null,
      // 129th-round review fix (same-site seed mining): the last GREEN
      // verify's finalResult, persisted so a fresh same-site wizard session
      // can mine research evidence executionLogs never sees (those only
      // record background service runs). priorVerifyReport rides every
      // verify including reds; this snapshot is green-only.
      lastVerifyFinalResult: null
    };
    if (cfg.seed && cfg.seed.session) {
      state = JSON.parse(JSON.stringify(cfg.seed.session));
      state.status = 'idle';
      state.stopped = null;
      if (!Array.isArray(state.waivedSelectors)) state.waivedSelectors = []; // legacy seeds predate sticky waivers
      if (!Array.isArray(state.stepPlan)) state.stepPlan = []; // legacy seeds predate the step plan (§3.C)
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
    // Seventy-first log F2: time the engine spends WAITING ON THE PROVIDER
    // (llm call round-trips + retry backoffs — rate-limit stalls included)
    // is environmental, not research time. Same exclusion semantics as
    // parkedMs: netSegmentMs subtracts it, the wallClock stop detail
    // discloses it, and the TIME BUDGET suffix carries it as a line item.
    let llmWaitTotal = 0;
    let llmWaitThisSegment = 0;
    // Sixty-ninth review F13: WHAT the session is parked on — a resumed or
    // inspected session can see "the engine is waiting on the user via
    // io.confirm / annotate.request / user.observe" instead of a silently
    // frozen clock. Set by the park callers through the optional descriptor.
    let awaitingUser = null;
    function parkBegin(kind, question) {
      if (parkOpenSince == null) parkOpenSince = now();
      awaitingUser = {
        kind: typeof kind === 'string' && kind ? kind.slice(0, 60) : 'user',
        question: typeof question === 'string' ? question.slice(0, 200) : '',
        since: now()
      };
    }
    function parkEnd() {
      if (parkOpenSince == null) { awaitingUser = null; return; }
      const d = now() - parkOpenSince;
      parkOpenSince = null;
      awaitingUser = null;
      parkedTotal += d;
      parkedThisSegment += d;
    }
    // Seventy-first log F2: netSegmentMs = raw segment time MINUS llm/provider
    // waits MINUS parked (user) windows — clamped at 0. The math itself lives
    // in the module-level computeEffectiveElapsed (exported for unit tests).
    function netSegmentMs() {
      let seg = computeEffectiveElapsed(now(), segmentStart, llmWaitThisSegment, parkedThisSegment);
      if (parkOpenSince != null) seg -= (now() - parkOpenSince);
      return Math.max(0, seg);
    }
    // Seventy-first log F2: wraps one provider wait (call or backoff sleep)
    // and books it out of the wall clock. Takes a THUNK — capturing t0 after
    // `llmWait(llm(...))` would evaluate the call (and its clock advance)
    // before the timer starts.
    async function llmWait(fn) {
      const t0 = now();
      try {
        return await fn();
      } finally {
        const d = now() - t0;
        llmWaitTotal += d;
        llmWaitThisSegment += d;
      }
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
        spend: Object.assign({}, state.spend, { parkedMs: parkedTotal, llmWaitMs: llmWaitTotal }),
        artifactVersions: state.artifactVersions.length,
        ledgerEntries: ledger.serialize().entries.length,
        observations: observationLog.size()
      };
    }

    // Twenty-seventh log: v6 verified red → v7 landed → finish. The
    // disclosure ladder named v6's failure but not the sharper fact that the
    // SHIPPED artifact has no verify at all. Twenty-eighth log: the same gap
    // sat in the BUDGET stops — verify3 red against v3, v4+v5 landed, and
    // the maxTurns detail said only [LAST VERIFY FAILED]. The engine knows
    // both versions; every stop path says so. Independent of the ladder: a
    // red last verify AND a newer unverified artifact both disclose.
    function unverifiedArtifactSuffix(noun) {
      const shippedV = state.artifactVersions.length;
      const verifiedV = state.lastVerifyArtifactVersion || 0;
      if (!(shippedV > 0 && shippedV > verifiedV)) return '';
      return ' [CURRENT ARTIFACT UNVERIFIED — last verify ran against v' + verifiedV +
        '; the ' + noun + ' artifact is v' + shippedV + ' and was never verified]';
    }

    // Nineteenth log: the session hit maxTurns IMMEDIATELY after a
    // green-with-holes verify — the stop detail showed only the generic
    // budget text and the empties stayed invisible at the exact moment the
    // user looks at the toast. Budget stops carry the same honesty the
    // finish path (thirteenth/sixteenth/seventeenth logs) already discloses.
    function verifyStopSuffix() {
      let ladder = '';
      if (state.lastVerifyOk === false) {
        // Forty-third log: six RED verifies at a constant score and the
        // stop detail named the failure but not the fields — the list the
        // model needed to renegotiate (io.confirm) or bind sources for.
        const ef = state.lastVerifyEmptyFields
          ? '; confirmed field(s) empty in every record: ' + state.lastVerifyEmptyFields.join(', ')
          : '';
        const greenRestoreB = (state.greenArtifactVersion && state.artifactVersions.length > state.greenArtifactVersion)
          ? ' [LAST GREEN = v' + state.greenArtifactVersion + ' — service.update({restoreVersion:' + state.greenArtifactVersion + '}) restores the verified artifact in ONE turn]'
          : '';
        ladder = ' [LAST VERIFY FAILED — the budget ran out before the failing run could be fixed' + ef + '; Resume to continue]' + greenRestoreB;
      } else if (state.lastVerifySchemaBlind) {
        ladder = ' [VERIFY SCHEMA-BLIND — outputSchema declares no fields, so the last green is unverifiable. Renegotiate the contract with io.confirm (fielded properties + required), service.update the artifact to match, and re-verify]';
      } else if (state.lastVerifyEmptyFields) {
        ladder = ' [VERIFY PARTIAL-EMPTY — confirmed field(s) empty in every record: ' + state.lastVerifyEmptyFields.join(', ') + ']';
      }
      // Forty-sixth log: extracted-vs-requested and relative-timestamp holes
      // are independent of the red/green ladder — a GREEN verify shipped 3/5
      // with relative ages and every existing branch stayed silent. Additive,
      // same contract as unverifiedArtifactSuffix.
      const csNote = state.lastVerifyCountShortfall
        ? ' [VERIFY COUNT-SHORTFALL — ' + state.lastVerifyCountShortfall + ']'
        : '';
      const rtNote = state.lastVerifyRelativeTimestamps
        ? ' [VERIFY RELATIVE-TIMESTAMPS — time field(s) carrying relative ages, not absolute values: ' + state.lastVerifyRelativeTimestamps.join(', ') + ']'
        : '';
      // Fifty-fifth log: junk-class censuses ride the same additive ladder.
      const tiNote = state.lastVerifyTimeImplausible
        ? ' [VERIFY TIME-IMPLAUSIBLE — time field(s) whose values carry no date shape: ' + state.lastVerifyTimeImplausible.join('; ') + ']'
        : '';
      const jkNote = state.lastVerifyJunkFields
        ? ' [VERIFY JUNK-VALUES — field(s) carrying junk values: ' + state.lastVerifyJunkFields.join(', ') + ']'
        : '';
      const plNote = state.lastVerifyPositionLikeIds
        ? ' [VERIFY POSITION-LIKE-IDS — id field(s) holding position/index values, not identities: ' + state.lastVerifyPositionLikeIds.join('; ') + ']'
        : '';
      // 139th log: the green-ship censuses the incident's finish omitted —
      // label-prefixed counts and duplicate ids shipped behind ok=true with
      // no disclosure reaching the completion summary.
      const lpNote = state.lastVerifyLabelPrefixedCounts
        ? ' [VERIFY LABEL-PREFIXED-COUNTS — count field(s) shipping the control label plus the count (parsed numbers are in the verify report): ' + state.lastVerifyLabelPrefixedCounts.join('; ') + ']'
        : '';
      const dupNote = state.lastVerifyDuplicateIds
        ? ' [VERIFY DUPLICATE-ITEMS — repeated items among the delivered records (unique count below the record count): ' + state.lastVerifyDuplicateIds.join('; ') + ']'
        : '';
      return ladder + csNote + rtNote + tiNote + jkNote + plNote + lpNote + dupNote + unverifiedArtifactSuffix('current');
    }

    function stateForPersist() {
      const out = {
        engine: 1,
        session: state,
        observation: observationLog.serialize(),
        ledger: ledger.serialize()
      };
      // F13: surface an OPEN user park to persistence/resume.
      if (awaitingUser) out.awaitingUser = awaitingUser;
      return out;
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
      // 89th-round D3 second guard: re-inject the LAST user feedback line so
      // the directive is visible even on a fully compacted or resumed
      // transcript (the pinned entries below the keep window cover recent
      // sessions; this covers every other shape).
      try {
        let lastFeedback = null;
        for (let i = state.transcript.length - 1; i >= 0; i--) {
          const e = state.transcript[i];
          if (e && e.kind === 'system' && String(e.text || '').indexOf('USER FEEDBACK') === 0) {
            lastFeedback = e.text; break;
          }
        }
        if (!lastFeedback && state.digest) {
          const m = state.digest.match(/USER FEEDBACK[^\n]*/);
          if (m) lastFeedback = m[0];
        }
        if (lastFeedback) {
          parts.push('# User feedback (still binding)\n' + String(lastFeedback).slice(0, 240));
        }
      } catch (_) { /* best-effort */ }
      if (!parts.length) return '';
      return 'SESSION STATE\n' + parts.join('\n\n');
    }

    function attachedUnitBodies() {
      return KB.queryUnits(knowledge.units, state.attachedUnits);
    }

    function attachKnowledge(result) {
      const events = (result && Array.isArray(result.events))
        ? result.events.filter(x => typeof x === 'string') : [];
      // 89th-round D6: plain {error} results carry no events — extract the
      // leading ALL_CAPS marker from the error message as a pseudo-event so
      // units keyed on that marker still attach (verify error strings are
      // 'MARKER: …' by convention; a no-marker error adds nothing).
      if (!events.length && result && result.error && typeof result.error === 'object' && typeof result.error.message === 'string') {
        const m = result.error.message.match(/^([A-Z][A-Z_]{4,}):/);
        if (m) events.push(m[1]);
      }
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

    // Step plan (spec §3.C, 2026-09-18): cross-turn, step-level progress
    // memory. Rebuilt from the persisted artifact's steps at every
    // service.update; status transitions ride tool receipts — probe receipts
    // ground a step whose script contains a probed selector, verify reports
    // mark steps tested/failed. The dossier carries the plan every turn, so
    // the model never re-researches an already-grounded step.
    function rebuildStepPlan(steps) {
      const prev = new Map((state.stepPlan || []).map((e) => [e.stepId, e]));
      state.stepPlan = (Array.isArray(steps) ? steps : []).map((s, i) => {
        const id = String((s && s.id) || ('step' + (i + 1)));
        const old = prev.get(id);
        return {
          stepId: id,
          name: (s && s.name) ? String(s.name) : '',
          status: old ? old.status : 'planned',
          note: old ? old.note : '',
          sinceTurn: old ? old.sinceTurn : state.spend.turns
        };
      });
    }

    function setStepPlanStatus(stepId, status, note) {
      const e = (state.stepPlan || []).find((p) => p.stepId === String(stepId));
      if (!e) return;
      if (e.status === status && !note) return;
      e.status = status;
      if (note) e.note = String(note).slice(0, 80);
      e.sinceTurn = state.spend.turns;
    }

    // Receipt-driven transitions. verify.run reports carry steps[]; probe
    // tools ground steps whose script contains a selector the probe touched
    // (the cheap form of the GroundingGate receipt match — the same string
    // the gate statically extracts from $-API call positions).
    function updateStepPlanFromResult(toolName, args, result) {
      if (!Array.isArray(state.stepPlan) || !state.stepPlan.length) return;
      if (toolName === 'verify.run' && result && typeof result === 'object') {
        // 89th-round D4: production verify receipts carry compactSteps
        // {stepId,stepName,skipped,iterations,resultPreview} with the verdict
        // at the TOP level — the old s.error/s.result reads never matched and
        // every step got "tested — verify ok" on RED verifies (skipped ones
        // included). Legacy hand-rolled shapes (steps[].error) still work.
        const okFlag = result.ok === true;
        const errStepId = result.error && result.error.stepId ? String(result.error.stepId) : null;
        const errHead = result.error && result.error.message ? String(result.error.message).slice(0, 80) : 'verify failed';
        const steps = Array.isArray(result.steps) ? result.steps : [];
        for (const s of steps) {
          if (!s || s.stepId == null) continue;
          if (s.skipped) continue; // a skipped step was never executed — no blessing
          const legacyFailed = !!(s.error) || !!(s.result && (s.result.error || s.result.failed));
          const failed = legacyFailed || (!okFlag && errStepId === String(s.stepId));
          if (failed) {
            setStepPlanStatus(s.stepId, 'failed', 'verify: ' + String(legacyFailed ? (s.error || (s.result && s.result.error) || 'failed') : errHead).slice(0, 80));
          } else {
            // the step EXECUTED (possibly on a red, field-level verify) —
            // 'tested' with the redirect note; the census owns the field story.
            setStepPlanStatus(s.stepId, 'tested', okFlag ? 'verify ok' : 'verify red — field-level, see census');
          }
        }
        return;
      }
      if (/^probe\./.test(String(toolName)) && args && typeof args === 'object' && !resultHasError(result)) {
        const sels = [args.sel, args.selector, args.containerSel, args.anchorSel, args.scopeSel]
          .filter((x) => typeof x === 'string' && x);
        if (!sels.length) return;
        for (const entry of state.stepPlan) {
          if (entry.status !== 'planned') continue;
          const step = (state.artifactVersions[state.artifactVersions.length - 1] || {}).steps || [];
          const match = step.find((st) => st && st.id === entry.stepId);
          const script = (match && match.script) || '';
          if (script && sels.some((sel) => script.indexOf(sel) !== -1)) {
            setStepPlanStatus(entry.stepId, 'grounded', toolName);
          }
        }
      }
    }

    function resultHasError(result) {
      return !!(result && typeof result === 'object' && typeof result.error === 'string');
    }

    async function handleServiceUpdate(args) {
      const a = args || {};
      const steps = Array.isArray(a.steps) ? a.steps : [];
      // Twentieth log (turns 53-54): a steps-less waiver was rejected here
      // with "steps (non-empty array) required" even though the tool spec
      // says overrides "never carry steps" — and the fourteenth-log
      // testInput-adoption branch in the session-tools handler was
      // unreachable through this wrapper for the same reason. Steps-less
      // calls that amend the CURRENT artifact (testInput adoption, waiver
      // recording, twenty-first log: schema-only contract landing) pass
      // straight through: no new selectors to ground, no artifact version
      // to bump.
      const stepsLessAmendment = !steps.length && (a.testInput != null || a.overrides != null || a.inputSchema != null || a.outputSchema != null);
      // 131st log: abortChunk is BUFFER MANAGEMENT, not an artifact change —
      // the steps-less allowlist above predates the 125th-round chunking, so
      // {abortChunk:true} alone died here as "steps (non-empty array)
      // required", and {steps, abortChunk:true} ran the grounding gates and
      // then pushed a PHANTOM artifact version for a call whose steps the
      // handler never applied (the fourth-log phantom class, resurfaced).
      // Route both shapes straight to the handler: no grounding, no version.
      if (a.abortChunk === true) {
        const abortHandler = tools['service.update'];
        if (typeof abortHandler !== 'function') return { error: 'no service.update handler wired' };
        return await abortHandler(a, { observationLog: observationLog, ledger: ledger, session: publicApi });
      }
      // 134th log: one-turn restore of a PRIOR artifact version. The
      // incident session shipped a red v12 while green v11 sat one version
      // away — the model's original steps were compacted out of the
      // transcript, so restoring meant re-authoring from memory. The engine
      // owns every prior version; {restoreVersion:N} splices its steps in
      // and runs the normal gates (grounding receipts persist per session).
      if (a.restoreVersion != null) {
        const rv = Number(a.restoreVersion);
        const entry = state.artifactVersions.find((v) => v && v.version === rv);
        if (!entry || !Array.isArray(entry.steps) || !entry.steps.length) {
          return { error: 'restoreVersion: ' + a.restoreVersion + ' names no stored version (versions 1..' +
            state.artifactVersions.length + ' exist) — pick the LAST GREEN one (see the finish coercion) or resend steps' };
        }
        a.steps = entry.steps.map((s) => Object.assign({}, s));
        a.restoredFrom = rv;
        steps.length = 0;
        for (const st of a.steps) steps.push(st);
      }
      if (!steps.length && !stepsLessAmendment) return { error: 'steps (non-empty array) required' };
      // Sticky waivers (twentieth log): a waiver recorded once applies to
      // every later grounding check for the rest of the session. The model
      // waived the popover selector with artifact v1, then had to remember
      // to re-send the waiver with EVERY subsequent update — dropping it
      // re-rejected an already-waived selector and burned turns.
      for (const s of normalizeOverrides(a.overrides)) {
        if (state.waivedSelectors.indexOf(s) === -1) state.waivedSelectors.push(s);
      }
      if (stepsLessAmendment) {
        const amendHandler = tools['service.update'];
        if (typeof amendHandler !== 'function') return { error: 'no service.update handler wired' };
        return await amendHandler(a, { observationLog: observationLog, ledger: ledger, session: publicApi });
      }
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
        // must never be lost to a shape mismatch. Accept both shapes, and
        // include every waiver recorded earlier in the session.
        overrides: state.waivedSelectors.slice()
      });
      if (!v.ok) return { grounding: 'rejected', rejections: v.rejections };
      const handler = tools['service.update'];
      if (typeof handler !== 'function') return { error: 'no service.update handler wired' };
      const out = await handler(a, { observationLog: observationLog, ledger: ledger, session: publicApi });
      if (a.restoredFrom != null && out && typeof out === 'object' && typeof out.error !== 'string') {
        try { out.restoredFrom = a.restoredFrom; } catch (_) { /* receipt stamp is best-effort */ }
      }
      // The handler is the authority on whether an artifact was actually
      // created (chain/schema validation, apply). A handler error means NO
      // version exists — announcing one anyway (fourth-log turn 19) sent the
      // session and the UI off to verify a phantom artifact.
      if (out && typeof out === 'object' && typeof out.error === 'string') return out;
      const version = state.artifactVersions.length + 1;
      state.artifactVersions.push({ version: version, steps: steps, at: now() });
      // 143rd log: the finish gate exempts the artifact that IS the restored
      // green (its steps were green-verified as version greenArtifactVersion;
      // a restore landing them as a NEW version must not trip the gate
      // again). Any other steps-carrying update clears the exemption.
      state.greenRestoredCurrent = (a.restoredFrom != null && a.restoredFrom === state.greenArtifactVersion);
      rebuildStepPlan(steps); // §3.C: the persisted artifact defines the plan
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

    // 118th round (efficiency): the measured session carried a 24K digest —
    // a quarter of every prompt re-summarizing procedural history. 8K keeps
    // findings/decisions and drops narrative (head 70% / tail 30% elision).
    const DIGEST_CAP = 8000;

    function maybeCompact() {
      const keepEntries = Math.max(2, compaction.keepTurns * 2);
      const chars = transcriptChars();
      if (chars <= compaction.thresholdChars) return;
      if (state.transcript.length <= keepEntries) return;
      // 89th-round D3: USER FEEDBACK directives are the user's fix requests —
      // rare and small, and folding them to "[protocol nudge]" deleted the
      // instructions ~6 turns into a feedback session. Pin them: pinned
      // entries survive below the keep window as whole messages.
      const isPinned = (e) => !!(e && e.kind === 'system' && String(e.text || '').indexOf('USER FEEDBACK') === 0);
      const keep = state.transcript.slice(-keepEntries);
      const pinned = state.transcript.slice(0, state.transcript.length - keepEntries).filter(isPinned);
      const old = state.transcript.slice(0, state.transcript.length - keepEntries).filter((e) => !isPinned(e));
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
      state.transcript = pinned.concat(keep);
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
      // 117th log: token-fraction advisories — a prompt-weighted chain hits
      // the token cap long before the turn ceiling; the turn-only family
      // stayed silent through the whole creep.
      let tokenDue = null;
      const tokUsed = (state.spend.promptTokens || 0) + (state.spend.completionTokens || 0);
      if (budgets.tokenCap > 0) {
        for (const adv of TOKEN_BUDGET_ADVISORIES) {
          if (tokUsed >= Math.floor(budgets.tokenCap * adv.pct) &&
              state.budgetAdvisories.indexOf(adv.key) === -1) {
            tokenDue = adv;
          }
        }
      }
      if (tokenDue) {
        state.budgetAdvisories.push(tokenDue.key);
        state.transcript.push({ kind: 'system', text: tokenDue.text(tokUsed, budgets.tokenCap) });
        emit('budget_advisory', { key: tokenDue.key, tokens: tokUsed, tokenCap: budgets.tokenCap });
      }
      if (!due) return;
      for (const adv of BUDGET_ADVISORIES) {
        if (state.spend.turns >= Math.floor(budgets.maxTurns * adv.pct) &&
            state.budgetAdvisories.indexOf(adv.key) === -1) {
          state.budgetAdvisories.push(adv.key);
        }
      }
      state.transcript.push({ kind: 'system', text: due.text(state.spend.turns, budgets.maxTurns, state.artifactVersions.length > 0) });
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
      // Skeleton-dossier (2026-09-18 spec §3.B): the evidence dossier is
      // REBUILT here every turn from live feeds + artifact bookkeeping and
      // injected as its own system message — it is never appended to the
      // transcript, so compaction can never fold it away (exemption by
      // construction, not by a transcript kind check).
      const dossierMsg = buildDossierMessage();
      if (dossierMsg) messages.push(dossierMsg);
      const messages2 = messages.concat(
        state.transcript.map(entry => {
          // Window-dedup directive (2026-09-18): big instruction blocks (DSL
          // guide, tool catalog) ride ONLY the current turn's system prompt;
          // historical copies are stripped to a one-line marker so N turns of
          // history do not carry N copies of the same guide.
          if (entry.kind === 'assistant') return { role: 'assistant', content: stripHistoryBlocks(entry.text) };
          if (entry.kind === 'tool') return { role: 'user', content: 'TOOL RESULT ' + stripHistoryBlocks(entry.summary) };
          return { role: 'user', content: stripHistoryBlocks(entry.text) };
        })
      );
      // Window budget directive: design input for 128K tokens — warn inside
      // the dossier when the assembled prompt estimate exceeds it.
      if (dossierMsg) {
        let chars = 0;
        for (const m of messages2) chars += String((m && m.content) || '').length;
        if (Dossier && chars / 4 > Dossier.PROMPT_WINDOW_TOKENS) {
          dossierMsg.content += '\nWINDOW WARNING: assembled prompt ~' + Math.round(chars / 4) +
            ' tokens exceeds the ' + Dossier.PROMPT_WINDOW_TOKENS +
            '-token window design — compact evidence (smaller test input, fewer probed pages) before the next call.';
        }
      }
      // Eighty-sixth-round audit gap: the console capture retains only the
      // first 8000 chars of each LLM request (llm-client logContentChunks
      // cap), so the whole control layer — this dossier ([STEP PLAN]
      // included), USER FEEDBACK entries, knowledge units, system notes —
      // rode the elided tail and three user feedback rounds were
      // unrecoverable for review. Emit ONE compact digest per turn instead
      // of logging 100K-char prompts: auditable steering, bounded bytes.
      try {
        let promptChars = 0;
        for (const m of messages2) promptChars += String((m && m.content) || '').length;
        const sysTexts = messages2.filter((m) => m && m.role === 'system').map((m) => String(m.content || ''));
        const heads = [];
        for (const t of sysTexts) {
          for (const line of t.split('\n')) {
            if (/^(#{1,3} |<EVIDENCE|\[[A-Z]|[A-Z][A-Z -]{4,}:)/.test(line) && heads.indexOf(line) === -1) heads.push(line.slice(0, 90));
            if (heads.length >= 25) break;
          }
          if (heads.length >= 25) break;
        }
        let stepPlan = null;
        for (const t of sysTexts) {
          const i = t.indexOf('[STEP PLAN]');
          if (i !== -1) {
            const j = t.indexOf('[BUDGET]', i);
            stepPlan = t.slice(i, j === -1 ? i + 1200 : j).slice(0, 1200);
            break;
          }
        }
        const sysNoteEntries = state.transcript.filter((e) => e && e.kind === 'system');
        const sysNotes = sysNoteEntries.slice(-3).map((e) => String((e && e.text) || '').split('\n')[0].slice(0, 140));
        console.log('[session] prompt_digest ' + JSON.stringify({
          turn: state.spend.turns,
          promptChars: promptChars,
          msgCount: messages2.length,
          systemHeads: heads,
          stepPlan: stepPlan,
          sysNotesTotal: sysNoteEntries.length,
          sysNotes: sysNotes
        }));
      } catch (_) { /* the digest must never kill the turn */ }
      return messages2;
    }

    // History stripper over cfg.stripBlocks: exact-substring replacement of
    // known instruction blocks with a one-line reference marker. Exported for
    // unit tests.
    const stripHistoryBlocks = makeInstructionStripper(cfg.stripBlocks);

    function buildDossierMessage() {
      if (!Dossier) return null;
      // Inject only when dossier feeds are wired (production wiring always
      // provides them; bare engine harnesses keep the legacy message shape).
      const feeds = (cfg.dossierFeeds && typeof cfg.dossierFeeds === 'object') ? cfg.dossierFeeds : null;
      if (!feeds) return null;
      let popovers = null;
      let evicted = 0;
      try {
        if (typeof feeds.popovers === 'function') {
          popovers = feeds.popovers();
          if (Array.isArray(popovers) && typeof popovers.evicted === 'number') {
            evicted = popovers.evicted;
            popovers = popovers.slice();
          }
        }
        const text = Dossier.buildDossier({
          containerHtml: (typeof feeds.containerHtml === 'function') ? feeds.containerHtml() : null,
          containerHtmlMeta: (typeof feeds.containerHtmlMeta === 'function') ? feeds.containerHtmlMeta() : null,
          popovers: popovers,
          evictedPopovers: evicted,
          lastVerify: (typeof feeds.lastVerify === 'function') ? feeds.lastVerify() : null,
          captureRoutes: (typeof feeds.captureRoutes === 'function') ? feeds.captureRoutes() : null,
          goals: (Array.isArray(state.goals) && state.goals.length) ? state.goals : null,
          hypotheses: (Array.isArray(state.hypotheses) && state.hypotheses.length) ? state.hypotheses : null,
          fixProblems: (Array.isArray(state.fixProblems) && state.fixProblems.length)
            ? state.fixProblems.map((fp) => ((fp && typeof fp === 'object') ? fp : { text: String(fp) }))
            : null,
          artifactVersions: state.artifactVersions.slice(-3),
          stepPlan: Array.isArray(state.stepPlan) ? state.stepPlan : []
        });
        return (typeof text === 'string' && text) ? { role: 'system', content: text } : null;
      } catch (e) {
        return null; // a dossier failure must never kill the turn
      }
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

    // Closure-scope (not persisted): the llm:length grace window is once per
    // session instance lifetime, resume included — bounded extra spend.
    let emptyLengthGraceUsed = false;

    async function callLlm(messages) {
      let attempt = 0;
      while (true) {
        attempt += 1;
        let res = null;
        let err = null;
        try {
          res = await llmWait(() => llm({ messages: messages, maxTokens: budgets.maxTokensPerCall }));
        } catch (e) { err = e; }
        if (err) {
          // Fifty-fourth log: the llm client already owns timeout/retry
          // discipline (chatWithRetry: 3 wire attempts with backoff). A
          // TIMED-OUT call retried AGAIN at the engine layer multiplied into
          // a ~20-minute spiral (120s × 3 client × 3 engine) that ate the
          // whole wall-clock budget while the v1 artifact sat one verify
          // away. Timeouts are terminal here; only transient non-timeout
          // errors keep the engine retry.
          if (/timed?[ -]?out|timeout/i.test(String((err && err.message) || err))) {
            throw Object.assign(new Error(String((err && err.message) || err)), { code: 'LLM_ERROR' });
          }
          state.spend.llmCalls += 1;
          emit('llm_reply', { chars: 0, finish_reason: '' });
        }
        if (!err) {
          state.spend.llmCalls += 1;
          accountUsage(messages, res);
          const content = res && typeof res.content === 'string' ? res.content : '';
          const finish = res && typeof res.finish_reason === 'string' ? res.finish_reason : '';
          emit('llm_reply', { chars: content.length, finish_reason: finish });
          if (!content.trim() && finish === 'length') {
            // RC55: empty + length is deterministic budget exhaustion — a retry
            // burns the same completion budget again. Non-retryable.
            // Twenty-seventh log amendment: the burn is sometimes STOCHASTIC
            // (turn 28 burned 16384 tokens pre-content; the same-context call
            // one resume later succeeded). ONE session-scope grace retry
            // recovers the transient case without user intervention — a
            // second burn still hits the RC55 stop. Bounded extra spend:
            // exactly one extra call per session.
            if (!emptyLengthGraceUsed) {
              emptyLengthGraceUsed = true;
              emit('llm_grace_retry', { note: 'empty content with finish_reason=length — retrying the same context once before the non-retryable stop' });
              attempt = 0;
              continue;
            }
            throw Object.assign(new Error('empty content with finish_reason=length (completion budget exhausted pre-content)'), { code: 'EMPTY_LENGTH' });
          }
          if (content.trim()) return content;
          // empty without length: transient shape — retry
        }
        if (attempt >= retry.attempts) {
          if (err) throw Object.assign(new Error(String((err && err.message) || err)), { code: 'LLM_ERROR' });
          throw Object.assign(new Error('empty LLM reply (no finish_reason=length) after ' + attempt + ' attempts'), { code: 'LLM_EMPTY' });
        }
        // Fifty-fourth log: never START another multi-minute attempt when
        // the wall clock is nearly gone — die as the resumable wallClock
        // stop instead of burning the budget inside a retry spiral.
        if (state.elapsedMs + netSegmentMs() >= budgets.wallClockMs - 120000) {
          throw Object.assign(new Error('time budget nearly exhausted inside an LLM retry loop — raise the budget (wallClockMs) in the resume seed to continue'), { code: 'WALL_CLOCK_RETRY' });
        }
        if (retry.backoffMs > 0) await llmWait(() => sleep(retry.backoffMs * Math.pow(2, attempt - 1)));
      }
    }

    function llmStopFromError(err) {
      if (err && err.code === 'EMPTY_LENGTH') return ['llm:length', String(err.message || err)];
      // Fifty-fourth log: the retry-spiral guard dies as the RESUMABLE
      // wallClock stop, not an error — the artifact is often one verify away.
      if (err && err.code === 'WALL_CLOCK_RETRY') return ['wallClock', String(err.message || err)];
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
        // Seventy-second log backstop: if a tool:"finish" turn ever reaches
        // dispatch (e.g. alongside a finish key in some other route), teach
        // the shape instead of the bare unknown-tool error.
        if (name === 'finish') {
          return { error: 'finish is the protocol-level action, not a tool: resend this turn as {"finish":{"summary":"…"}} (top-level, exactly one of tool/finish)' };
        }
        return { error: 'unknown tool: ' + name, available: availableToolNames() };
      }
      try {
        return sanitizeToolResult(await fn(args, { observationLog: observationLog, ledger: ledger, session: publicApi }));
      } catch (err) {
        return { error: String((err && err.message) || err) };
      }
    }

    // Seventieth log F3: per-tool wall time around dispatchTool (timeouts
    // included — a timed-out call burns real budget). Surfaced on the
    // wallClock/maxTurns stop detail so the user sees WHERE the time went.
    // Session-closure scope: loop() records, the stop path and the public
    // timing API read the same accumulator.
    const toolTimings = new Map();
    function recordToolTiming(tool, ms, timedOut) {
      const k = String(tool || 'unknown');
      const e = toolTimings.get(k) || { ms: 0, calls: 0, timeouts: 0 };
      e.ms += Math.max(0, Number(ms) || 0);
      e.calls += 1;
      if (timedOut) e.timeouts += 1;
      toolTimings.set(k, e);
    }
    function formatTimeBudgetSuffix() {
      // Seventy-first log F2: llm/provider waits are their own line item —
      // they are excluded from wallClock, so naming them here closes the
      // "where did the clock go" question the 71st-log session died on.
      const parts = [];
      if (toolTimings.size > 0) {
        const rows = Array.from(toolTimings.entries())
          .sort((a, b) => b[1].ms - a[1].ms).slice(0, 3)
          .map(([t, d]) => t + ' ' + Math.round(d.ms / 1000) + 's/' + d.calls + ' call' + (d.calls === 1 ? '' : 's') +
            (d.timeouts ? ' (' + d.timeouts + ' timed out)' : ''));
        if (rows.length) parts.push('top consumers: ' + rows.join(', '));
      }
      if (llmWaitTotal > 0) parts.push('llm/provider waits ' + Math.round(llmWaitTotal / 1000) + 's (excluded from wallClock)');
      if (!parts.length) return '';
      const suffix = ' [TIME BUDGET — ' + parts.join('; ') + ']';
      return suffix.length <= 240 ? suffix : suffix.slice(0, 237) + '...]';
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
      // Sixty-eighth log F2: consecutive-identical-failure tracker. The
      // incident resent the SAME failing 33-container $extractWithHover
      // snippet 3x against the 30s probe budget — identical input, identical
      // error, no shape change. Tracks the last FAILED tool call (name +
      // args serialization) and error prefix; a second consecutive failure
      // of the same call with the same error prefix (first 80 chars) emits
      // ONE system transcript note teaching a shape change. Any success or
      // any args/error change resets the tracker. F10: + a ring of the last
      // 3 failing canonical keys (non-consecutive repeat within 3 fires too)
      // and transient-signature errors are exempt (retryable by teaching).
      let lastFail = null;
      const recentFailKeys = [];
      // Seventieth log F2: error-CLASS tracker. The incident saw 11
      // probe.snippet SCRIPT_TIMEOUTs with VARIED arguments — the exact-args
      // rule above never fired because every call key differed. The SHAPE
      // (same tool, same error class, different args) is the signal.
      let lastClassFail = null;
      try {
        while (true) {
          if (abortFlag) { report = await stop('aborted', abortReason); break; }
          if (pauseFlag) {
            pauseFlag = false;
            state.elapsedMs += netSegmentMs();
            parkedThisSegment = 0;
            llmWaitThisSegment = 0;
            state.status = 'paused';
            state.stopped = { reason: 'paused', detail: null };
            emit('paused', {});
            await persistFinal();
            report = buildReport();
            break;
          }
          if (state.spend.turns >= budgets.maxTurns) {
            report = await stop('maxTurns', state.spend.turns > 0
              ? 'budget exhausted at ' + state.spend.turns + '/' + budgets.maxTurns + ' turns — raise the budget (maxTurns) in the resume seed to continue' + verifyStopSuffix() + formatTimeBudgetSuffix()
              : null);
            break;
          }
          if (state.elapsedMs + netSegmentMs() >= budgets.wallClockMs) {
            report = await stop('wallClock', 'time budget exhausted after ~' + Math.round((state.elapsedMs + netSegmentMs()) / 1000) + 's (parked ' + Math.round(parkedTotal / 1000) + 's excluded) [LLM/provider waits ' + Math.round(llmWaitTotal / 1000) + 's excluded] — raise the budget (wallClockMs) in the resume seed to continue' + verifyStopSuffix() + formatTimeBudgetSuffix());
            break;
          }
          if (state.spend.promptTokens + state.spend.completionTokens >= budgets.tokenCap) { report = await stop('tokenCap', buildTokenCapDetail(state.spend, budgets)); break; }
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
            // (third live log). Fifty-third log: the nudge is now CLASS-AWARE
            // — glm-5.3-flash intermittently ends its reply after "think"
            // (valid JSON, reasoning, no action), and the generic
            // JSON-quoting lecture is noise for that class (the reply was
            // legal JSON; the model must COMMIT an action, not fix quotes).
            const isActionShapeViolation = (v) => v === 'missing-action' || v === 'ambiguous-action';
            const nudgeFor = (p, round) => {
              const head = 'PROTOCOL VIOLATION (' + p.violation + (p.detail ? ' — ' + p.detail : '') + '): ';
              if (p.violation === 'missing-action' && /think/.test(String(p.detail || ''))) {
                return head + 'your reply REASONED but never committed an action — it ended after "think". ' +
                  (round >= 2 ? 'FINAL CHANCE. ' : '') +
                  'Resend now: keep your think, then ADD exactly one of "tool": "<name>" + "args": {…} or "finish": { "summary": "…" } (finish goes at the top level, not in the tool slot). ' +
                  'Your think already names the next step — commit it as the action.';
              }
              if (p.violation === 'ambiguous-action') {
                return head + 'your reply named BOTH "tool" and "finish" — keep exactly one (finish only when the session is done). ' +
                  (round >= 2 ? 'FINAL CHANCE. ' : '') +
                  'Resend the same turn with ONE action.';
              }
              // JSON-shape classes keep the quoting-led lecture.
              return head + 'reply with ONE JSON object with exactly one of "tool" or "finish". No prose outside the JSON. Strict JSON quoting only: double quotes for every key and string value — single quotes are NOT valid JSON, and an unescaped double quote inside a value must be escaped (\\") or avoided.' +
                (round >= 2 ? ' FINAL CHANCE.' : '');
            };
            // Fifty-third log: action-shape violations (valid JSON, no
            // committed action) get TWO repair rounds before the stop — the
            // first repaired 4 of 5 live think-only replies, and the fifth
            // killed an 18-turn session with 70% of the budget left. JSON
            // classes keep the original two-strike behavior (the cut-off
            // class additionally keeps its continuation round below).
            const maxRepairRounds = isActionShapeViolation(parsed.violation) ? 2 : 1;
            // 126th round (user: replies must never be lost to truncation):
            // the provider gateway cuts completions at ~2K tokens while
            // reporting finish stop (usage proof: 2007/1937/1456 completion
            // tokens with max_tokens 32768 requested). We cannot stop the
            // provider cutting — we make the ESCAPE mechanical: after two
            // consecutive cut-off replies, generic "resend shorter/continue"
            // advice has already failed once; the nudge becomes per-step
            // chunking that can never hit the ceiling.
            let consecutiveCutOff = 0;
            try {
              // 129th-round review fix: the streak now reads a PERSISTED
              // counter (state.cutOffNudgeCount, incremented at the nudge
              // push below) instead of scanning the transcript — maybeCompact
              // folds every old system nudge to '- [protocol nudge]' and
              // DELETES the marker text, so the scan undercounted exactly in
              // the long sessions this escape targets. +1 for THIS cut-off;
              // still session-cumulative, not strictly turn-consecutive (the
              // 125th-run death was reply-cut, repair-cut, continuation-cut —
              // three separate turns across a resume).
              if (/cut-off/.test(String(parsed.detail || ''))) {
                consecutiveCutOff = (state.cutOffNudgeCount || 0) + 1;
              }
            } catch (e) { consecutiveCutOff = 0; }
            let repaired = null;
            let repairRound = 0;
            while (repairRound < maxRepairRounds) {
              repairRound += 1;
              // Fifth-live-log turn 21: BOTH the original and the repair reply
              // were cut off before the closing braces (finish_reason "stop").
              // Generic advice made the model resend at the same length and
              // truncate again — name the class and demand a shorter resend.
              let nudgeText = nudgeFor(parsed, repairRound);
              if (parsed.detail && /cut-off|Unterminated string|Unexpected end/i.test(parsed.detail)) {
                nudgeText += ' Your previous reply was CUT OFF before the JSON closed. Resend the SAME turn much SHORTER: a one-sentence think, then tool/args, then the closing braces — long replies are the ones that get truncated.';
                // 129th-round review fix: increment the PERSISTED counter at the
                // push site — the old streak counted these transcript entries,
                // which compaction later eats (marker text destroyed).
                state.cutOffNudgeCount = (state.cutOffNudgeCount || 0) + 1;
              // 125th round: a cut-off service.update/io.confirm payload CANNOT
              // be shortened (the artifact is the required content) — teach the
              // chunked-send escape on every cut-off (harmless for probe-sized
              // replies: the advice is conditional).
              if (/cut-off/.test(String(parsed.detail || ''))) {
                nudgeText += ' If the cut-off reply was a service.update (the artifact payload cannot shrink): send it CHUNKED — service.update({steps:[first part], more:true}) now, the remaining parts next turn, final part without more.';
                if (consecutiveCutOff >= 2) {
                  // 129th-round review fix: count-accurate and non-permanent —
                  // the old text claimed exactly "two replies" (wrong for any
                  // other count) and forbade multi-step replies for the REST of
                  // the session. The unreachable repairRound>=2 arm is gone
                  // (maxRepairRounds is 1 for the cut-off/JSON class).
                  nudgeText += ' MECHANICAL ESCAPE (this session has now seen ' + consecutiveCutOff + ' truncated replies (provider ~2K-token completion ceiling)): send service.update({steps:[EXACTLY ONE step], more:true}) — ONE step per reply, repeat until every step is sent, final step without more. Use one-step-per-reply chunks for the remainder of this session.';
                }
              }
              }
              state.transcript.push({ kind: 'system', text: nudgeText });
              try {
                repaired = await callLlm(assembleMessages());
              } catch (err) {
                const s = llmStopFromError(err);
                report = await stop(s[0], s[1]);
                break;
              }
              const p2 = Protocol.parseAssistantTurn(repaired);
              if (p2.ok) { parsed = p2; break; }
              // Eighteenth log: the repair failure was invisible — only the
              // first violation got an event. Surface EVERY failed parse.
              emit('protocol_violation', { violation: p2.violation, detail: p2.detail || null });
              parsed = p2;
            }
            if (report) break; // the callLlm error path above already stopped the session
            if (!parsed.ok) {
              // Eighteenth log: for a STILL-cut-off reply run ONE continuation
              // round before giving up — quote the exact cut point, ask for
              // ONLY the remainder, and splice (overlap-merge tolerates the
              // model repeating its last tokens). Non-cut-off classes keep
              // the original two-strike behavior.
              const stillCutOff = !!(parsed.detail && /cut-off|Unterminated string|Unexpected end/i.test(parsed.detail));
              let winning = null;
              if (stillCutOff) {
                const base = Protocol.extractJsonObject(repaired) || String(repaired || '');
                state.transcript.push({ kind: 'system', text:
                  'CONTINUATION REPAIR: your reply was cut off EXACTLY after ' + JSON.stringify(base.slice(-120)) +
                  '. Reply with ONLY the continuation that completes it from that exact point — do NOT reopen the object, do NOT repeat earlier text, no prose, no code fence; start mid-token if the cut fell mid-token.' });
                let cont = null;
                try {
                  cont = await callLlm(assembleMessages());
                } catch (err) {
                  const s = llmStopFromError(err);
                  report = await stop(s[0], s[1]);
                  break;
                }
                for (const variant of continuationCandidates(base, cont)) {
                  const p = Protocol.parseAssistantTurn(variant);
                  if (p.ok) { parsed = p; winning = variant; break; }
                }
              }
              if (!parsed.ok) {
                // Eighteenth log: the repair failure was invisible — only the
                // first violation got an event, and stop() carried the bare
                // class name while the parse evidence (position, tail)
                // evaporated exactly where the session died.
                report = await stop('protocol', parsed.violation + (parsed.detail ? ' — ' + parsed.detail : ''));
                break;
              }
              content = winning;
            } else {
              content = repaired;
            }
          }
          const turn = parsed.turn;
          // Seventy-second log (session-2): parseAssistantTurn coerced a
          // {"tool":"finish","args":{…}} turn into the protocol finish
          // action. Log the teaching note (visible to resume/next session)
          // and proceed with the finish flow — the coercion IS the recovery,
          // no extra LLM round.
          if (turn.coercedFinish) {
            state.transcript.push({ kind: 'system', text:
              'shape note: finish was sent as a tool — coerced to the protocol finish action; finish lives at the TOP LEVEL of the turn JSON ({"finish":{"summary":"…"}}), exactly one of "tool"/"finish".' });
          }
          applyTurnState(turn);
          state.spend.turns += 1;

          state.transcript.push({ kind: 'assistant', text: content });
          await persist();
          if (turn.finish) {
            // 143rd log finish gate: the incident session finished at 79/80
            // shipping a RED v5 as "best-effort" while GREEN v3 sat one
            // restore turn away — every disclosure fired, the restore hint
            // was named, and the model still shipped the red artifact
            // (deploying an unverified service with a verified one in hand).
            // A finish under LAST-VERIFY-RED + an existing GREEN version +
            // current != green is now REJECTED with the exits spelled out;
            // the model either restores, verifies its fix green, or
            // explicitly overrides (shipRedArtifact:true) when the red
            // version is genuinely the better ship.
            if (state.lastVerifyOk === false &&
                state.greenArtifactVersion &&
                !state.greenRestoredCurrent &&
                state.artifactVersions.length > state.greenArtifactVersion &&
                turn.finish.shipRedArtifact !== true) {
              state.transcript.push({ kind: 'system', text:
                'FINISH BLOCKED: the last verify ran RED against the CURRENT artifact (v' + state.artifactVersions.length +
                ') while a GREEN-verified version (v' + state.greenArtifactVersion + ') is one restore away — shipping now deploys the unverified artifact with a verified one in hand. ' +
                'Either (a) service.update({restoreVersion:' + state.greenArtifactVersion + '}) — ONE turn, restores the verified steps — then finish; ' +
                '(b) fix the current artifact and verify it GREEN before finishing; or ' +
                '(c) finish with {"finish":{"summary":"…","shipRedArtifact":true}} to explicitly ship the red artifact with its disclosures — only when the red version is genuinely the better ship.' });
              state.spend.finishBlocks = (state.spend.finishBlocks || 0) + 1;
              await persist();
              continue;
            }
            // Thirteenth log: five consecutive RED verifies still finished as a
            // plain 'completed' — an honest ship note must not read as green.
            let detail = turn.finish.summary || null;
            if (state.lastVerifyOk === false) {
              const ef = state.lastVerifyEmptyFields
                ? '; confirmed field(s) empty in every record: ' + state.lastVerifyEmptyFields.join(', ') +
                  ' — renegotiate the contract (io.confirm) or bind a source for each before shipping'
                : '';
              // 134th log: a green predecessor + the one-turn restore — the
              // incident session shipped red v12 while green v11 sat one
              // version away and its steps were compacted away.
              const greenRestore = (state.greenArtifactVersion && state.artifactVersions.length > state.greenArtifactVersion)
                ? ' [LAST GREEN = v' + state.greenArtifactVersion + ' — service.update({restoreVersion:' + state.greenArtifactVersion + '}) restores the verified artifact in ONE turn; ship that, or renegotiate]'
                : '';
              detail = (detail ? detail + ' ' : '') +
                '[LAST VERIFY FAILED — shipped best-effort; the review panel shows the failing run' + ef + ']' + greenRestore;
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
            // Forty-sixth log: independent of the ladder above — a GREEN
            // verify shipped 3-of-5 (count requested via the confirmed test
            // input) and postTime as relative ages ("a day ago") with every
            // branch silent. Disclose alongside, not instead.
            if (state.lastVerifyCountShortfall) {
              // 144th round: the trailer contradicted the body when the
              // shortfall was UNIQUE-count-shaped (records met the ask,
              // unique items did not) — branch the closing line on it.
              const csTrailer = /UNIQUE item/.test(state.lastVerifyCountShortfall)
                ? 'the delivered UNIQUE count is below the ask — deduplicate and keep collecting, or ship the unique count disclosed'
                : 'the user requested a count the run did not deliver — ship consciously or renegotiate';
              detail = (detail ? detail + ' ' : '') +
                '[VERIFY COUNT-SHORTFALL — ' + state.lastVerifyCountShortfall + '; ' + csTrailer + ']';
            }
            if (state.lastVerifyRelativeTimestamps) {
              detail = (detail ? detail + ' ' : '') +
                '[VERIFY RELATIVE-TIMESTAMPS — time field(s) carrying relative ages, not absolute values: ' + state.lastVerifyRelativeTimestamps.join(', ') + '; rebind to the datetime attribute / labelledby reference / hovercard, SHIP the relative age with disclosure (report-only — verify passes), or renegotiate the contract via io.confirm]';
            }
            if (state.lastVerifyTimeImplausible) {
              // Fifty-fifth log: postTime shipped as "Learn More" on 5/8
              // records behind this exact silence.
              detail = (detail ? detail + ' ' : '') +
                '[VERIFY TIME-IMPLAUSIBLE — time field(s) whose values carry no date shape: ' + state.lastVerifyTimeImplausible.join('; ') + '; re-bind to the timestamp anchor whose value matches a date, or renegotiate]';
            }
            if (state.lastVerifyJunkFields) {
              detail = (detail ? detail + ' ' : '') +
                '[VERIFY JUNK-VALUES — field(s) carrying junk values: ' + state.lastVerifyJunkFields.join(', ') + ']';
            }
            if (state.lastVerifyPositionLikeIds) {
              detail = (detail ? detail + ' ' : '') +
                '[VERIFY POSITION-LIKE-IDS — id field(s) holding position/index values, not identities: ' + state.lastVerifyPositionLikeIds.join('; ') + '; re-bind to the record permalink/href or drop the field]';
            }
            // 139th log: the incident's green finish omitted these — they
            // must reach the shipped disclosure, not just the verify report.
            if (state.lastVerifyLabelPrefixedCounts) {
              detail = (detail ? detail + ' ' : '') +
                '[VERIFY LABEL-PREFIXED-COUNTS — count field(s) shipping the control label plus the count: ' + state.lastVerifyLabelPrefixedCounts.join('; ') + '; parse the number (the verify report carries the parsed sample) or re-bind]';
            }
            if (state.lastVerifyDuplicateIds) {
              detail = (detail ? detail + ' ' : '') +
                '[VERIFY DUPLICATE-ITEMS — repeated items among the delivered records: ' + state.lastVerifyDuplicateIds.join('; ') + '; the delivered UNIQUE count is what a count-bounded requirement measures — deduplicate and keep collecting, or ship the unique count disclosed]';
            }
            // Twenty-seventh log: the shipped artifact had no verify at all
            // while the ladder named only the OLDER artifact's failure —
            // both disclose. Shared helper with the budget stops
            // (twenty-eighth log: same gap, maxTurns path).
            const unverifiedSuffix = unverifiedArtifactSuffix('shipped');
            if (unverifiedSuffix) {
              detail = (detail ? detail + ' ' : '') + unverifiedSuffix;
            }
            report = await stop('completed', detail);
            break;
          }
          emit('tool_call', { tool: turn.tool, args: turn.args });
          // Seventieth log F3: time the dispatch (failures included) and
          // count SCRIPT_TIMEOUT-class results as timeouts for the suffix.
          const __t0 = Date.now();
          let result = await dispatchTool(turn.tool, turn.args);
          recordToolTiming(turn.tool, Date.now() - __t0,
            isErrorResult(result) && /^SCRIPT_TIMEOUT\b/.test(String(result && result.error)));
          // §3.C: receipt-driven step-plan transitions (probe grounding,
          // verify tested/failed). Best-effort — never kills the turn.
          try { updateStepPlanFromResult(turn.tool, turn.args, result); } catch (e) { /* plan is advisory */ }
          let verifyDigest = null;
          if (turn.tool === 'verify.run') {
            // Twenty-eighth log: verify2 and verify3 returned IDENTICAL
            // scores and the model concluded "the run did NOT execute v3" —
            // unfalsifiable from its vantage, and wrong (verify runs the
            // live draft via getDraftService; staleness is impossible).
            // Scores are count-based, so identical shapes repeat; name the
            // version the report executed. First key, because the model
            // reads tool results through a head-sliced summary window.
            // 'ok' in result: a verify REPORT (green or red — red reports
            // carry an `error` key by shape); plain dispatch failures look
            // like {error:'no artifact yet'} and get no stamp.
            if (result && typeof result === 'object' && !Array.isArray(result) && 'ok' in result) {
              result = Object.assign({ executedArtifactVersion: state.artifactVersions.length }, result);
              // Thirty-third log D3: cross-verify memory. A field a PRIOR
              // verify populated that this one empties completely is a
              // regression the step changes between the runs likely explain
              // — without this signal the model read the flip as
              // "session-state-dependent, never reproduces" and shipped a
              // required field empty over its own timing change.
              if (VR && typeof VR.detectFieldRegression === 'function') {
                const reg = VR.detectFieldRegression(result, state.priorVerifyReport, state.artifactVersions.length);
                if (reg) {
                  if (result.detectors && typeof result.detectors === 'object' && !Array.isArray(result.detectors)) {
                    result.detectors.fieldRegression = reg;
                  }
                  if (Array.isArray(result.events)) result.events.push('FIELD_REGRESSION');
                  if (result.error && typeof result.error === 'object' && typeof result.error.message === 'string' &&
                      result.error.message.indexOf('FIELD REGRESSION') === -1) {
                    result.error.message += ' (FIELD REGRESSION: a prior verify run POPULATED ' +
                      reg.fields.map((f) => f.path).join(', ') +
                      ' — read detectors.fieldRegression before concluding the value never exists)';
                  }
                }
              }
            // 144th round: the 143rd red was feed nondeterminism — the SAME
            // artifact verified GREEN one run earlier; the model had no way
            // to know a re-verify just re-rolls the population. When a red
            // carries the duplicate-entity veto and the PRIOR verify of the
            // SAME artifact version was green, append the variance teaching
            // to the error message (the strongest channel to the model).
            try {
              if (result && result.ok === false && result.error && /DUPLICATE_ENTITY_PAIRS/.test(String(result.error.message)) &&
                  state.priorVerifyReport && state.priorVerifyReport.ok === true &&
                  state.lastVerifyArtifactVersion === state.artifactVersions.length) {
                result.error.message = String(result.error.message) +
                  ' POPULATION VARIANCE: the PRIOR verify of this SAME artifact version was GREEN — the page serves repeated items nondeterministically, so the duplicate may not reproduce on a re-run. The DURABLE fix is the entity-signature dedupe in the step assembly (dedupe by the matched fields, e.g. content+postTime, when ids collide or repeat); re-verifying the artifact unchanged just re-rolls the population.';
              }
            } catch (e) { /* the note is best-effort; the report flows on */ }
              state.priorVerifyReport = result;
            }
            state.lastVerifyOk = !!(result && typeof result === 'object' && result.ok === true);
            // 129th-round review fix: green-only finalResult snapshot for
            // the same-site seed (see the state defaults). The report's
            // finalResult is the context-diet-sampled copy (3 records,
            // capped strings) — enough for the ≤2-samples-per-field seed
            // and bounded for persistence.
            if (state.lastVerifyOk && result && typeof result.finalResult !== 'undefined') {
              state.lastVerifyFinalResult = result.finalResult || null;
              // 134th log: remember WHICH version the last green verified —
              // the finish/budget coercions name it (with the one-turn
              // restoreVersion op) whenever a later rewrite turns red.
              state.greenArtifactVersion = (typeof result.executedArtifactVersion === 'number')
                ? result.executedArtifactVersion : state.lastVerifyArtifactVersion;
            }
            state.lastVerifyArtifactVersion = state.artifactVersions.length;
            const pe = (result && result.detectors && Array.isArray(result.detectors.partialEmptyFields))
              ? result.detectors.partialEmptyFields
              : [];
            state.lastVerifyEmptyFields = pe.length
              ? pe.slice(0, 6).map((f) => String(f.path || f.field) + ' ' + (f.emptyCount || 0) + '/' + (f.totalCount || 0) + ' empty')
              : null;
            const cs = (result && result.detectors && result.detectors.countShortfall) ? result.detectors.countShortfall : null;
            state.lastVerifyCountShortfall = cs
              ? 'requested ' + cs.requested + ' via the test input, extracted ' + cs.extracted + ' into ' + JSON.stringify(cs.field) + (cs.severe ? ' (severe)' : '') +
                // 135th log: a hand-rolled "exhausted" flag is not a supply
                // fact — the suffix names the certification state so the
                // ship disclosure cannot pass an unproven claim as a page
                // limit (the incident session shipped 4/6 as "feed
                // exhausted" off a one-iteration flag on the cold tab).
                (cs.exhaustionCertified === false
                  ? ' — exhaustion NOT certified (no $collectUntil receipt; certify or ship with this caveat)'
                  : (cs.exhaustionCertified === true ? ' — exhaustion CERTIFIED ($collectUntil receipt in the run)' : '')) +
                // 144th round: the 143rd finish read "extracted 7 ... the
                // user requested a count the run did not deliver" — the
                // 139th unique-shortfall fired (7 records / 6 unique) but
                // the wording was record-count-shaped. Name the unique
                // count whenever it is the binding number.
                (typeof cs.uniqueExtracted === 'number' && cs.uniqueExtracted < cs.requested
                  ? ' — only ' + cs.uniqueExtracted + ' UNIQUE item(s) among them: a count-bounded requirement counts UNIQUE items; deduplicate in the assembly and keep collecting'
                  : '')
              : null;
            const rtList = (result && result.detectors && Array.isArray(result.detectors.relativeTimestamps))
              ? result.detectors.relativeTimestamps
              : [];
            state.lastVerifyRelativeTimestamps = rtList.length
              ? rtList.slice(0, 6).map((f) => String(f.path || f.field) + ' ' + (f.relativeCount || 0) + '/' + (f.totalRecords || 0) + ' relative' +
                  ((f.partialAbsoluteCount || 0) > 0 ? ' + ' + f.partialAbsoluteCount + ' partial absolutes (no year, e.g. ' + JSON.stringify(String(f.partialSample || '').slice(0, 40)) + ')' : '') +
                  ' (e.g. ' + JSON.stringify(String(f.sampleValue || '').slice(0, 40)) + ')')
              : null;
            // Fifty-fifth log: the junk-class censuses must ride the stop
            // disclosures too — the model shipped postTime="Learn More" on
            // 5/8 records behind a green verify whose finish summary named
            // only the partial-empties; the user reading the completion
            // never learned the time field was garbage.
            const itfList = (result && result.detectors && Array.isArray(result.detectors.implausibleTimeFields))
              ? result.detectors.implausibleTimeFields
              : [];
            state.lastVerifyTimeImplausible = itfList.length
              ? itfList.slice(0, 4).map((f) => String(f.path || f.field) + ' ' + (f.implausibleCount || 0) + '/' + (f.nonEmpty || 0) + ' no date shape (e.g. ' + JSON.stringify(String(f.sample || '').slice(0, 30)) + ')')
              : null;
            const jfList = (result && result.detectors && result.detectors.junkValues && Array.isArray(result.detectors.junkValues.fields))
              ? result.detectors.junkValues.fields
              : [];
            // Fifty-eighth log: two census entries for the SAME field
            // (queryBlob + opaqueToken kinds) printed the field twice in the
            // finish disclosure — dedupe, keep first-seen order.
            state.lastVerifyJunkFields = jfList.length
              ? Array.from(new Set(jfList.slice(0, 8).map((f) => String(f.field || f.path)).filter(Boolean))).slice(0, 6)
              : null;
            // 139th log: label-prefixed counts + duplicate ids must ride the
            // same disclosure ladder — the incident's green finish named the
            // partial-empties but not the label strings or the 7-records-
            // 4-unique inflation.
            const lpList = (result && result.detectors && Array.isArray(result.detectors.labelPrefixedCounts))
              ? result.detectors.labelPrefixedCounts : [];
            state.lastVerifyLabelPrefixedCounts = lpList.length
              ? lpList.slice(0, 4).map((f) => String(f.path || f.field) + ' ' + (f.count || 0) + ' record(s) e.g. ' + JSON.stringify(String(f.sample || '').slice(0, 30)))
              : null;
            const dupList = (result && result.detectors && Array.isArray(result.detectors.duplicateIdValues))
              ? result.detectors.duplicateIdValues : [];
            state.lastVerifyDuplicateIds = dupList.length
              ? dupList.slice(0, 4).map((d) => (d.kind === 'contentSignature'
                  ? 'content signature ' + JSON.stringify(String(d.sampleSignature || '').slice(0, 30)) + ' on records ' + (d.indices || []).join(',')
                  : String(d.field) + ' repeated on records ' + (d.indices || []).join(',')))
              : null;
            const pliList = (result && result.detectors && Array.isArray(result.detectors.positionLikeIds))
              ? result.detectors.positionLikeIds
              : [];
            state.lastVerifyPositionLikeIds = pliList.length
              ? pliList.slice(0, 4).map((f) => String(f.path || f.field) + ' (position-like values e.g. ' + JSON.stringify(String(f.sample || '')) + ')')
              : null;
            state.lastVerifySchemaBlind = !!(Array.isArray(result && result.events) && result.events.indexOf('SCHEMA_BLIND') !== -1);
            // The tool_result event's summary is a capped one-liner — too
            // short for the verify report's verdict. Attach a compact digest
            // (sixteenth log: tags and detector findings were invisible in
            // exported console logs, so green-with-empties was undiagnosable
            // from the log alone).
            verifyDigest = {
              ok: state.lastVerifyOk,
              score: (result && result.score && typeof result.score.score === 'number') ? Math.round(result.score.score) : null,
              executedVersion: state.artifactVersions.length,
              tags: Array.isArray(result.events) ? result.events.slice(0, 8) : [],
              partialEmpty: state.lastVerifyEmptyFields || [],
              countShortfall: state.lastVerifyCountShortfall,
              relativeTimestamps: state.lastVerifyRelativeTimestamps || []
            };
          }
          // Replay/persistence must carry WHAT was probed (the args), not just
          // the result — a resumed context still shows the selector used.
          const callLabel = turn.tool + ' ' + JSON.stringify(turn.args || {});
          // Thirty-second log RC-A: the transcript entry is what the LLM
          // actually reads next turn. The flat head-only summarize destroyed
          // every tail key past ~4000 chars (detectors/steps/finalResult were
          // invisible and the model guessed DSL shapes for want of evidence)
          // — compact structure-aware instead: all keys alive, head+tail
          // strings, array counts, tight label.
          const summary = Protocol.compactToolResultForLLM(callLabel, result, toolResultCapFor(turn.tool));
          state.transcript.push({ kind: 'tool', name: turn.tool, ok: !isErrorResult(result), result: result, summary: summary });
          // Sixty-eighth log F2: nudge on the 2nd consecutive identical
          // failure (same tool + same args + same error prefix). See the
          // tracker declaration at loop start for the incident.
          // Sixty-ninth review F10 hardening:
          //  - the call key uses a CANONICAL args serialization (recursively
          //    key-sorted) — {a,b} vs {b,a} is the SAME call, not a new one;
          //  - TRANSIENT-looking errors (network/retry/timeout classes the
          //    engine already teaches as retryable) never fire the nudge;
          //  - besides the consecutive slot, a small ring of the last 3
          //    failing keys fires on a NON-consecutive repeat within 3 —
          //    fail, one unrelated call, fail-again used to reset the slot
          //    and silence the nudge.
          if (isErrorResult(result)) {
            const failMsg = typeof result.error === 'string' ? result.error : 'grounding rejected';
            const transientRe = /transient|retry|timeout after|network|Failed to fetch/i;
            const isTransient = transientRe.test(String(failMsg));
            const callKey = turn.tool + '|' + JSON.stringify(canonicalizeArgs(turn.args || {}));
            const errPrefix = String(failMsg).slice(0, 80);
            // Seventieth log F2: first whitespace-delimited token of the
            // error message, uppercased to [A-Z_]+ — the engine's stable
            // error classes (SCRIPT_TIMEOUT, ELEMENT_NOT_FOUND, ...).
            const errorClass = (String(failMsg).trim().split(/\s+/)[0] || '').toUpperCase().replace(/[^A-Z_]/g, '');
            if (!isTransient) {
              const consecutive = lastFail && lastFail.tool === turn.tool && lastFail.key === callKey && lastFail.errPrefix === errPrefix;
              const nonConsecutiveInRange = !consecutive &&
                recentFailKeys.indexOf(callKey) !== -1;
              if (lastFail && !lastFail.fired && consecutive) {
                lastFail.fired = true;
                state.transcript.push({ kind: 'system', text:
                  'REPEATED IDENTICAL FAILURE: this is the 2nd consecutive call of ' + turn.tool +
                  ' with substantially the same arguments failing the same way — resending the same input cannot change the outcome. ' +
                  'Change the SHAPE of the attempt per the error teaching (e.g. narrow the batch with maxContainers:1, split the range, shrink the timeout, or probe a single representative container first).' });
              } else if (nonConsecutiveInRange) {
                state.transcript.push({ kind: 'system', text:
                  'REPEATED IDENTICAL FAILURE: ' + turn.tool +
                  ' with these same arguments failed the same way again within the last 3 calls — resending the same input cannot change the outcome. ' +
                  'Change the SHAPE of the attempt per the error teaching (e.g. narrow the batch with maxContainers:1, split the range, shrink the timeout, or probe a single representative container first).' });
              }
              recentFailKeys.push(callKey);
              if (recentFailKeys.length > 3) recentFailKeys.shift();
              lastFail = consecutive ? lastFail : { tool: turn.tool, key: callKey, errPrefix: errPrefix, fired: !!nonConsecutiveInRange };
              // Seventieth log F2: same tool + same error class on 2
              // consecutive calls with DIFFERENT arguments. Fired only when
              // the exact-args nudge did not already cover this turn —
              // identical args get the (stronger) identical-failure text.
              const classConsecutive = lastClassFail && lastClassFail.tool === turn.tool &&
                errorClass && lastClassFail.errorClass === errorClass;
              if (classConsecutive && !consecutive && !nonConsecutiveInRange) {
                let teaching = '';
                if (/TIMEOUT/.test(errorClass)) {
                  teaching = ' For timeouts: narrow the batch (containerRange/maxContainers/maxWallMs).';
                } else if (/NOT_FOUND/.test(errorClass)) {
                  teaching = ' For NOT_FOUND: re-probe the selector against the real DOM before retrying.';
                } else {
                  teaching = ' Change the SHAPE of the attempt per the error teaching.';
                }
                state.transcript.push({ kind: 'system', text:
                  'REPEATED FAILURE CLASS: ' + turn.tool + ' failed with ' + (errorClass || 'UNKNOWN') +
                  ' twice in a row with different arguments — the ARGUMENTS are not the problem; the SHAPE is.' +
                  teaching });
              }
              lastClassFail = classConsecutive ? { tool: turn.tool, errorClass: errorClass, fired: true } : { tool: turn.tool, errorClass: errorClass, fired: false };
            } else {
              lastFail = null;
              lastClassFail = null;
            }
          } else {
            lastFail = null;
            lastClassFail = null;
            recentFailKeys.length = 0;
          }
          // Twenty-second log: slicing the FIRST 200 chars off the
          // transcript summary let a big-args label (service.update echoes
          // 1000+ chars of steps) eat the whole event — two ERRs were
          // undiagnosable in the exported console log. The event is its own
          // budgeted summary (label ≤ cap/4, result gets the rest), sized
          // to the console mirror's 600-char cut.
          const toolResultPayload = {
            tool: turn.tool,
            ok: !isErrorResult(result),
            summary: Protocol.summarizeToolResult(callLabel, result, eventSummaryCapChars),
            // Thirty-second log RC-B: full key-preserving rendering for the
            // console mirror — the one-liner above stays for the UI stream,
            // but the exported log must carry the evidence a diagnosis needs.
            detail: Protocol.compactToolResultForLLM(callLabel, result, eventDetailCapChars),
            // Eighty-seventh-round log-completeness audit: the console saw
            // only the model-facing COMPACT detail — the RAW result (with
            // every elided middle) never reached any log. The wizard
            // mirrors this in full as TOOL RESULT FULL.
            raw: result
          };
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

    // Seventieth log F3: exposed for direct unit tests of the accumulation
    // and the suffix formatting (driving the full engine loop is costly).
    const timingApi = {
      recordToolTiming: recordToolTiming,
      formatTimeBudgetSuffix: formatTimeBudgetSuffix,
      toolTimingEntries: () => Array.from(toolTimings.entries()).map(([t, d]) => Object.assign({ tool: t }, d))
    };
    const publicApi = {
      run: loop,
      timings: timingApi,
      abort: abort,
      pause: pause,
      parkBegin: parkBegin,
      parkEnd: parkEnd,
      state: () => JSON.parse(JSON.stringify(stateForPersist())),
      report: buildReport,
      // Sixty-seventh log: tool handlers (service.update endgame warning)
      // read live budget state through ctx.session — getters, not copies.
      get spend() { return state.spend; },
      get budgets() { return budgets; },
      get observationLog() { return observationLog; },
      get ledger() { return ledger; },
      // Seventy-first log F1: live wallClock consumption (elapsed state +
      // current segment, net of parked/llm waits) for verify.run economics.
      get elapsedMs() { return state.elapsedMs + netSegmentMs(); }
    };
    return publicApi;
  }

  // Seventy-first log F2: pure wallClock accounting — raw span MINUS llm/
  // provider waits MINUS parked (user) windows, clamped at 0. Exported so the
  // exclusion semantics are unit-testable without driving the engine loop.
  function computeEffectiveElapsed(nowMs, startMs, llmWaitMs, parkedMs) {
    return Math.max(0, nowMs - startMs - Math.max(0, Number(llmWaitMs) || 0) - Math.max(0, Number(parkedMs) || 0));
  }

  const api = { createResearchSession, computeEffectiveElapsed: computeEffectiveElapsed, makeInstructionStripper };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.ResearchSessionLib = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
