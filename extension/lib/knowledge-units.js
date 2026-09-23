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
// FIELD_COLLISION, SCRIPT_TIMEOUT, CARD_POLICY, POLL_EXHAUSTED, SCHEMA_BLIND,
// AD_MARKER_SELECTOR, SELECTOR_OVERFILTERED, OUTPUT_FIELD_SIZE,
// PARTIAL_EMPTY_FIELDS, RELATIVE_TIMESTAMP, CLICK_CONTAINERS_TRANSIENT,
// REQUIRED_FIELD_EMPTY (67th log — the red gate's own tag), JUNK_VALUES,
// JUNK_DOMINATED, SCHEMA_STRAY_FIELD_DECLS, JUNK_SHAPE_RECORDS (74th log —
// the junk-shape subpopulation census).
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
      body: 'An attribute whose name carries a promotion token (ad, sponsored, promoted, commercial) exists to MARK promoted cards. Writing it as an include — div[card]:has(div[data-ad-...="message"]) — inverts the card policy and keeps ONLY promoted cards: the page holds a handful of ads, not the requested count, and the run "succeeds" returning ads whose permalink/timestamp fields are structurally empty. Correct uses: the negative form div[card]:not(:has([data-ad-...])), or filtering promotion attributes out in JS. When you need a positive organic marker, verify one first (probe.attrStats distribution, or a permalink/timestamp link you observed) — never an attribute that names itself as promotion markup. BEFORE blaming the selector, check WHERE the count was lost: the verify census carries the container-match count from the extraction diagnostics — if containers matched ≥ requested but posts came out short, the loss is in the ASSEMBLY (a dedupe on a weak/positional key collapsing distinct records), not the selector; if the cold verify tab matched fewer containers than the warm research tab, it is population divergence (settle or $collectUntil), not your selector.'
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
      body: 'When hovers fail with popover_timeout while anchors WERE found, the popover selector is the prime suspect. Failed entries carry observedPopover — the structural identity of what auto-discovery actually SAW mount. Rewrite the selector from THAT element (div[role="<observedPopover.role>"]); do not re-guess. Contrast the two failure shapes: observedPopover PRESENT means mounted-but-missed (fix the selector); ABSENT with no_hover_signal_early_exit means the anchor has no popover at all (change the anchor, keep the selector). A successful capture with autoDiscovered:true still means your popoverSelector matched nothing. A popover_timeout result also carries timeoutMs — the budget actually waited. Absence at a small budget (3000ms) is NOT evidence the popover never renders: slow or cold pages can mount it later, so retry once with a larger opts.timeoutMs (6000-9000) before concluding anything, and never renegotiate a contract on budget-bounded absence.'
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
      id: 'ad-marker-polarity',
      title: 'Ad-marker attributes name PAID units — build the extraction polarity accordingly',
      matchEvents: ['AD_MARKER_SELECTOR', 'SELECTOR_OVERFILTERED'],
      origin: '2026-09-04 eighteenth log survey; sponsored cards shipped as posts',
      body: 'An attribute or label whose own name says ad/sponsored (a data-ad-* attribute, a "Sponsored" label) marks PAID or promotional units. If the requirement EXCLUDES ads/recommendations, a container or content selector built ON an ad marker inverts the requirement — it selects exactly what should have been removed. The include form (:has(div[data-ad-…])) and the exclude form (:not(:has([data-ad-…]))) look similar inside one selector string; check which polarity you wrote against what the requirement asked for. The EXCLUDE form is not automatically safe either (twenty-fifth log): a data-* attr whose name looks promotional can be a DESIGN-SYSTEM attribute present inside every card — organic ones included — and then :not(:has([attr])) removes the whole population, matching zero containers forever while the base selector matches plenty. Verify EITHER polarity with a count differential (count the selector with vs without the clause; attrStats with the descendant form sel + " [attr]" shows which share of containers carries the marker inside) before shipping it. When ad-marked cards are the ONLY cards the page offers, that is thin content for the current input value: report it in the finish summary (and prefer a more common input value) instead of relabeling ad units as the requested records.'
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
    },
    {
      id: 'semantic-subelement-html',
      title: 'HTML-snippet output fields anchor to the semantic sub-element, never the whole card',
      matchEvents: ['OUTPUT_FIELD_SIZE'],
      origin: '2026-09-08 forty-first live log; whole-card htmlSnippet at 82396-99278 chars each',
      body: 'A field spec like {selector:"", attr:"outerHTML"} on the card container serializes the ENTIRE card DOM — class names, inline styles, SVG paths, nested reaction bars — tens of thousands of characters per record where the consumer wanted the one meaningful fragment. The read layer caps element-HTML at 50000 chars with a TRUNCATED disclosure suffix, but the right fix is upstream: point the field selector at the semantic sub-element (the text block, the link, the quoted region) so the snippet IS the payload. "Snippet" means a fragment. If the confirmed contract genuinely wants the full card DOM, keep it and accept the size — the verify census is report-only; otherwise tighten the anchor or renegotiate the contract with io.confirm.'
    },
    {
      id: 'hover-label-harvest',
      title: 'Label-anchor hovercards carry the field value in labelledbyText — harvest it, never filter it out of the assembly',
      matchEvents: ['PARTIAL_EMPTY_FIELDS'],
      origin: '2026-09-08 forty-second live log; postTime partial ("June 21") while the tooltip\'s full text was captured then discarded; forty-third log added the descendant fallback; forty-fourth log: cold-tab timing — $extractWithHover now re-reads empty labelledby fields after the hover batch',
      body: 'Compact fields (timestamps, icon labels, truncated text) often hold their FULL value only in the hidden-but-readable spans an aria-labelledby/aria-describedby reference points at, and the page mounts those spans lazily — sometimes only once the anchor has been hovered. The reference often sits on a DESCENDANT of the element you select (anchor a > span[aria-labelledby]): when the matched element carries neither reference attribute, every resolution path ($labelledby, fieldMap labelledby, probe.labelledby, the hover harvest) descends to the first descendant that carries one — own attributes always take precedence, and viaDescendant/note disclose the descent. Every hovercard entry now carries labelledbyText: the anchor\'s accessible label resolved AT DWELL TIME, in the same operation that triggered the mount (immune to later actions washing the page state away), present on FAILED entries too (a label needs no visible popover). When a field reads partial or empty from a direct labelledby/text read: (1) include the field\'s label anchors in the $extractWithHover anchorSel union, (2) take the value from the matching hovercard entry\'s labelledbyText, (3) do NOT discard label-anchor entries in the assembly — a timestamp anchor\'s href is often a junk query string, so classify entries by what they ARE (label anchor vs entity link), never by link shape alone. If the anchor\'s textContent is anti-scramble decoy (interleaved single-char spans, combining marks), stop scrubbing it — the clean value is in the reference chain, not the visible text. COLD-TAB TIMING (forty-fourth log): a labelledby field can read empty in the records yet resolve fine when probed later — the hover batch itself is what hydrates the reference chain on a cold tab, so fieldMap labelledby reads that ran BEFORE the hover saw an unmounted chain. $extractWithHover now re-reads labelledby fields whose value came back empty after the batch completes (non-empty values are never overwritten), so a fieldMap-only labelledby field resolves without hovercard assembly work. If a field is STILL empty after that: the harvest note (labelledbyNote on the hovercard entry) says WHY — absent attribute, stale/dynamic ids, or nothing anywhere in the subtree; read it before concluding the field is unverifiable. The diagnostics census runs after the batch, so it can show refResolved>0 for a field your records shipped empty in an OLDER run — trust emptyFieldDiagnostics from the same run only.'
    },
    {
      id: 'relative-timestamp-rebind',
      title: 'Relative ages in a time-like field: bounded absolute hunt, disclosed relative ship, or renegotiate — never empty-required grinding',
      matchEvents: ['RELATIVE_TIMESTAMP', 'TIME_SOURCE_UNEXERCISED', 'PARTIAL_EMPTY_FIELDS', 'EMPTY_FIELDS'],
      origin: '2026-09-09 forty-sixth log survey; seventy-sixth log restructured the exits — the model read "never ship relative" as the whole lesson, ground 36 snippets + 5 reds over a population proven relative-only, and shipped postTime 5/5 empty unverified; 2026-09-18 eighty-first log added the exercise-first gate (TIME_SOURCE_UNEXERCISED) after a session shipped visible-label values with probe.timestamp called 0 times',
      body: 'A time-like output field (name matching time/date/created/updated/published and CJK equivalents) that ships values such as "a day ago", "3 hours ago", "yesterday", "刚刚", "3天前" is carrying the site\'s RENDERED AGE LABEL, not the timestamp. Relative ages are computed at render time, drift with retrieval delay, sort wrongly, and cannot be compared across records — they are not a usable timestamp even though the field is non-empty and every green gate passes. When the verify RELATIVE_TIMESTAMP detector fires, FIRST: exercise the tooltip route (probe.timestamp once) — a partial/relative postTime with NO tooltip receipt will now be gated TIME_SOURCE_UNEXERCISED at verify (red when the field is REQUIRED); the disclosed-relative exit is only honest AFTER the tooltip route returned relative-only. Concretely: the FIRST MOVE is probe.timestamp({containerSel}) — ONE call hovers the time-ish anchors of one card and returns date-shaped candidates only (absolute preferred over relative); only if it comes back relative-only or empty, work the cost-ranked exit ladder: (1) BOUNDED absolute-source hunt — data layer first (a datetime attribute on the time element or its anchor, a data-* timestamp, or JSON embedded in the page carrying the absolute string), then reference layer (ARIA labelledby/describedby chains or hovercard popovers often expose the full absolute time the card renders in relative form — labelledby:true in the fieldMap, or $extractWithHover) — 1-2 probes, and STOP once probe.timestamp returns relative-only twice: the hunt is bounded, not a research program. (2) SHIP THE RELATIVE AGE WITH DISCLOSURE — the RELATIVE_TIMESTAMP detector is REPORT-ONLY: verify stays green, the finish disclosure names the field, and this is the LEGITIMATE honest ship when the site offers no absolute value ("silently" in the old warning meant undisclosed — a disclosed relative value beats an empty required field every time). (3) renegotiate to optional via io.confirm when the downstream use needs comparability — a relative age may be acceptable, but only the user can decide that (costs a parked user round); state what the site offers and let them choose. On a population PROVEN relative-only, an empty REQUIRED time field has NO other exit — no amount of identity-extraction rewriting conjures a year the page does not render. Month-day values WITHOUT a year ("August 2") are PARTIAL absolutes — mixed populations render recent items as relative ages and older ones as month-day; when the year/time matters, the hover tooltip carries the full date (read:\'hoverPopover\' + your own match, or $timestamp with a narrowed anchorSel). Never mask the detector by widening the schema type, and never ship relative ages as the contracted timestamp without disclosure — the finish disclosure will name the field.'
    },
    {
      id: 'markup-field-masquerade',
      title: 'A markup-named output field must carry captured DOM — text copied from a sibling field is a fabrication',
      matchEvents: ['HTML_FIELD_NO_MARKUP'],
      origin: '2026-09-09 forty-seventh live log; posts.htmlSnippet shipped content.slice(0,500) on a green verify (score 133)',
      body: 'Fields named html/markup/htmlSnippet are DOM-capture fields: their value comes from an element HTML read (outerHTML/innerHTML cap at 50000 chars with a TRUNCATED suffix) or from a hovercard entry htmlSnippet. A non-empty value containing zero "<" characters is not captured DOM — it is text copied from another field of the same record (the verify census names the copied-from sibling when a prefix match proves it) or invented outright. Copying a sibling satisfies every shape check and verifies green while carrying zero new information: the consumer asked for the DOM and got a duplicate column. When the HTML_FIELD_NO_MARKUP detector fires: (1) bind the field to a real DOM read — a fieldMap entry with attr "outerHTML"/"innerHTML" anchored at a semantic sub-element, or the captured hovercard markup — instead of assembling it from record text; (2) if the contract genuinely wants plain text there, rename the field (summary/excerpt/text) or renegotiate with io.confirm so the name stops promising markup. Nested record arrays are censused too — the same rule applies to per-card markup fields inside hoverCards[].'
    },
    {
      id: 'container-zero-corroboration',
      title: 'A zero-match click container corroborated later in the same run is mount timing — gate on readiness, do not rewrite the selector',
      matchEvents: ['CLICK_CONTAINERS_TRANSIENT'],
      origin: '2026-09-09 forty-eighth live log; the expand step clicked before the feed mounted while the same run\'s extract step matched the same container 4x, and CLICK_CONTAINERS_EMPTY vetoed a completed run',
      body: 'A $clickInList step whose container selector matches 0 does not always mean the selector is wrong: on mount-lazy feeds the click step can simply run before the content mounts. The verify corroboration check scans the SAME run\'s later steps — when a later container-scoped call ($extractList/$extractWithHover/etc.) matches the IDENTICAL container selector, the zero-match is reclassified as a mount-timing transient (CLICK_CONTAINERS_TRANSIENT, advisory) and the run is not vetoed. When the advisory fires: (1) do NOT touch the container selector — later steps prove it is right; (2) gate the clicking step on readiness instead: a count poll ($count(containerSel) + return {done:false} under maxIterations>1), or $wait on the container, so the click runs only after the list exists; (3) keep the click step\'s onFailure edge honest (skip-and-continue or terminate, per the requirement) rather than relying on the extract step to mask a no-op click. An UNcorroborated zero (no later step ever matches the selector) stays a red CLICK_CONTAINERS_EMPTY: that is a genuinely wrong selector, and the same-run corroboration is precisely the evidence that separates the two.'
    },
    {
      id: 'scroll-count-frozen',
      title: 'A feed count frozen at a nonzero value across scroll iterations is renderer gating or genuine exhaustion — read the evidence before rewriting the step',
      matchEvents: ['SCROLL_COUNT_FROZEN'],
      origin: '2026-09-09 forty-ninth live log; the verify count froze at 2 for 7 iterations, jumped to 8, froze for 10 more, and the scroll step was rewritten seven times with no visibility evidence. 2026-09-23 130th log: 25 scrollBy iterations ran in ~2s (avg ~70ms/attempt), froze at 2, and read as genuine exhaustion in the finish — the pacing field now names that case explicitly.',
      body: 'FIRST MOVE: replace the hand-rolled scroll loop with $collectUntil(containerSel, {targetCount, idAttr}) — the primitive counts UNIQUE items (virtualization remounts do not double-count), scrolls with the full throttle stack (activation, stall detection, trusted-wheel fallback, inner-container probing), and returns a CERTIFIED exhaustion verdict (exhaustion.certified + evidence) only when the scroll machinery itself stalled AND the unique count was unchanged for two consecutive rounds. When a scroll loop reports the same nonzero item count across a trailing streak of iterations, read the census entry\'s pacing field FIRST — it discriminates two causes that no other evidence can: (0) NO SETTLE — the entry says "paced N attempt(s) over Xms (avg Yms/attempt)" with Y under ~300ms (or carries the NO-settle marker): the loop ran back-to-back (a scrollBy resolves in tens of ms while lazy-load mounting needs ~1s), so the counter COULD NOT grow no matter the iteration budget. This is not exhaustion and not a selector problem — await a settle in the not-ready branch ($wait(sel, 1200) or a ~1000-1500ms sleep) before returning {done:false}, then re-run. frameSample cannot make this call: an active tab with normal frames and a stable count looks exactly like genuine exhaustion under this pacing. When a scroll loop reports the same nonzero item count across a trailing streak of iterations, the remaining branches: (1) RENDERER GATING — the page reports itself hidden or unfocused (pageState in the scroll diagnostics) and the rAF frame sample shows ~0 ticks, meaning the browser stopped producing frames for the tab and lazy-load callbacks cannot fire. Every scroll op now re-asserts tab activation AND window focus automatically, so re-run before concluding anything; if pageState stays gated check `scrapewright throttle on` (occluded-window launch flags). (2) GENUINE EXHAUSTION — frames flow, pacing shows a settled loop (avg ≥ ~300ms/attempt), and the count is simply all the feed had; accept the achieved count or renegotiate the contract with io.confirm. Do NOT rewrite the container selector or reshape the scroll step first: a frozen count says nothing about selectors (the same selectors matched N items fine). grewFrom in the census entry shows the count DID grow earlier in the run — growth that stops mid-run is the gating fingerprint, not a selector regression. (3) COLD-TAB DIVERGENCE — the research tab satisfied the count while a FRESH verify tab falls short: fresh tabs render fewer cards for narrow inputs before hydration. Prefer $collectUntil (its certified exhaustion separates real scarcity from a stalled loop), add a settle before counting, and if the cold tab is certified-exhausted while the warm tab satisfied N, accept the shortfall with that disclosure or renegotiate.'
    },
    {
      id: 'duplicate-id-fallback',
      title: 'The same id value across several records is a container-level fallback, not duplicate content',
      matchEvents: ['DUPLICATE_ID_VALUES'],
      origin: '2026-09-09 forty-ninth live log; three of eight records shipped the shared owner/page id as postId on a green verify while the per-record ids lived one attr up inside each card',
      body: 'An id-like field (postId, videoId, ...) whose value repeats across records almost never means the records are duplicates — it means the extractor read a value every record SHARES (the list owner id, the container permalink, an author-scoped story token) instead of a per-record identifier. The census names the duplicated value and the record ordinals. Re-probe one of the listed records and look one level deeper: per-record ids live on per-record elements — the record link href (the numeric id often sits right beside any base64 token), a data attr on the card — never on the shared container. Combine with the empty-ratio census: records with an EMPTY id and records with the SHARED id usually fail for the same reason (two link shapes, one selector). When the field is REQUIRED, verify vetoes the run on duplication (85th log); if the page legitimately repeats the record itself, dedup in the step or renegotiate via io.confirm.'
    },
    {
      id: 'position-like-id',
      title: 'An id field of small ascending integers is a position/index read, not an identity',
      matchEvents: ['POSITION_LIKE_ID'],
      origin: '2026-09-10 fifty-fifth live log; postId shipped as 3,4,5,6,7,9,10,11 — the extractor fell back to aria-posinset (position-in-set) when the permalink route came back empty, behind a green verify at score 183.98',
      body: 'Identity values are long opaque tokens everywhere (10+ digit numbers, slugs, hashes). An id-named field whose values are small ascending integers was read from a POSITION attribute — aria-posinset, a list index, a row number — which is the FEED slot, not the record identity: values shift as the feed reorders and say nothing about the record. Re-bind the field to the record permalink / link href (story_fbid, /posts/<id>, fbid= query param); when the page exposes no per-record identity link, say so and renegotiate the field away with io.confirm instead of shipping the position.'
    },
    {
      id: 'time-field-implausible',
      title: 'A time-named field whose values carry no date shape is a wrong-anchor bind',
      matchEvents: ['TIME_FIELD_IMPLAUSIBLE'],
      origin: '2026-09-10 fifty-second live log; postTime shipped as "m.meCatMachine Learning (ML) Explained | Types…" — the labelledby resolution of the WRONG anchor concatenating its referenced texts (redirect domains + page titles) — while relative/empty/junk censuses all passed it',
      body: 'A time-named field (postTime/createdAt/…time/date) whose non-empty values carry NO date/time shape (no month name, clock, time-unit word, ISO or CJK date) is almost always an ARIA labelledby/text read on the WRONG anchor: its referenced texts concatenate into redirect domains + page titles. The FIRST MOVE is probe.timestamp({containerSel}) — ONE call does the candidate→hover→labelledby harvest WITH date-shape filtering. Only if it returns nothing date-shaped, fix by SHAPE, not by trying more anchors blind: enumerate the timestamp-candidate anchors in one record (probe.extract with multi:true over a[href] labelledby candidates), keep only values matching a date SHAPE (month name / HH:MM / N-unit(-ago) / ISO / CJK date), bind the field to the surviving anchor, and re-verify. If NO candidate carries a date shape, the page does not expose the timestamp for this population — renegotiate via io.confirm instead of shipping titles as timestamps.'
    },
    {
      id: 'stagnant-disclosures',
      title: 'Three identical verify disclosures in a row means the loop is stuck — take an exit, do not re-verify',
      matchEvents: ['STAGNANT_DISCLOSURES'],
      origin: '2026-09-10 fifty-second live log; five consecutive verify.run calls carried the IDENTICAL partial-empty signature (location 5/5, hoverCards[].role 10/10, postTime relative) with zero research-tab probes between updates, and the session exhausted all 60 turns without moving a single field',
      body: 'When verify reports the SAME disclosure signature (same empty-field paths and counts, same junk fields) for the third consecutive run, re-verifying the same artifact shape will not move anything — the loop is stuck. Take exactly one exit: (a) go back to the RESEARCH tab (it is still open) and probe the NAMED records/fields — emptyRecordSamples tells you WHICH records, attrStats/labelledby tell you WHERE the value lives — then fix the selector/assembly from that evidence; (b) renegotiate the contract via io.confirm, dropping or adjusting fields the page genuinely lacks; (c) accept the current shape and disclose honestly in finish. A bare service.update → verify.run cycle with no probe in between is the signature of the stuck loop.'
    },
    {
      id: 'count-field-hidden-value',
      title: 'Empty count field with a populated sibling count — the value hides in an aria attribute or reference',
      matchEvents: ['COUNT_FIELD_HIDDEN_VALUE'],
      origin: '2026-09-09 fiftieth live log; likes read empty on every record and comments on 3/5 while shares extracted real values from the same action-bar family — the model shipped empty after two textContent probes',
      body: 'A count-named field (likes/comments/shares/replies/views/votes and *count/total names) reading empty on most records while a SIBLING count field extracts real values from the same record family is NOT an unextractable field: the family demonstrably renders counts, so the empty one\'s value typically lives outside textContent — in the element\'s aria-label ATTRIBUTE or in an aria-labelledby-referenced hidden span (the same mechanism timestamp anchors use). Route order: probe.attrStats {containerSel, attr:"aria-label"} over the element family to see attribute-shaped numbers; probe.labelledby on the empty field\'s element to resolve the hidden-span reference; then bind the extract field spec {attr:"aria-label"} or {labelledby:true}. Renegotiate the field away via io.confirm only after BOTH routes falsify — textContent emptiness proves nothing.'
    },
    {
      id: 'verify-red-snippet-first',
      title: 'A red verify is a data-shape mismatch — dry-run the fix with probe.snippet before the next service.update',
      matchEvents: ['REQUIRED_FIELD_EMPTY', 'PARTIAL_EMPTY_FIELDS', 'JUNK_VALUES', 'JUNK_DOMINATED', 'COUNT_SHORTFALL', 'TIME_FIELD_IMPLAUSIBLE', 'SCHEMA_STRAY_FIELD_DECLS'],
      origin: '2026-09-11 sixty-seventh live log; 8 blind service.update calls + 4 verify rounds burned all 60 turns while probe.snippet — the test-before-artifact tool — got ZERO uses; the postId regex was written against a digit-only hoped-for shape on non-numeric ids and stayed empty 2/2 through every rewrite, and the final turn wrote an artifact that could never be verified',
      body: 'A red verify means the artifact\'s extraction does not match the page\'s REAL data shapes. FIRST action: write the regex/binding against the DOSSIER CONTAINER SKELETON — the numbered skeleton view ([n1], [n1.2]) in the EVIDENCE DOSSIER block is the real rendered shape; a pattern written against an imagined shape is dead on arrival (probe.skeleton refreshes it for any selector, with model-directed cleaning opts). Then do not iterate blindly: (1) read the failing records\' source values from the verify report (resultPreview / emptyRecordSamples contexts) or diag.read; (2) DRY-RUN the corrected extraction with probe.snippet on the research tab — one snippet round against the real values replaces a blind service.update + verify.run pair that costs 2 turns and ~90s each cycle; (3) only when the snippet returns the expected shape, write it into service.update and verify once. Regexes and fieldMap selectors must be written against OBSERVED values — id-like fields are often non-numeric, labels carry prefixes, and anti-scrape text interleaves combining marks; the raw values, not your assumption of them, decide the pattern.'
    },
    {
      id: 'junk-shape-split',
      title: 'A junk-shaped record subpopulation is a population split — exclude it or split the contract, do not keep rewriting identity extraction',
      matchEvents: ['JUNK_SHAPE_RECORDS', 'REQUIRED_FIELD_EMPTY'],
      origin: '2026-09-15 seventy-fourth live log; AI-image-prompt junk cards (long prompt text as content, no postId/postTime) mixed with real posts, and the session burned to maxTurns rewriting identity extraction for values the junk cards structurally lack',
      body: 'When a subset of extracted records carries ONLY overlong text content while EVERY identity-ish required field (postId/postTime/permalink and friends) is empty, and the rest of the records populate normally, the container selector matched two different card shapes — typically machine-generated prompt/media cards interleaved with organic posts. The junk cards do not HIDE the identity values; they never carry them, so no selector rewrite, anchor change, or hover route will fill the fields. Two exits: (1) tighten the container selector so the junk shape stops matching (the census markers avgContentLen + identityFieldsAllEmpty fingerprint it — probe one junk record via sampleIndexes to find the excluding structural difference); (2) keep the wider selector and renegotiate with io.confirm — make the identity fields optional, or model the junk shape as its own optional subpopulation, and disclose it. Which exit fits is a REQUIREMENT question, not an extraction question.'
    },
    {
      id: 'obfuscated-class-skeleton-first',
      title: 'Class-obfuscated SPA pages: stop guessing [class*=...] substrings — anchor on the skeleton\'s structural facts',
      matchEvents: ['REQUIRED_FIELD_EMPTY', 'FIELD_MATCH_ZERO', 'EMPTY_EXTRACTION', 'SELECTOR_ZERO_MATCH', 'HOVER_NO_SIGNAL', 'PARTIAL_EMPTY_FIELDS', 'EMPTY_FIELDS'],
      origin: '2026-09-18 seventy-eighth live log; deep-thinking Q&A page with build-hash class names — the model made ~26 blind [class*=message]-style selector guesses (extractList census) while calling probe.skeleton exactly once, and the session died at maxTurns',
      body: 'On framework SPAs whose class names are build-hash gibberish or semantic-soup, STOP iterating class-substring selectors: each [class*=guess] round costs a turn and proves nothing — the next redeploy renames the hash and the guess dies with it. Call probe.skeleton({sel}) on the repeating container (or its stable ANCESTOR with a role/aria/id anchor) to get the NUMBERED structure — then bind fields to structural facts: role/aria-*/data-* attributes, heading/order relationships, and the node numbers from the dossier CONTAINER SKELETON. A selector anchored on [role=...]/[data-*]/tag-structure survives redeploys; [class*=guess] does not. If nothing structural exists at the container, ONE probe.skeleton of the page root (capChars 20000) shows what does exist to anchor on. Skeleton FIRST, selector SECOND — never the reverse on an obfuscated page.'
    },
    {
      id: 'no-evidence-no-conclusion',
      title: 'No conclusion without evidence — re-probe, ask the user, or renegotiate; never re-derive',
      matchEvents: ['FIELD_MATCH_ZERO', 'REQUIRED_FIELD_EMPTY', 'STAGNANT_DISCLOSURES', 'SELECTOR_ZERO_MATCH', 'HOVER_NO_SIGNAL'],
      origin: '2026-09-18 graduated-activation spec §3.B; the 78th log\'s 26 blind [class*=] guesses were only the latest instance — the principle needs a ROUTING moment (injected at the exact guessing instant), not more preaching in the system prompt',
      body: 'Before asserting that the page HAS or LACKS anything, the current context must hold matching evidence: a red-verify field → re-fetch THAT record\'s fragment (probe.sample / probe.skeleton against the DOSSIER node numbers); popover behavior → prove it with ONE probe.hover — and when you can see it render but the tool cannot, user.observe (the human sensor); counts/distributions → probe.count / probe.attrStats. RE-PROBE, do not RE-DERIVE: the SECOND time the same assertion appears without new evidence, STOP deriving and pick exactly one of three exits — (1) re-fetch the fragment with a probe tool, (2) user.observe, (3) io.confirm renegotiation of the contract — then execute it. Deriving from memory is how a session burns twenty turns rewriting a selector for a value that was never on the page.'
    }
  ];

  const api = { KNOWLEDGE_UNITS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.KnowledgeUnits = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
