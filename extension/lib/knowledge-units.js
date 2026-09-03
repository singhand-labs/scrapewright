// extension/lib/knowledge-units.js
//
// Global methodology library — seed migration (spec §3A). These units are
// the high-value core of the accumulated rule corpus (RC1-RC65 + seven log
// surveys), generalized to site-independent lessons. The index (id + title)
// rides the system prompt; bodies are pulled on demand via knowledge.query
// or auto-attached when a loop observation matches `matchEvents`.
//
// matchEvents vocabulary (kept small and stable — the engine emits these
// tags): COUNT_SHORTFALL, EMPTY_EXTRACTION, EMPTY_FIELDS, POPOVER_TIMEOUT,
// HOVER_NO_SIGNAL, COUNTER_FROZEN, DUPLICATE_RECORDS, SELECTOR_ZERO_MATCH,
// FIELD_COLLISION, SCRIPT_TIMEOUT, CARD_POLICY, POLL_EXHAUSTED, SCHEMA_BLIND.
//
// Write path: sessions PROPOSE units; the user approves; the universality
// guard test runs on every change to this file.
//
// IIFE-wrapped per RC30. Pure data module.

(function (global) {

  const KNOWLEDGE_UNITS = [
    {
      id: 'card-polarity',
      title: 'Promotion-named attributes are EXCLUDE signals, never :has() includes',
      matchEvents: ['COUNT_SHORTFALL', 'CARD_POLICY', 'EMPTY_FIELDS'],
      origin: '2026-09-01 seventh log survey; CARD-TYPE (a)/(f)',
      body: 'An attribute whose name carries a promotion token (ad, sponsored, promoted, commercial) exists to MARK promoted cards. Writing it as an include — div[card]:has(div[data-ad-...="message"]) — inverts the card policy and keeps ONLY promoted cards: the page holds a handful of ads, not the requested count, and the run "succeeds" returning ads whose permalink/timestamp fields are structurally empty. Correct uses: the negative form div[card]:not(:has([data-ad-...])), or filtering promotion attributes out in JS. When you need a positive organic marker, verify one first (probe.attrStats distribution, or a permalink/timestamp link you observed) — never an attribute that names itself as promotion markup.'
    },
    {
      id: 'card-type-heterogeneity',
      title: 'Feeds mix card types; empty-everywhere fields usually mean wrong card type kept',
      matchEvents: ['EMPTY_FIELDS', 'CARD_POLICY'],
      origin: 'CARD-TYPE HETEROGENEITY (a)-(e), 2026-08 era',
      body: 'When a required field is empty on every record, check WHAT KIND of cards your selectors kept before rewriting the field selector. Promoted/recommendation cards often lack permalink/timestamp fields entirely — the field is not hard to select, it does not exist on that card type. Decide ONE card policy per service and enforce it at exactly ONE place in the chain; the scroll counter must count with the SAME card signals the extraction uses.'
    },
    {
      id: 'attr-distribution-first',
      title: 'Probe attribute DISTRIBUTIONS before using any attribute as a filter',
      matchEvents: ['CARD_POLICY', 'SELECTOR_ZERO_MATCH'],
      origin: '2026-09-01 research-session design; generalization of seventh-log method',
      body: 'Before using a data-* attribute in a selector (include OR exclude), run attrStats on the container population. The distribution reveals semantics instantly: 8/100 cards carrying data-ad-rendering-role means promotion marker; 100/100 means structural scaffold; a value histogram with story_message/profile_name spells rendering roles. A single card sample can show you the attribute EXISTS but never what it MEANS — semantics live in the distribution.'
    },
    {
      id: 'popover-selector-from-evidence',
      title: 'Popover selectors: rewrite from observed evidence, never re-guess',
      matchEvents: ['POPOVER_TIMEOUT', 'HOVER_NO_SIGNAL'],
      origin: '2026-09-01 sixth log survey; observedPopover mechanism',
      body: 'When hovers fail with popover_timeout while anchors WERE found, the popover selector is the prime suspect. Failed entries carry observedPopover — the structural identity of what auto-discovery actually SAW mount. Rewrite the selector from THAT element (div[role="<observedPopover.role>"]); do not re-guess. Contrast the two failure shapes: observedPopover PRESENT means mounted-but-missed (fix the selector); ABSENT with no_hover_signal_early_exit means the anchor has no popover at all (change the anchor, keep the selector). A successful capture with autoDiscovered:true still means your popoverSelector matched nothing.'
    },
    {
      id: 'hover-anchor-scope',
      title: 'Hover anchors must be container-scoped and popover-bearing',
      matchEvents: ['HOVER_NO_SIGNAL', 'SELECTOR_ZERO_MATCH'],
      origin: '2026-08-23 third log survey; HOVER_ANCHORS_BLIND',
      body: 'A broad anchorSel matches links that never show popovers (avatars, permalinks, related links) and burns the whole hover budget on no-signal timeouts. Scope anchorSel INSIDE the card container, verify it matches >0 within containers before running the batch, and prefer the profile/name link that bears the hovercard. If an anchor class mixes popover-bearing and bare links, narrow by role or href shape you observed.'
    },
    {
      id: 'zero-trap-counter',
      title: 'Filtered counters can match nothing — verify the filter rises before looping',
      matchEvents: ['COUNTER_FROZEN', 'SCRIPT_TIMEOUT'],
      origin: '2026-08-31 fourth log survey; breaker + RAW-growth reset',
      body: 'A scroll loop that counts only cards matching a filter (e.g. permalink regex) can match 0 FOREVER if the filter is written from assumption — the count stays 0, the loop scrolls to maxIterations while the page fills with cards the script never counts. Defenses: sample and print what the filter actually matches before entering the loop; treat a counter that never once rose across consecutive not-ready iterations as a frozen counter and exit with a diagnostic (never keep scrolling); remember permalink shapes vary by locale and era — derive the regex from observed hrefs, not training data.'
    },
    {
      id: 'poll-exhaustion-differential',
      title: 'POLL_EXHAUSTED is a budget signal — read the iteration previews before touching selectors',
      matchEvents: ['POLL_EXHAUSTED'],
      origin: '2026-09-03 seventeenth log survey; SELECTOR_ZERO_MATCH mis-tag',
      body: 'A poll step exhausting its iterations means its readiness condition never became true — NOT that a selector matched zero. Before rewriting anything, read that step\'s iteration previews (diag.read counters, or the resultPreview trail) and branch on the count trajectory: counts that ROSE to a small number and stalled mean the page genuinely holds fewer matching items than the step demands — thin content; lower the per-run target, relax the count gate, or accept the shortfall instead of re-probing. Counts that NEVER rose from 0 across every iteration are the selector-or-filter case. Counts rising while a different readiness signal (url change, visibility flag) stays false point at the condition, not the selectors. Misreading thin content as a selector fault burns the remaining budget re-probing healthy selectors.'
    },
    {
      id: 'selector-coherence',
      title: 'One broken selector, every step that shares it',
      matchEvents: ['SELECTOR_ZERO_MATCH', 'EMPTY_EXTRACTION'],
      origin: '2026-08-23 second log survey; SELECTOR COHERENCE rule',
      body: 'When a fix changes a LIST CONTAINER or repeated-item selector, scan the FULL step workflow for every other step whose script contains the SAME selector string and fix it there too. A selector fixed in one step but left broken in later steps makes those steps silently match 0 containers (click steps no-op, extract steps return empty) and burns a future fix round on the same mistake.'
    },
    {
      id: 'empty-fields-honest-signals',
      title: 'Return empty fields, never filter records to nothing',
      matchEvents: ['EMPTY_EXTRACTION', 'EMPTY_FIELDS'],
      origin: 'RECORD FILTERING rule, bugx era',
      body: 'Do not write record filters that can collapse ALL records to [] (regex-testing outerHTML to drop "ads" matches every record because outerHTML contains every internal attribute; return-null-then-filter drops everything when one field selector misses). Return EVERY record with empty strings for missing data — empty strings are honest signals the framework can act on; a collapsed array hides the real failure behind a generic empty signal. If you must skip a record, require POSITIVE evidence from a SPECIFIC element.'
    },
    {
      id: 'count-metrics-aria-label',
      title: 'Like/comment/share counts usually live only in aria-label',
      matchEvents: ['EMPTY_FIELDS'],
      origin: 'COUNT METRICS rule, RC15 era',
      body: 'When a count-like field (likes, comments, shares, views) stays empty on every record while siblings extract fine, the count usually is not in any text node: action-bar controls render truncated or no visible text, and the full value exists only in an accessibility attribute (aria-label, title) on an element near the END of the record markup. Point the field at the attribute read and parse the number in JS; verify each count field reads a DIFFERENT element (like button vs comment button vs share button).'
    },
    {
      id: 'field-collision',
      title: 'Same-looking leaves collide — differentiate count fields by their control',
      matchEvents: ['FIELD_COLLISION', 'EMPTY_FIELDS'],
      origin: 'FIELD COLLISION ON GENERALIZATION rule, 2026-07 era',
      body: 'When generalizing a selector that worked on one record type to all records, two different fields often start matching the SAME first leaf (e.g. likeCount and commentCount both grabbing the first action button). Differentiate by the attribute wording you observed (aria-label substrings), by ordinal within a scoped parent, or by role — and verify the pair extracts DIFFERENT elements on the same record before shipping.'
    }
  ];

  const api = { KNOWLEDGE_UNITS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.KnowledgeUnits = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
