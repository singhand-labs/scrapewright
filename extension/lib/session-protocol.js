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
    '- Never guess a selector or attribute filter you have not observed this',
    '  session. Probe first (probe.count / probe.attrStats / probe.sample) or',
    '  ask the user (annotate.request). service.update rejects ungrounded',
    '  selectors — a wrong guess costs a full verify-and-repair cycle.',
    '- Prefer the cheapest probe that answers the current question.',
    '- Tool results are capped; never ask for raw pages.'
  ].join('\n');

  function renderToolCatalog(toolSpecs) {
    const specs = Array.isArray(toolSpecs) ? toolSpecs : [];
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
    if (Array.isArray(c.knowledgeIndex) && c.knowledgeIndex.length) {
      parts.push('## Knowledge index (pull bodies via knowledge.query {"ids":["<id>"]})\n' +
        c.knowledgeIndex.map(u => '- ' + u.id + ': ' + u.title).join('\n'));
    }
    if (Array.isArray(c.attachedUnits) && c.attachedUnits.length) {
      parts.push('## Knowledge (auto-attached, applies now)\n' +
        c.attachedUnits.map(u => '### ' + u.id + ' — ' + u.title + '\n' + u.body).join('\n\n'));
    }
    return parts.join('\n\n');
  }

  const api = { PROTOCOL_BLOCK, renderToolCatalog, buildSystemPrompt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.SessionProtocol = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
