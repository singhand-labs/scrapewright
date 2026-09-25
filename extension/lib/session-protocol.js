// extension/lib/session-protocol.js
//
// Wire protocol between the ResearchSession engine and the LLM: a single
// JSON-object turn envelope. Text protocol, not native tool-calls, because
// the supported providers differ in tool-call support but all emit text;
// the lenient JSON parser (3-incident corpus) already hardens this repo
// against malformed JSON replies. Protocol violations get exactly ONE
// repair round in the engine, then the session stops (spec §4).
//
// Site-independent by construction. Pure module. IIFE-wrapped per RC30.

(function (global) {

  const PROTOCOL_BLOCK = [
    '## Turn protocol',
    '',
    'Reply with ONE JSON object and nothing else. Shape:',
    '',
    '{',
    '  "think": "one short paragraph: what you know, what you test next",',
    '  "goals": { "push": "new subgoal" } | { "complete": "g1" } | null,',
    '  "hypotheses": { "add": "falsifiable statement about this page" } | { "resolve": { "n": 1, "verdict": "confirmed" } } | null,',
    '  "tool": "tool.name",',
    '  "args": { }',
    '}',
    '',
    'To end the session replace tool/args with "finish": { "summary": "..." }.',
    'Rules:',
    '- Exactly one of "tool" or "finish" per turn; "args" defaults to {}.',
    '- finish is the TOP-LEVEL action {"finish":{"summary":"…"}} — NEVER a',
    '  tool name. There is no "finish" tool: finish is the protocol-level',
    '  end action, not something you dispatch.',
    '- "think" alone is not a turn: a reply that ends after think has no',
    '  action and will be rejected — commit the step your think leads to as',
    '  tool/args (or finish). Never end the reply inside your reasoning.',
    '- Never guess a selector or attribute filter you have not observed this',
    '  session. Probe first (probe.count / probe.attrStats / probe.sample) or',
    '  ask the user (annotate.request). service.update rejects ungrounded',
    '  selectors — a wrong guess costs a full verify-and-repair cycle.',
    '- Prefer the cheapest probe that answers the current question.',
    '- Tool results are capped; never ask for raw pages.',
    '- Keep "think" SHORT (a few sentences at most): draft schemas, selectors',
    '  and scripts inside the TOOL ARGS (io.confirm/service.update arguments),',
    '  never inside think — long replies are the ones providers truncate.'
  ].join('\n');

  function renderToolCatalog(toolSpecs) {
    const specs = Array.isArray(toolSpecs) ? toolSpecs.filter(s => s && typeof s === 'object' && s.name) : [];
    if (!specs.length) return '## Tools\n(none wired)';
    const lines = specs.map(s =>
      '- ' + s.name + '(' + String(s.args || '') + ') → ' + String(s.returns || '')
    );
    return '## Tools\n' + lines.join('\n');
  }

  function buildSystemPrompt(cfg) {
    const c = cfg || {};
    const parts = [];
    if (c.base) parts.push(String(c.base));
    parts.push(PROTOCOL_BLOCK);
    parts.push(renderToolCatalog(c.toolSpecs));
    // Element-level guards: these arrays flow from engine state / LLM-adjacent
    // paths; a null member must skip, never throw (boundary discipline).
    const idx = (Array.isArray(c.knowledgeIndex) ? c.knowledgeIndex : []).filter(u => u && typeof u === 'object' && u.id);
    if (idx.length) {
      parts.push('## Knowledge index (pull bodies via knowledge.query {"ids":["<id>"]})\n' +
        idx.map(u => '- ' + u.id + ': ' + String(u.title || '')).join('\n'));
    }
    const units = (Array.isArray(c.attachedUnits) ? c.attachedUnits : []).filter(u => u && typeof u === 'object' && u.id);
    // 118th round (efficiency): long sessions accumulated 12 auto-attached
    // full bodies (~20K chars) re-sent EVERY turn — the design intent was
    // index-resident with bodies pulled via knowledge.query. Render at most
    // the MAX_AUTO_ATTACHED most recently attached in full; the rest stay
    // one-line pointers.
    const MAX_AUTO_ATTACHED = 4;
    if (units.length) {
      const full = units.slice(-MAX_AUTO_ATTACHED);
      const fullIds = {};
      for (const u of full) fullIds[u.id] = 1;
      const lines = units.map(u => fullIds[u.id]
        ? '### ' + u.id + ' — ' + String(u.title || '') + '\n' + String(u.body || '')
        : '- ' + u.id + ': ' + String(u.title || '') + ' (body not auto-attached — pull via knowledge.query {"ids":["' + u.id + '"]} when it applies)');
      parts.push('## Knowledge (auto-attached, applies now)\n' + lines.join('\n\n'));
    }
    return parts.join('\n\n');
  }

  // First JSON-object candidate in the reply: fenced block, else a
  // quote-aware balanced-brace scan. Best-effort extraction — the parse
  // step decides validity.
  function extractJsonObject(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence && fence[1].trim()) return fence[1].trim();
    const start = t.indexOf('{');
    if (start === -1) return null;
    let depth = 0, quote = null;
    for (let i = start; i < t.length; i++) {
      const ch = t[i];
      if (quote) {
        if (ch === '\\') { i++; continue; }
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return t.slice(start, i + 1);
      }
    }
    // Unbalanced to EOF: the reply was cut off before the closing braces
    // (glm tail degradation reports finish_reason "stop") or a stray quote
    // swallowed them. Hand the tail-inclusive text to the PARSE stage
    // instead of failing blind — its truncation discipline decides
    // (recoverable quote shapes recover; true truncation fails loudly with
    // a position error). Fifth-live-log turn 21: detail-less no-json here
    // hid the only evidence for both dying replies.
    return t.slice(start);
  }

  // Quote-aware balance check — the explicit truncation signal. V8's parse
  // error text varies with WHERE the cut landed ("Unterminated string" vs
  // "Unexpected end" vs "Expected ',' or '}'"), so the cut-off class is
  // stated directly instead of inferred from message text.
  // 146th log: string-aware JSON structure scan — the salvage below always
  // had this; the cut-off MARKER used the naive brace count instead, and a
  // truncated reply whose step scripts contain balanced internal braces
  // ({done:false, posts:out}) offset the missing final closer exactly: the
  // marker read "balanced", the continuation gate stayed closed, and the
  // session died to a protocol stop on a reply missing ONE character.
  function scanJsonStructure(src) {
    let quote = null;
    let escape = false;
    const stack = [];
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (quote) {
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"') { quote = ch; continue; }
      if (ch === '{' || ch === '[') stack.push(ch);
      else if (ch === '}' || ch === ']') stack.pop();
    }
    return { quote: quote, stack: stack };
  }

  function bracesBalanced(text) {
    let depth = 0, quote = null;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === '\\') { i++; continue; }
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
    return depth === 0 && !quote;
  }

  function lenientParse(candidate) {    try { return JSON.parse(candidate); } catch (e) { /* fall through */ }
    // Reuse the corpus-hardened lenient parser (3 real incidents) when it is
    // reachable: node require, else the wizard page global set by wizard-utils.
    let parser = null;
    if (typeof require !== 'undefined') {
      try { parser = require('./wizard-utils').parseJsonLenient; } catch (e) { parser = null; }
    }
    if (!parser && typeof global !== 'undefined' && typeof global.parseJsonLenient === 'function') {
      parser = global.parseJsonLenient;
    }
    if (parser) {
      try {
        const out = parser(candidate);
        // wizard-utils parseJsonLenient returns {ok, value, repairs}. Its
        // FAILURE shape has no 'value' key — returning the wrapper then would
        // leak a {ok:false,...} object into parseAssistantTurn as if it were
        // the parsed turn (misclassifies as missing-action; third-live-log
        // root cause). Only a successful unwrap or a legacy raw value
        // returns; a FAILURE falls through to the close-braces salvage
        // (fifty-fourth log) instead of returning early.
        if (out && typeof out === 'object' && !Array.isArray(out) && 'ok' in out) {
          if (out.ok && out.value !== undefined) return out.value;
        } else if (out !== undefined) {
          return out;
        }
      } catch (e) { /* fall through to the salvage */ }
    }
    // Fifty-fourth log: glm-5.3-flash cuts LONG completions mid-JSON while
    // reporting finish_reason:"stop" (max_tokens nowhere near reached). The
    // shorter-resend + continuation chain recovered most of them but a
    // cascade still killed a session. Deterministic last stage: CLOSE the
    // dangling quotes/braces and re-parse — a cut inside the action
    // recovers the turn outright, a cut inside think degrades to think-only
    // (the fifty-third-log two-round action repair), and garbage stays
    // unparseable. Quote/escape-aware; a trailing dangling escape is
    // dropped before closing so it cannot corrupt the last token.
    if (typeof candidate === 'string' && candidate.trim().startsWith('{')) {
      let src = candidate;
      const scan = scanJsonStructure(src);
      const quote = scan.quote;
      const stack = scan.stack;
      if (quote || stack.length) {
        if (quote && src.endsWith('\\')) src = src.slice(0, -1); // drop the dangling backslash
        // 146th log: a completion is CLOSER-ONLY when no string is open at
        // EOF — the appended suffix is purely closing brackets, so the
        // salvaged object contains EVERY character of content the model
        // sent (nothing silently truncated). This is the provider-cut-the-
        // final-brace class (finish_reason lies "stop" at ~2.5K); the
        // lossless salvage is strictly better than the continuation round
        // (no LLM cost, no repeat-drift). A cut INSIDE a string stays
        // lossy and keeps the loud path below.
        const closerOnly = !quote && stack.length > 0;
        let closed = src + (quote ? quote : '');
        while (stack.length) closed += (stack.pop() === '{' ? '}' : ']');
        try {
          const salvaged = JSON.parse(closed);
          // A cut inside a PAYLOAD tool's arguments would silently truncate
          // the artifact/contract — the eighteenth-log continuation round
          // exists precisely to recover the full payload, so reject the
          // salvage there and keep the loud cut-off path. Think-only and
          // cheap-probe recoveries are safe (a truncated probe arg shows up
          // in the very next tool result). EXCEPTION (146th): the
          // closer-only completion is lossless — allow it for payload tools.
          if (!closerOnly && salvaged && typeof salvaged === 'object' && !Array.isArray(salvaged) &&
              (salvaged.tool === 'service.update' || salvaged.tool === 'io.confirm')) {
            return undefined;
          }
          return salvaged;
        } catch (e) { return undefined; }
      }
    }
    return undefined;
  }

  function normalizeGoalUpdates(g) {
    if (!g || typeof g !== 'object') return null;
    if (typeof g.push === 'string' && g.push.trim()) return { push: g.push.trim() };
    if (typeof g.complete === 'string' && g.complete.trim()) return { complete: g.complete.trim() };
    return null;
  }

  function normalizeHypothesisUpdates(h) {
    if (!h || typeof h !== 'object') return null;
    if (typeof h.add === 'string' && h.add.trim()) return { add: h.add.trim() };
    const r = h.resolve;
    if (r && typeof r === 'object' && typeof r.n === 'number' && typeof r.verdict === 'string') {
      return { resolve: { n: r.n, verdict: r.verdict.trim() } };
    }
    return null;
  }

  function parseAssistantTurn(text) {
    const candidate = extractJsonObject(text);
    if (!candidate) {
      // Fifth-live-log: no-json carried detail:null, so a dying reply left
      // NOTHING diagnosable in the console. Ship the head excerpt — the
      // class ("no { at all" vs "empty") is visible at a glance.
      const head = String(text || '').trim().slice(0, 120);
      return { ok: false, violation: 'no-json', detail: head ? 'reply contains no { — first 120 chars: ' + head : 'empty reply' };
    }
    let obj;
    let parseErr = null;
    try { obj = JSON.parse(candidate); } catch (e) {
      parseErr = e && e.message ? String(e.message) : 'unparseable';
      // 120th log: the model wrote a LEADING BARE TOKEN —
      // {"finish","tool":"finish",…} — the tool name once without a colon,
      // then the proper object. A green-verified session died at the very
      // finish line to this typo (three identical replies, protocol rounds
      // exhausted). Deterministic repair: strip the bare token and re-parse;
      // any tool name, disclosed via the repair note.
      const m = candidate.match(/^\{\s*"([\w.$-]+)"\s*,(?=\s*")/);
      if (m) {
        const stripped = '{' + candidate.slice(m[0].length);
        try {
          obj = JSON.parse(stripped);
          parseErr = null;
          try { console.warn('[session-protocol] repaired leading bare token "' + m[1] + '" in assistant reply'); } catch (e0) {}
        } catch (e2) { obj = lenientParse(candidate); }
      } else {
        obj = lenientParse(candidate);
      }
    }
    if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
      // The tail rides along because console previews cut at 300 chars —
      // truncation kills the reply exactly where the preview cannot see
      // (fifth-live-log turn 21: two replies, 554/470 chars, tail unknown).
      const tail = JSON.stringify(candidate.slice(-100));
      // 146th log: string-aware completeness — the naive count let
      // string-internal braces hide a genuinely unclosed structure.
      const st146 = scanJsonStructure(candidate);
      const cut = (st146.quote || st146.stack.length) ? ' | cut-off: braces never closed (reply truncated)' : '';
      const detail = ((parseErr ? String(parseErr).slice(0, 140) : 'parsed to null') + cut + ' | tail: ' + tail).slice(0, 300);
      return { ok: false, violation: 'not-object', detail: detail };
    }
    // Seventy-second log (session-2): the model put finish in the TOOL slot
    // ({"tool":"finish","args":{"summary":…}}) — the available-tools list
    // rightly omits finish, so dispatchTool replied "unknown tool: finish"
    // and the resend round nearly died in a provider outage with a
    // verified-green artifact aboard. finish is a protocol action, never a
    // dispatched tool: coerce the shape here (the coercion IS the recovery —
    // no extra LLM round) and flag it so the engine can log a teaching note.
    let coercedFinish = false;
    if (obj.tool === 'finish' && !obj.finish) {
      // Eighty-ninth log: the flat variant {"tool":"finish","summary":"…"}
      // (top-level sibling, NO args) also occurs — harvest it; args (the
      // richer shape) wins when both are present.
      let src = null;
      if (obj.args && typeof obj.args === 'object' && !Array.isArray(obj.args)) {
        src = obj.args;
        // 120th log: {"tool":"finish","args":{},"summary":"…"} — args is an
        // EMPTY object while the summary rides at top level; harvest it so
        // the coerced finish keeps the ship summary.
        if (!(typeof src.summary === 'string' && src.summary) && typeof obj.summary === 'string' && obj.summary) {
          src = { summary: obj.summary };
        }
      } else {
        const s = (typeof obj.args === 'string' && obj.args) ? obj.args
          : (typeof obj.summary === 'string' ? obj.summary : '');
        src = { summary: s };
      }
      obj.finish = src;
      delete obj.tool;
      delete obj.args;
      delete obj.summary;
      coercedFinish = true;
    }
    if (obj.args !== undefined && (typeof obj.args !== 'object' || obj.args === null || Array.isArray(obj.args))) {
      return { ok: false, violation: 'bad-args' };
    }
    const turn = {
      think: typeof obj.think === 'string' ? obj.think : '',
      goalUpdates: normalizeGoalUpdates(obj.goals),
      hypothesisUpdates: normalizeHypothesisUpdates(obj.hypotheses),
      tool: typeof obj.tool === 'string' && obj.tool.trim() ? obj.tool.trim() : null,
      args: (obj.args && typeof obj.args === 'object' && !Array.isArray(obj.args)) ? obj.args : {},
      // Fifteenth log: tolerate a bare-string finish — the lenient parser's
      // repair-finish-double-colon pass rewrites {"finish":"summary":"…"} (an
      // invalid double colon) into the string form.
      finish: (obj.finish && typeof obj.finish === 'object' && !Array.isArray(obj.finish)) ? obj.finish
        : (typeof obj.finish === 'string' && obj.finish.trim() ? { summary: obj.finish } : null)
    };
    if (turn.tool && turn.finish) return { ok: false, violation: 'ambiguous-action' };
    if (!turn.tool && !turn.finish) {
      return { ok: false, violation: 'missing-action', detail: 'reply had keys: ' + Object.keys(obj).slice(0, 12).join(', ').slice(0, 140) };
    }
    if (turn.tool && !/^[a-z][\w]*(\.[\w]+)*$/i.test(turn.tool)) return { ok: false, violation: 'bad-tool-name' };
    if (turn.finish && typeof turn.finish.summary !== 'string') turn.finish.summary = '';
    if (coercedFinish) turn.coercedFinish = true;
    return { ok: true, turn: turn };
  }

  // Thirty-second log root fix (RC-A): summarizeToolResult's flat head-only
  // slice is right for the 600-char UI one-liner, but as the LLM transcript's
  // ONLY rendering of a tool result it destroyed everything past byte ~4000 —
  // verify-report tail keys (detectors.partialEmptyFields,
  // emptyFieldDiagnostics, steps[].resultPreview, finalResult) never reached
  // the model, and one long error string ate the whole head budget
  // (29th-log timeMapSize class). Structure-aware compaction instead:
  //   - every object KEY name survives (values elide, names never vanish);
  //   - long strings keep head AND tail with a disclosed [+N chars elided];
  //   - arrays keep their first items and disclose the elided remainder;
  //   - the label is capped tight — the model authored the args one message
  //     earlier, so echoing them at length only burns the result's budget.
  const COMPACT_LABEL_CAP = 160;

  function compactStringForLLM(s, budget) {
    if (s.length <= budget) return JSON.stringify(s);
    const marker = 26;
    const keep = Math.max(20, budget - marker);
    const head = Math.ceil(keep * 0.6);
    const tail = keep - head;
    const elided = s.length - head - tail;
    return JSON.stringify(s.slice(0, head)) + '…[+' + elided + ' chars elided]…' + JSON.stringify(s.slice(s.length - tail));
  }

  function compactArrayForLLM(arr, budget) {
    const parts = [];
    let left = budget - 2; // brackets
    for (let i = 0; i < arr.length; i++) {
      const remaining = arr.length - i;
      const share = Math.max(40, Math.floor(left / remaining));
      let rendered;
      try { rendered = compactValueForLLM(arr[i], share); } catch (e) { rendered = compactStringForLLM(String(arr[i]), share); }
      const cost = rendered.length + 1; // comma
      if (i > 0 && (left - cost < 40 || rendered.length > share + 40)) {
        parts.push('…[+' + remaining + ' more items elided]');
        break;
      }
      if (i === 0 && rendered.length > share + 40) {
        // Even the first element had to shrink — still keep it: the array's
        // element SHAPE must stay visible or the model cannot read the list.
        parts.push(rendered);
        left -= cost;
        continue;
      }
      if (left - cost < 40 && i > 0) {
        parts.push('…[+' + remaining + ' more items elided]');
        break;
      }
      parts.push(rendered);
      left -= cost;
    }
    return '[' + parts.join(',') + ']';
  }

  // 89th-round T3: decision keys render FIRST under budget pressure — the
  // uniform insertion-order shares let prose (scoreNote/shapeDistribution)
  // consume budget while the rows the model acts on (error/detectors/
  // finalResult/steps) collapsed into "[+N keys elided]" stubs.
  const PRIORITY_KEYS = ['error', 'ok', 'detectors', 'finalResult', 'steps', 'schemaOk', 'score', 'events'];

  function compactObjectForLLM(obj, budget) {
    // stable partition: priority keys first (in PRIORITY_KEYS order), then
    // the remaining keys in their original insertion order — objects whose
    // keys all fit render EXACTLY as before (byte-stable).
    const allKeys = Object.keys(obj);
    const prio = [];
    for (const pk of PRIORITY_KEYS) {
      const i = allKeys.indexOf(pk);
      if (i !== -1) { prio.push(pk); allKeys.splice(i, 1); }
    }
    const keys = prio.concat(allKeys);
    const parts = [];
    let left = budget - 2; // braces
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const remaining = keys.length - i;
      const nameCost = JSON.stringify(key).length + 3; // "key":
      // Names must survive even when values cannot: list the remaining keys
      // as elided stubs and stop.
      if (left - nameCost < 12) {
        const restNames = keys.slice(i).map((k) => k).join(',');
        const stub = '"…[+' + remaining + ' keys elided: ' + compactStringForLLM(restNames, 240) + ']';
        parts.push(stub);
        break;
      }
      const share = Math.max(40, Math.floor((left - nameCost) / remaining));
      let rendered;
      try { rendered = compactValueForLLM(obj[key], share); } catch (e) { rendered = compactStringForLLM(String(obj[key]), share); }
      parts.push(JSON.stringify(key) + ':' + rendered);
      left -= nameCost + rendered.length;
    }
    return '{' + parts.join(',') + '}';
  }

  function compactValueForLLM(v, budget) {
    if (budget <= 24) return '"…"';
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'string') return compactStringForLLM(v, budget);
    let s;
    try { s = JSON.stringify(v); } catch (e) { s = null; }
    if (s == null) return compactStringForLLM(String(v), budget);
    if (s.length <= budget) return s;
    if (Array.isArray(v)) return compactArrayForLLM(v, budget);
    if (typeof v === 'object') return compactObjectForLLM(v, budget);
    return compactStringForLLM(String(v), budget);
  }

  function compactToolResultForLLM(name, result, cap) {
    const c = typeof cap === 'number' && cap > 0 ? cap : 2000;
    const label = name.length > COMPACT_LABEL_CAP ? name.slice(0, COMPACT_LABEL_CAP) + '…' : name;
    const budget = c - (label.length + 4);
    let body;
    try { body = compactValueForLLM(result, budget); } catch (e) { body = compactStringForLLM(String(result), budget); }
    return label + ' → ' + body;
  }

  function summarizeToolResult(name, result, cap) {
    const c = typeof cap === 'number' && cap > 0 ? cap : 200;
    let s;
    try { s = JSON.stringify(result); } catch (e) { s = String(result); }
    if (typeof s !== 'string') s = String(s);
    s = s.replace(/\s+/g, ' ');
    // Twenty-first log: the label (tool + args echo) must never eat the
    // budget the result needs — service.update carries 1000+ char args, and
    // the args-first rendering pushed every error out of the 200-char event
    // summary (ERR tool results were undiagnosable in exported logs). Cap
    // the label at a quarter of the budget; the result gets the rest.
    const labelCap = Math.max(20, Math.floor(c / 4));
    const label = name.length > labelCap ? name.slice(0, labelCap) + '…' : name;
    const room = c - (label.length + 4);
    return label + ' → ' + (s.length > room ? s.slice(0, Math.max(0, room)) + '…[truncated]' : s);
  }

  const api = { PROTOCOL_BLOCK, renderToolCatalog, buildSystemPrompt, extractJsonObject, parseAssistantTurn, summarizeToolResult, compactToolResultForLLM, compactObjectForLLM };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.SessionProtocol = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
