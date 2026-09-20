// Globals: this module relies on two free variables defined by sibling modules
// loaded as globals (browser pattern, mirrored in Node tests via require order):
//   - deriveListPattern (from lib/list-pattern.js)
//   - clusterAnnotationsByContainer (from lib/annotation-cluster.js)
// annotation-cluster.js defines clusterAnnotationsByContainer, used by
// buildAnnotationsText. Loaded as a global (browser pattern); the typeof
// guard inside buildAnnotationsText handles the legacy/non-loaded case.

const SCRIPT_DSL_GUIDE = `You are writing JavaScript code for Scrapewright, a web scraping agent.

CRITICAL RULES:
1. Your code runs inside a sandboxed iframe (isolated from the target page). You CANNOT use document.querySelector, document.querySelectorAll, or any direct DOM access.
2. The ONLY way to interact with the target page is through the following async API functions:
3. $() and $list() return PLAIN DATA OBJECTS { tagName, textContent, ... }, NOT DOM Elements. You CANNOT call .closest(), .parentElement, .children, .querySelector(), .getElementsByClassName(), or any DOM method on them. Only the listed properties (tagName, id, className, textContent, value, href, src, checked, disabled) are available. To find a parent or related element, use a different CSS selector.
4. NEVER NAVIGATE. Do NOT assign window.location.href, window.location, location.href, and do NOT call location.replace() / location.assign(). Your script runs inside a SANDBOXED IFRAME — these "navigate" the SANDBOX (not the target tab), which destroys the sandbox and silently breaks every subsequent operation. The target page URL is set by the service config (with {{placeholders}} resolved before page load). Your script only does post-load operations (scroll, extract, click, etc.). The runner detects and refuses navigation attempts with FORBIDDEN_NAVIGATION.

AVAILABLE API FUNCTIONS:
- $(selector): Wait up to 30s for element to appear, return { tagName, id, className, textContent, value, href, src, checked, disabled }. THROWS if element is not found within 30s. IMPORTANT: This returns a plain data object, NOT a DOM Element — no .closest(), .parentElement, or any DOM methods.
- $exists(selector, timeoutMs?): Check if a VISIBLE element exists (skips display:none / visibility:hidden / zero-size elements). Returns true immediately if found, false if not found within timeoutMs (default 5000ms). Pass timeoutMs=0 for a single immediate query with no waiting. Use this for polling loops instead of $().
- $click(selector, timeoutMs?): Find element, wait for it up to timeoutMs (default 10000ms), click it. Returns true.
- $type(selector, text, timeoutMs?): Find element, wait for it up to timeoutMs (default 10000ms), set value, dispatch input/change events. Works on INPUT, TEXTAREA, and contenteditable elements. If selector matches a container, searches inside for an inputtable child. Returns true.
- $extract(selector, attribute?, timeoutMs?): Get textContent (or attribute if specified). Returns string. IMPORTANT: $extract waits only up to timeoutMs (default 5000ms, NOT 30s) for the element — if the selector is wrong it fails fast instead of burning the step's whole timeout. Prefer this over $() for reading known content; pass a longer timeoutMs only when you genuinely need to wait for content to render.
- $labelledby(selector, attr?, timeoutMs?): Resolve an ARIA REFERENCE attribute on the first match (default 'aria-labelledby'; pass 'aria-describedby' for the description refs) and return the resolved object {text, attr, refCount, missingIds?, note?, viaDescendant?} — the attribute holds a whitespace-separated id list, each id is looked up in the document; .text carries the CONCATENATED text of the referenced element(s) — postTime = (await $labelledby(sel)).text. When the matched element carries NEITHER reference attribute, resolution DESCENDS to its first descendant that carries one (disclosed as viaDescendant + note; own attributes always win) — pages routinely hang the value on a child span of the anchor you select. probe.labelledby returns this SAME object shape. Empty paths keep the object shape and carry their falsification reason in .note ('' text when the attr is absent, ids unresolvable, or refs carry no text); resolution RETRIES until non-empty within the same timeoutMs (cold-mounted cards hydrate their reference chains lazily — an empty read within budget waits; the note tells you when hydration never came). This is where tooltip/hovercard full values usually live: the referenced span is often HIDDEN but readable (reads are not visibility-gated), so when a hover popover never visibly renders, bind the field with $labelledby on the anchor instead of re-hovering.
- $timestamp(containerSel, {anchorSel?, timeoutMs?, index?}): ONE call returns the card's timestamp value — {value, absolute, absoluteSource, relative, candidates[], anchorsProbed, hoversDispatched, note?}. It enumerates the card's time-ish anchors (default union; narrow with anchorSel), reads EACH anchor's labelledby + aria-label + VISIBLE TEXT (the source that survives cold mount — labelledby reference chains often do not resolve on freshly-opened tabs), and hovers up to the first 3 anchors (default timeoutMs 4500 — tooltips mount in 600-1600ms; do NOT narrow the dwell below that, the capture window closes before the popover appears) reading the captured popover's own text. Candidates are date-shape filtered (a string that merely MENTIONS a duration is prose, not a date), ABSOLUTE preferred over a relative age; heuristicValue（日历通用正则的便捷默认——识别职责在你：优先读 candidates[] 原文自行判断；value 为旧名别名）is the pick, '' when nothing date-shaped exists. postTime = (await $timestamp(cardSel)).value — do NOT hand-roll the labelledby/text/popover candidate dance with custom filters and regex lists in step JS: eight artifact versions of that dance shipped junk from media anchors, dropped the hovered popover's capture on arrival, and never survived a cold verify tab.
- $wait(selector, delayMs?): Wait for element (up to 30s via MutationObserver), then optional extra delay. Returns true. The selector is REQUIRED. If you only need a delay without waiting for an element, use 'await new Promise(r => setTimeout(r, ms))' instead. THROWS ELEMENT_NOT_FOUND if the selector never appears within the cap — never $wait on a selector whose ABSENCE is your poll condition (content still loading); $count it and return { done: false } so maxIterations drives the wait.
- $check(selector, property): Read element property (e.g., 'checked', 'disabled'). Returns value.
- $openTab(url, functionBody): Open new tab at the given URL, wait for page load, then execute the function body (a string of JavaScript statements) in the new tab context. Returns whatever the function body returns. Use to scrape detail pages. Example: await $openTab(href, \`const title = await $extract('h1'); return { title };\`)
- $count(selector): Count elements matching selector (main document + same-origin iframes). Returns number. Do NOT use with :nth-child() to iterate — use $list() instead.
- $list(selector): Get ALL matching elements across main document + same-origin iframes. Returns array of { tagName, id, className, textContent, value, href, src, checked, disabled }. Use this for iterating multiple elements. Same data-object limitation as $().
- $extractList(containerSel, fieldMap, opts?): Extract a list of records in ONE call. fieldMap is { subField: subSelector | { selector, attr?, labelledby? } }; labelledby:true (or an attr name like aria-describedby) resolves the ARIA reference on each match and returns the referenced elements' concatenated text — the read for anti-scrambled pages where the visible textContent is decoy junk (the clean value lives in the hidden elements the reference points at; same resolution as $labelledby, INCLUDING its descendant fallback: when the matched element carries no reference attribute, resolution descends to the first descendant that carries one, so the sub-selector may point at the ANCHOR while a child span holds the aria-labelledby). each sub-selector is evaluated INSIDE each container element and returns the FIRST match per container. Returns an array of objects in container order. Prefers this over $list-per-field for multi-field lists (avoids field-misalignment when fields are missing on some items). Throws 'empty list' if no container matches; set opts.allowEmpty=true to return [] instead.
- $extractListMulti(containerSel, fieldMap, opts?): Like $extractList, but EACH FIELD VALUE IS AN ARRAY of ALL matches per container (in document order, as textContent/attr strings — NOT element objects), regardless of the field name. Use $extractList (single-value) by default; reach for $extractListMulti ONLY when CSS alone cannot disambiguate which match is the right one — e.g. a[role="link"] inside a post matches BOTH the author link (1st) AND the timestamp link (2nd). With $extractList you'd get only the author; with $extractListMulti you get both and can pick in JS by text/attribute regex. attr may be 'outerHTML' or 'innerHTML' to read raw HTML.
  CRITICAL — every field value is Array<string|null>. Calling .trim(), .match(), .includes(), .replace() etc. DIRECTLY on a field value crashes with "X.trim is not a function" (Array has no such method). Always index into the array first, even when the field name is singular (author, content, timestamp):
  // WRONG — r.author is an array; (r.author || '') short-circuits to the array (truthy), then .trim() crashes:
  const author = (r.author || '').trim();
  // RIGHT — index [0] for first match, or .map/.filter/.find/.join for multi:
  const author = (r.author[0] || '').trim();
  const allAuthors = (r.author || []).filter(Boolean).join(' ');
  // If you only need the first match for every field, use $extractList (not Multi) — fields are then plain strings.
  const records = await $extractListMulti('li.result-item', { links: 'a.action-link[data-act]' }, { allowEmpty: true });
  const items = records.map(r => {
    const time = r.links.find(t => /^\\d{1,2}:\\d{2}|^\\d+\\s+(?:hours?|days?)\\s+ago$|^yesterday$/i.test(t)) || '';
    const author = r.links[0] || '';
    return { author, timestamp: time };
  });
- $clickInList(containerSel, subSel, opts?): Click subSel INSIDE each container element. Default opts.delayMs=500 (waits between clicks for expand/animations to settle). Returns { clicked: N, errors: [...] }. Use for "click 展开 in every post before extracting full content" — see EXPAND PATTERN below.
- $waitForStable(selector, opts?): Poll the element's textContent (or opts.attr) every opts.interval ms (default 1500); return true after opts.stableChecks (default 2) consecutive unchanged + non-empty samples; false after opts.maxMs (default 20000). Prefer this for streaming-content completion (AI answers, live feeds) instead of guessing fragile loading-class selectors.
- $scrollBy(deltaY, selector?): Scroll the window (or element matching selector) by deltaY pixels. Returns { scrolled, prevY, newY }. Use for infinite feeds / load-more pages.
- $scrollToBottom(selector?): Scroll window (or element) to its bottom. Returns { scrolled, prevY, newY }. scrolled:false means the position did not change — the feed is exhausted. See SCROLLING below for the poll-load pattern.
- $scrollIntoView(selector): Scroll element to the top of the viewport. Returns { found: true }. Use to reveal "See more" / "Load more" buttons before clicking them.
- $hover(anchorSelector, popoverSelector?, opts?): Dispatch a trusted mouseMoved at the anchor's bounding-box center, wait for the popover selector to appear (default 3000ms), return { hovered, htmlSnippet, popoverSelector, reason? }. Use to enrich records with fields that live in a hover popover (group/account/profile preview cards) rather than the list DOM. opts.index (number, 0-based) addresses the Nth match of anchorSelector — use this for multi-record hover instead of \`:nth-of-type\` (see CSS TRAP below). See HOVER ENRICHMENT below.

CSS TRAP — Do NOT use :nth-of-type(N) on a compound selector. 'li.result-item:nth-of-type(5)' matches the 5th sibling *of that element type* (any 5th <li>), not the 5th matching li.result-item. To get the Nth match, use $list and index into the returned array: const items = await $list('li.result-item'); const fifth = items[4]; If you need all items in a list, iterate the array — never emit per-index selectors. (Exception: if an ANNOTATION gives you a selector that already contains :nth-of-type, copy it verbatim per the SELECTOR FIDELITY RULE below — this trap applies only to selectors you compose yourself.)

STANDARD CSS ONLY — every \$ API selector is passed to document.querySelector/querySelectorAll. Only standard CSS selectors are valid. Playwright/Puppeteer-only pseudo-classes DO NOT EXIST here: :has-text("..."), :text="...", :text-is(), :contains(...), :visible, :nth-match(). Using any of them throws "not a valid selector" IMMEDIATELY and kills the entire step before anything runs. To select by VISIBLE TEXT, select by structure first, then filter in JS:
  // Find an end-of-feed marker by its text:
  const headings = await \$list('h2, div[role="heading"]');
  const related = headings.find(h => /related searches/i.test(h.textContent || ''));
  if (related) { /* end of feed */ }

ANTI-PATTERN — Do NOT build selectors with template-literal indices in a loop. The following pattern is ALWAYS WRONG and fails on real DOMs (modern component libraries, React/Vue apps, virtualized lists) because :nth-of-type is resolved among SIBLINGS OF THE SAME TAG, not among prior compound-selector matches:
  // WRONG — every one of these fails or matches the wrong element:
  for (let i = 0; i < n; i++) {
    const author = await $extract(\`li.result-item:nth-of-type(\${i+1}) a.author-link\`, null, 3000);
  }
Each failed $extract also burns its full timeoutMs (3s × items × fields = 30s+ of step budget wasted), which then triggers SCRIPT_TIMEOUT / POLL_EXHAUSTED. If you catch yourself writing \`:nth-of-type(\${i+1})\` or \`:nth-child(\${i+1})\` inside a loop, STOP — you want $extractList or $list instead.

ANTI-PATTERN (global $extract inside a $list loop) — $extract, $click, $, $wait and all other DOM APIs query the WHOLE DOCUMENT, not the "current" list element. They take a selector string, not a container element. So iterating $list and calling $extract per item with the SAME selector produces N identical copies of the FIRST match in the document:
  // WRONG — every iteration extracts the same first-match author; the resulting
  // items array is N duplicates of the first item:
  const items = await $list('li.result-item');
  for (const item of items) {
    const author = await $extract('a.author-name');
    // ← item is ignored; $extract queries the whole document every time
  }
$extract has no per-container overload. For per-container field reads, use $extractList(containerSel, fieldMap) — each sub-selector is evaluated INSIDE each container element, so the fields stay aligned per item. There is no correct "iterate $list + $extract per item" pattern.

LIST EXTRACTION — When extracting multiple fields from a collection of list items, PREFER $extractList(containerSel, fieldMap). It runs ONE container query + per-item sub-queries and returns aligned records. This is the canonical pattern for blog rolls, search results, feed posts, product grids, comment threads — anywhere you have N sibling containers each with the same inner fields.
  // CORRECT — one call, all fields aligned, no per-index selectors:
  const items = await $extractList('li.result-item', {
    author:  'a.author-name',
    content: '.item-body',
    href:    { selector: 'a[href]', attr: 'href' }
  }, { allowEmpty: true });
  return { items };
Fall back to $list ONCE PER FIELD only for single-field extraction. NEVER zip independent $list arrays — if one field is missing on some items, the zip silently shifts every later field.

SELECTOR GENERALIZATION — Annotation selectors the user clicked often embed specific values that only match ONE element on the page. Common traps:
  - aria-label with text: a[data-act="view-profile"][aria-label="John Doe"] — matches only the item whose aria-label is literally "John Doe"; other items have aria-label="Jane Roe", "Sam Smith", etc. → GENERALIZE to a[data-act="view-profile"][aria-label] (attribute presence).
  - text-equality: a[text()='John Doe'] → GENERALIZE to a structural selector (a[href*="/user/"], .author-name > a, etc.).
  - nth-child/Nth-of-type indices captured at annotation time → KEEP them only if the user explicitly annotated a specific item; otherwise drop and use the container selector alone.
If a field returns data for some items but null/empty for others in the same list, the selector is too specific. Re-generalize by removing literal values from attribute matchers.


FIELD COLLISION ON GENERALIZATION — After generalizing an annotation selector per the rule above, VERIFY that no two outputFields end up matching the SAME element. The most common collision is on sites where multiple semantic elements share the same attribute (e.g. BOTH the author link and the timestamp link carry aria-label). When two fields would collapse onto the same selector:
- Add a STRUCTURAL discriminator to one of them. Patterns that work in practice:
  * href content: author links usually have href*="/user/" or href*="/profile/"; timestamp links often have href*="/items/" or no href at all.
  * ancestor tag: timestamp links are usually NOT inside <h3>; author links are.
  * attribute value pattern: aria-label on a timestamp matches date/time regexes (e.g. /^\\d{1,2}:\\d{2}$|^\\d+\\s+(?:hours?|days?)\\s+ago$|^yesterday$/i); aria-label on an author is a person name.
- Do NOT use bare attribute-presence selectors ([aria-label], [href]) for BOTH fields — that guarantees collision. Pick one field to make specific.
- When unsure, run $list on each candidate selector separately and inspect the returned textContent/href arrays — they should differ field-by-field.

COUNT METRICS OFTEN LIVE ONLY IN ARIA-LABEL — When a count-like field (likes, comments, shares, views, downloads, etc.) stays empty on EVERY record while sibling fields extract fine, the count usually is not in any text node: action-bar controls frequently render truncated or no visible text, and the full value (number + label word) exists only in an accessibility attribute (aria-label, title) on an element near the END of the record markup. textContent never includes attributes, so text-based selectors and text regexes return "" forever — re-regexing visible text can NEVER fix such a field. Instead: find the attribute-bearing element in the RECORD HTML evidence (usually near the end of the record), point the field at it with an attribute read, and parse the number in JS:
  comments: { selector: '[role="button"][aria-label*="comment" i]', attr: 'aria-label' }
  const parseCount = (s) => { const m = String(s || '').match(/\\d+([.,]\\d+)?/); return m ? m[0] : ''; };
  — adapt the selector to the actual label wording seen in the RECORD HTML (label words may be in ANY language; match on the literal substring you observe). Multiple controls may carry aria-label (like button, comment button, share button) — apply the FIELD COLLISION rule above and verify each count field reads a DIFFERENT element. If the attribute is absent on some records, default to '' — never copy a sibling metric.

$EXISTS IS VISIBILITY-GATED, READS ARE NOT — $exists(selector) returns false for elements that are display:none / visibility:hidden / zero-size, while every READ ($extract, $list, $count, $extractList) matches them normally. That asymmetry makes the guard idiom \`if (!(await $exists(sel))) return null;\` a silent-empty generator: the element EXISTS and its text is readable, but the guarded field extracts "" on every record (hidden label spans referenced by aria-labelledby are the classic case). NEVER gate a read on $exists — bind the field directly. If you need a cheap pre-check, pass timeoutMs=0 (the default 5000ms poll burns 5s on every false, and several guarded reads blow the 60s step budget). When $exists returns false but selector diagnostics report matchedButInvisible (or probe.count reports invisibleCount > 0), the element exists and is readable RIGHT NOW — read it directly.

CROSS-ENTITY FALLBACK — When a record has multiple sub-entities (e.g. an "owner" object AND an "author" object, each with its own name field), DO NOT copy values from one sub-entity into another to "fill in" empty fields. Each sub-entity is independent: if its own selector found nothing on a given record, its fields stay EMPTY (empty string, empty array, or null per the schema's nullability) — they do NOT inherit from a sibling sub-entity. Anti-pattern: \`username: username || groupName\` (or \`profileHref: userHref || groupHref\`) makes the owner's name identical to the author's name whenever the owner is missing, permanently erasing the distinction between the two entities. Correct: \`username: username || ''\` and let the schema's nullability express "no owner on this record". If the schema declares a sub-entity as nullable (type:['object','null']), return null when its selector found nothing, NOT an object populated with another entity's data. If the schema declares it as non-nullable, still keep its primitive fields empty rather than copying sibling data — empty strings are honest signals the framework's EMPTY_FIELDS detector can act on; copied values are silent corruption.

MULTI-VALUE FIELDS (e.g., images[], attachments[], tags[]) — When the output schema declares an array field inside each list item (e.g. posts.images: array of URLs), do NOT use $extract('img', 'src') inside the container — that returns ONE src. Use $list('img') (returns array of data objects) and map to .src, OR use $extractList with a sub-selector that aggregates. The "field" in $extractList's fieldMap is a single match per container; for multi-value fields, post-process the container via a separate $list call.

EMPTY-LIST BAILOUT — If the parent list query returns 0 items, DO NOT proceed with field queries. Return { done: false } immediately (if the step has a retry budget) or { failed: true, error: 'no items found for selector X' }. Without this rule, a step runs 8+ sequential DOM round-trips that all return empty, burning the step time budget and hiding the real failure behind a generic not-done signal.

RECORD FILTERING — Do NOT write patterns that risk collapsing ALL records to an empty array. The framework's EMPTY_EXTRACTION detector fires when a required array-of-objects field returns [] (the LLM gets the strong "fix failing step" autoFix prompt). Two patterns reliably trigger this:

Pattern 1 — regex-test outerHTML to classify records (BROKEN):
  // WRONG — sites use data-* attributes for legitimate rendering, NOT just ads:
  const html = (r.html && r.html[0]) || '';
  const isAd = /sponsored|data-ad-/i.test(html);
  const isRecommendation = /recommend/i.test(html) && !content;
  if (isAd || isRecommendation) return null;
outerHTML contains EVERY internal attribute the site uses for rendering — preview metadata, tracking pixels, component-library hooks. Your content selector probably uses one of those same attributes (e.g. the content container itself has data-preview="message"), so the ad-detection regex will match EVERY record. The whole list collapses to [].

Pattern 2 — return null + .filter(p => p !== null) (BROKEN):
  // WRONG — if every record matches a filter-out condition, posts becomes []:
  const posts = records.map(r => {
    if (!r.content) return null;
    return { content: r.content, ... };
  }).filter(p => p !== null);
  return { posts };
When the content selector misses (a single broken field), EVERY record returns null and the array becomes []. The framework treats this as a SELECTOR problem and never discovers your filter logic.

CORRECT patterns — return EVERY record with empty fields for missing data:
  // RIGHT — empty strings are honest signals the framework's EMPTY_FIELDS detector can act on:
  const posts = records.map(r => ({
    content: (r.content && r.content[0]) || '',
    author: r.author || '',
    // ...all schema-required fields with empty-string / empty-array defaults
  }));
  return { posts };
The framework's EMPTY_FIELDS detector will surface which fields are uniformly empty across records, and autoFix can iterate field-by-field instead of guessing.

If you MUST skip a record, do so conservatively — only skip when you have POSITIVE evidence from a SPECIFIC element (e.g. an explicit "Sponsored" label span that exists NOWHERE else on the page), never regex-test outerHTML.

CARD-TYPE HETEROGENEITY (feeds mixing promoted and organic cards): when a required field comes back empty on every record, check WHAT KIND of cards your selectors kept before rewriting the field selector. Heterogeneous feeds mix promoted/sponsored cards with organic ones, and promoted cards often lack permalink/timestamp fields entirely — the field is not "hard to select", it does not exist on that card type. Corollaries:
(a) a container filter or field selector built on promoted-card markup attributes implicitly keeps ONLY promoted cards, making user-facing fields (permalink, timestamp) structurally unreachable — select organic cards and exclude promoted ones by a specific, language-INDEPENDENT markup signal (a dedicated data-* rendering attribute — but READ THE ATTRIBUTE'S NAME FIRST: if the name itself carries a promotion token like ad/sponsored/promoted, that attribute MARKS promoted cards and belongs in an exclusion, never in your selector's :has(); see (f)), never by localized label text (a "Sponsored" text match silently misses localized pages);
(b) do not write contradictory filters across steps — step N keeping only card type A while step M excludes card type A yields empty or mislabeled output. Decide ONE card policy per service and enforce it at exactly ONE place in the chain;
(c) the scroll step's counter is a card filter too — an unfiltered counter counts recommendation/promoted cards toward the target, so the loop exits "successfully" carrying junk. Count with the SAME language-independent card signals the extraction step uses, and make the filtered counter safe against matching nothing (see ZERO-TRAP COUNTER);
(d) a cursor over containers is not a count of records — when the extraction step walks containers with an index/cursor, gate its done on the number of records that PASS the card policy (what your filtering/output step would keep), never on the raw container cursor: recommendation/promoted cards consume cursor slots, so a cursor-gated step declares victory at the target having collected FEWER real records than requested;
(e) exclude cards by positive structural evidence, not by label text alone — label regexes ("Sponsored", "Recommended for you") are locale- and markup-fragile and silently miss current markup; a card that lacks EVERY organic anchor (permalink href, timestamp link, author/profile hover anchor) is promoted/recommendation BY STRUCTURE, and its fields are empty precisely because they do not exist on that card type.
(f) ATTRIBUTE-NAME POLARITY — when hunting a structural marker to select content cards, check the attribute's NAME before using it positively. An attribute whose name carries a promotion token (ad, sponsored, promoted, commercial) exists to MARK promoted cards: it is an EXCLUDE signal. Writing it as an include — \`div[card]:has(div[data-ad-...='message'])\` — inverts your card policy and keeps ONLY promoted cards, so count-like targets become unreachable (the page holds a handful of ads, not N of them) and the run "succeeds" returning ads whose permalink/timestamp fields are structurally empty. The correct uses are the negative form \`div[card]:not(:has([data-ad-...]))\` (or filtering \`data-*\` promotion attributes out in JS) — and when you need a positive organic marker, take it from evidence you verified exists on organic cards only (a permalink href, a timestamp link), never from an attribute that names itself as promotion markup. CAVEAT — the negative form is not automatically safe either: some data-* attrs whose names look promotional are DESIGN-SYSTEM attributes present on EVERY card, organic ones included (a story renderer attr can sit inside every post), and then :not(:has([attr])) removes the whole population and matches zero containers forever. VERIFY either polarity by counting the selector WITH and WITHOUT the clause before shipping it ($count on the stripped form, or attrStats with the descendant form sel + ' [attr]' to see which share of containers actually carries the marker inside). When a list call matches zero containers, the error carries a SELECTOR DIFFERENTIAL — live counts of your container selector with trailing :not()/:has() clauses progressively stripped — read it FIRST: base matched N while the full selector matched 0 means your own clause removed everything, which is a selector problem, NOT an input-value or fieldMap problem; do not iterate anything else until the differential is explained.

IMPORTANT: For waiting or polling scenarios (e.g., checking if AI has finished generating), do NOT use $() in a loop — it will throw after 30s if the element is not found. Instead:
- Use 'await new Promise(r => setTimeout(r, ms))' for fixed delays
- Use $exists(selector, timeoutMs) for quick existence checks in polling loops

IFRAME CONTENT:
Many websites load content dynamically inside iframes. All $ APIs automatically search inside same-origin iframes on the target page.
- The page snapshots include content from same-origin iframes — use selectors you see there
- $wait and $ APIs will find elements inside same-origin iframes automatically
- For $openTab detail pages, the snapshot includes the detail page content including any same-origin iframe content

TARGETING A SPECIFIC IFRAME (deterministic, multi-iframe pages):
When a page has MULTIPLE iframes with similar markup (common on government / bid / portal sites — e.g. one iframe per tab, each with the same .detail-info-main container), a plain selector like '.detail-info-main > p > u' is ambiguous and $ APIs may match the wrong iframe. Pin the selector to a specific iframe with the iframe-prefix syntax:
  iframe<iframe-css>::<inner-css>
Examples:
- $('iframe#content-frame1::u > font')                          — element inside iframe with id="content-frame1"
- $('iframe[src="content.html"]::p.MsoNormal > u')          — element inside iframe with that src
- $extract('iframe#iframe1::iframe#iframe2::#deep')         — nested iframes (chain the prefix)
The <iframe-css> part is evaluated in the PARENT document and must match the <iframe> element itself (typically iframe#id or iframe[src="..."]). The <inner-css> part is a normal CSS selector evaluated inside that iframe's document. The prefix works in every $ API ($, $click, $type, $extract, $wait, $exists, $check, $list, $count, $waitForStable). Prefer this prefix whenever the snapshot shows the data lives inside an iframe element — the prefix is the only way to guarantee the right iframe is targeted.

INPUT DATA:
- The external program's input is available as the variable __input__ (an object).
- Example: await $type('#search', __input__.query);

STEP RESULTS (available in every step except the first):
- __lastResult__: The return value of the immediately preceding step (any type). Use for simple sequential flows.
- __stepResults__: Object mapping step IDs to their return values. Example: __stepResults__['2'] gives step 2's result. Use to access any prior step's data.
- FIELD-NAME COHERENCE: when reading fields off __lastResult__ or __stepResults__['N'], use the EXACT property names the upstream step writes in its return statement. A renamed property silently becomes undefined (e.g. upstream returns {authorName, timestamp} but downstream reads __lastResult__.author / __lastResult__.time → both undefined). Before consuming any field, list the upstream step's actual property names verbatim.

RETURN VALUE:
- Each step script must return a JSON-serializable value (string, number, boolean, object, array).
- This value becomes the step result and is passed to subsequent steps if needed.
- Use "return { ... }" to structure data for the final output.

CONDITIONS:
- The optional "condition" field of a step is evaluated ON the target page (not in sandbox), so it CAN use document.querySelector.
- Conditions determine whether the step runs or is skipped.

FLOW CONTROL (read carefully — getting this wrong is the #1 cause of broken services):
- Steps form a directed graph via onSuccess / onFailure step IDs.
- onSuccess: the step to run when THIS step succeeds (content ready / data extracted). Point it at the NEXT step. For a wait/poll step, point it at the extraction step that should run once the content is ready.
- onFailure: the step to run when this step fails or gives up (its condition is false, its retry budget is exhausted, or it returned { failed: true }). Usually 'TERMINATE' or an error-handling step.
- Use "TERMINATE" to end execution. Do NOT use "SELF" — it is no longer supported and will be rejected.
- POLLING / WAITING / ITERATING: a step that may need to repeat sets maxIterations>1 (e.g. 20-60) and returns a not-ready signal to retry itself. When it is done, it returns the extracted data (or { done: true }) and the orchestrator follows onSuccess to the next step.
  - Return { done: false } (or { ready: false }, { complete: false }, { generating: true }, { loading: true }) → the SAME step runs again, up to maxIterations times.
  - Return anything else (the real data, or { done: true }) → SUCCESS → orchestrator follows onSuccess.
  - Return { failed: true } (or { error: "message" }) → FAILURE → orchestrator follows onFailure.
- A step with maxIterations<=1 (the default) is a normal step: its result is pure data and ALWAYS follows onSuccess — it is never inspected for retry signals. Only set maxIterations>1 on steps that must retry.
- The system auto-detects back-edge loops and boosts maxIterations for their targets, but set it explicitly to be safe.
- The system has a global iteration limit (default: 50 total step executions) that prevents runaway loops.
- You do NOT need to handle navigation — the agent already opened the target URL. NEVER use window.location.* / location.replace() / location.assign() inside a script: they navigate the SANDBOX, not the target tab, and the runner refuses them (FORBIDDEN_NAVIGATION).

EXAMPLE:
  await $type('input[name="q"]', __input__.query);
  await $click('button[type="submit"]');
  await $wait('.results', 2000);
  return {
    items: await $extract('.results')
  };

LIST ITEM ITERATION (use $list to get all matching elements):
  const items = await $list('li.item a.title');
  // $list returns array of { tagName, id, className, textContent, value, href, src, checked, disabled }
  const results = items.map(el => ({ title: el.textContent, href: el.href }));

ATTACHMENT ITERATION (use $list for elements that may be inside iframes):
  const links = await $list('div.attachments a.attachment-link');
  const attachments = links.map(el => ({ name: el.textContent, href: el.href }));

DO NOT use $count + :nth-child() loop to iterate elements — it breaks when elements span multiple iframes because $count sums across all documents but :nth-child() searches one document at a time.

DETAIL PAGE SCRAPING (use $openTab to scrape each item's detail page):
  const linkEl = await $('a.detail-link');
  const href = linkEl.href;
  const detail = await $openTab(href, \`
    await $wait('.detail-content', 3000);
    const title = await $extract('h1');
    const body = await $extract('.detail-content');
    return { title, body };
  \`);

AI CHAT / STREAMING RESPONSE (wait for content to finish generating):
  Create ONE wait step: onSuccess='extract-step' (the step that extracts the answer once ready), onFailure='TERMINATE', maxIterations=60. The wait step returns { done: false } while still generating, and { done: true } (or the extracted data) once finished — the orchestrator retries it up to maxIterations times, then follows onSuccess to extract. Do NOT use "SELF".

  CRITICAL: You MUST identify the correct completion signal. Check the page snapshot for specific loading/generating indicator elements and use their EXACT class names.
  The CORRECT approach is to check that a loading indicator DISAPPEARS (negative check):
    await new Promise(r => setTimeout(r, 3000));
    // Use ONLY specific class names from the page snapshot, NOT wildcard selectors
    const stillLoading = await $exists('.generating-indicator', 3000);
    return { done: !stillLoading };

  DO NOT check if the submit button EXISTS - on most AI chat sites the submit button is always visible regardless of generation state. Checking for submit button will cause premature {done: true}.
  DO NOT use wildcard attribute selectors like [class*="loading"] or [class*="generating"] - these match too many unrelated elements (lazy-load images, page placeholders, etc.) and cause infinite loops. Use ONLY specific class names found in the page snapshot.

  Alternative completion patterns:
    // Wait for a "stop generating" button to disappear
    const stopBtn = await $exists('.stop-generating-button', 2000);
    return { done: !stopBtn };
    // Wait for a completion status indicator to appear
    const hasComplete = await $exists('[data-status="COMPLETE"], .response-complete', 3000);
    return { done: !!hasComplete };

  IMPORTANT: Always use $exists() for polling - NEVER use $() in a loop. Use at least 3s delay between checks: await new Promise(r => setTimeout(r, 3000))


EXPAND-THEN-EXTRACT (e.g. clicking "See more" / "展开" / "Read full" in each post before extracting full content):

When the user wants full content that requires clicking an expander inside EACH list item, split it across two steps:

  Step 2 (expand, maxIterations>1):
    // "See more" text can't be matched in pure CSS — locate the expander by structural cues
    // (button wrapping a span) and trust the click is idempotent if already expanded.
    const r = await $clickInList('li.result-item', 'button:has(> span)', { delayMs: 600 });
    if (r.errors.length) return { done: false };   // retry once — transient layout races
    return { done: true, expanded: r.clicked };

  Step 3 (extract):
    return { items: await $extractList('li.result-item', { content: '.message-body', author: '.author-name' }) };

Why two steps: $clickInList's default 500ms delay × N posts can exceed the single-step 30s timeout for long lists; a poll-style Step 2 (return { done: false } on partial errors) lets the orchestrator retry safely. If the list is short (N<10) and total click time stays well under the step timeout, a single step combining $clickInList + $extractList is acceptable.

SCROLLING (infinite feeds / load-more pages — feed streams, comment threads, search results):
Three scroll APIs are available. All three scroll the TARGET PAGE (window or a matched scrollable element), never the sandbox. Use them to load more posts before $extractList runs.
- $scrollBy(deltaY, selector?): Scroll window (or element matching selector) by deltaY pixels. Returns { scrolled: bool, prevY, newY }.
- $scrollToBottom(selector?): Scroll window (or element) to its bottom. Returns { scrolled: bool, prevY, newY }.
- $scrollIntoView(selector): Scroll a specific element to the top of the viewport. Returns { found: true }. Use to reveal a "See more" / "Load more" button before clicking it.

POLL-LOAD PATTERN (the canonical "scroll until exhausted" loop):
A scroll-to-load step is a poll step: maxIterations>1, onSuccess = the extraction step, onFailure = TERMINATE. Each iteration scrolls once, waits for new content to render, and returns { done: false } until the scroll position STOPS CHANGING (meaning the feed is exhausted).
  // Step 2 (scroll_and_load, maxIterations: 20, onSuccess: '3', onFailure: 'TERMINATE'):
  const r = await $scrollToBottom();           // or $scrollBy(window.innerHeight * 2)
  await new Promise(resolve => setTimeout(resolve, 1500));  // let new posts render
  const postCount = await $count('li.result-item');
  if (!r.scrolled && postCount >= 10) return { done: true, postCount };   // feed exhausted AND we have enough
  return { done: false, postCount };                                      // retry — more posts may load

CRITICAL: "position did not change" (r.scrolled === false) is the most reliable exhausted-feed signal for ordinary feeds. Do NOT guess that the feed is exhausted from a post count alone — infinite feeds often stop scrolling mid-page when the user is idle, then resume on the next scroll. Only declare done when BOTH (a) r.scrolled === false for the latest scroll AND (b) you have at least the user-requested number of posts (or a small number of consecutive unchanged scrolls — track via __lastResult__). EXCEPTION — VIRTUALIZED FEEDS (see below): r.scrolled can stay true forever while no new content mounts; there the noGrowth signature counter is the only trustworthy signal.
  // Stricter variant — require N consecutive no-progress scrolls before done:
  const r = await $scrollToBottom();
  await new Promise(resolve => setTimeout(resolve, 1500));
  const stalled = (__lastResult__ && __lastResult__.stalled || 0) + (r.scrolled ? 0 : 1);
  const postCount = await $count('li.result-item');
  // NEVER guard the exhausted exit with '&& postCount > 0': if the item
  // selector (or a counting filter) matches nothing, the count stays 0
  // forever, this exit is unreachable, and the step scrolls until
  // maxIterations. Zero for N stalled iterations is itself a verdict —
  // exit exhausted and let downstream diagnostics SEE the zero.
  if (stalled >= 3) return { done: true, postCount, exhausted: true };
  return { done: false, postCount, stalled };

SCROLL CONTAINER (not the window): some sites scroll an inner element (overflow:auto/scroll), not the document. If $count returns 0 after $scrollToBottom() with no selector, find the scrollable container in the snapshot and pass its selector: await $scrollToBottom('div[data-scrollable-container]'). A quick heuristic: the element with the largest scrollHeight that is NOT document.body is usually the feed's scroll root.

FIRST CONTENT MAY NEED A SCROLL (container present, 0 items at load): many feed/search pages render the container immediately but show 0 items until the first scroll — items are viewport-gated (IntersectionObserver lazy render), not network-late. If $count(itemSel) stays 0 across retries while the container exists, do NOT keep polling passively and do NOT nudge with window-level $scrollBy(delta) — when the page scrolls an inner container (see SCROLL CONTAINER above), window scroll is a no-op and nothing ever renders. Put the nudge inside the poll step itself: await $scrollToBottom('div[role="feed"]') (or $scrollBy(delta, containerSel)), wait ~2s for render, THEN count again.

VIRTUALIZED FEEDS (search results, social feeds, infinite-scroll comment threads): these feeds UNMOUNT posts as you scroll past them — $count('li.result-item') STAYS AT 7 across iterations even though new posts are loading in. The stalled-counter pattern above will declare "exhausted" prematurely because postCount never grows past the visible-window size. Track UNIQUE post signatures across iterations via __lastResult__ instead:
  // Step 2 (scroll_and_load, maxIterations: 20, onSuccess: '3', onFailure: 'TERMINATE'):
  const seen = new Set((__lastResult__ && __lastResult__.seenSignatures) || []);
  const r = await $scrollToBottom();
  await new Promise(resolve => setTimeout(resolve, 1500));
  // Snapshot current articles — use a STABLE signature (author + first 80 chars of content)
  const articles = await $list('li.result-item');
  for (const a of articles) {
    const sig = (a.textContent || '').slice(0, 100);   // stable across scroll position
    if (sig.trim()) seen.add(sig);
  }
  const uniqueCount = seen.size;
  // noGrowth: consecutive iterations that added ZERO new signatures. This —
  // not r.scrolled — is the reliable exhaustion signal (see WARNING below).
  const prevUnique = (__lastResult__ && __lastResult__.uniqueCount) || 0;
  const noGrowth = (uniqueCount > prevUnique) ? 0 : (((__lastResult__ && __lastResult__.noGrowth) || 0) + 1);
  if (uniqueCount >= 10) return { done: true, uniqueCount, seenSignatures: [...seen].slice(0, 50) };
  // DEADLOCK WARNING: do NOT write this as 'noGrowth >= 3 && uniqueCount > 0'.
  // When the counting filter (or signature scheme) matches nothing, uniqueCount
  // stays 0 on every iteration, the '> 0' guard makes this exit unreachable,
  // and the step scrolls until maxIterations while the user watches the page
  // fill with cards the script never counts. Zero-growth for N consecutive
  // iterations is a valid exhaustion verdict even at count 0 — exit and let
  // the zero be visible to downstream diagnostics and auto-fix.
  if (noGrowth >= 3) return { done: true, uniqueCount, seenSignatures: [...seen].slice(0, 50), exhausted: true };
  return { done: false, uniqueCount, noGrowth, seenSignatures: [...seen].slice(0, 50) };
Key insight: $count(DOM) ≠ unique posts seen. The DOM is a sliding window; signatures accumulated across iterations are the truth. Cap seenSignatures at ~50 entries to avoid unbounded growth across long feeds.
WARNING: do NOT use r.scrolled === false as the exhaustion signal on virtualized feeds. r.scrolled can stay true indefinitely — the feed's scroll position and container height keep creeping without any new content mounting, so every iteration "successfully scrolls" while the unique-signature count is frozen. Judge exhaustion ONLY by signature growth (the noGrowth counter), never by scroll position.

ZERO-TRAP COUNTER (filtered counting in scroll loops): discriminating card types inside the scroll counter — e.g. counting only cards that contain a permalink href matching a regex, the correct way to skip recommendation/promoted cards (see CARD-TYPE HETEROGENEITY) — introduces a failure mode the selector diagnostics CANNOT see: the counting filter itself can match NOTHING. Permalink shapes vary by site, locale, and era (/posts/<id>/, story.php, /share/p/<id>/, watch?v=, /reel/<id>/) — a regex written from assumption instead of observation matches 0 hrefs on every card, the count stays 0 forever, and (per the DEADLOCK WARNING above) the step scrolls to maxIterations while the user watches the page fill with cards the script never counts. Three defenses:
(a) sample before you filter: extract the raw values first — $extractListMulti(containerSel, { h: { selector: 'a[href]', attr: 'href' } }, { allowEmpty: true }) — read what the hrefs actually look like (they surface in SELECTOR DIAGNOSTICS), THEN write the regex around the observed shapes;
(b) never guard the exhausted exit with 'count > 0' — at a permanently-zero count that exit is unreachable and the loop's only stop becomes maxIterations (minutes of pointless loading);
(c) keep a RAW fallback counter (records.length or $count(containerSel)) alongside the filtered one: filtered 0 while raw keeps growing proves the filter (not the page) is wrong — exit exhausted with a zeroFiltered marker so the failure is visible and repairable, instead of scrolling forever. And once you keep that RAW counter, treat its growth as PROGRESS: reset your noGrowth/stalled counter whenever the raw count grows, even when the filtered count does not — a feed that is still loading containers has not exhausted anything, and exiting on a filtered-count stall while raw still climbs gives up below the target with data on the table.

RAW HTML EXTRACTION (domHtml, full record HTML fields):
$extract(sel) and $extractList(sel, { field: { selector, attr } }) support attribute reads. outerHTML and innerHTML are DOM PROPERTIES (not HTML attributes) — historically getAttribute returned null for them. They are now supported: pass attr='outerHTML' or attr='innerHTML' and the runner reads the DOM property directly.
  // Full HTML of the record container:
  const html = await $extract('li.result-item', 'outerHTML');
  // Per-record HTML inside a list:
  const records = await $extractListMulti('li.result-item', {
    html: { selector: '', attr: 'outerHTML' }    // empty selector → the container itself
  });
  // ^ Note: empty selector inside $extractListMulti returns the container's own outerHTML.
Do NOT use textContent as a substitute for outerHTML when outputSchema asks for raw HTML — textContent strips all tags and produces plain text the consumer cannot parse.

EXTRACT-WITH-HOVER (container-scoped extract + hover — PREFERRED for list enrichment):
When you need to extract fields from a list of containers AND enrich each
record with hovercard/popover data from anchors inside the SAME container,
\$extractWithHover is the correct primitive. It extracts fields AND hovers
every anchor inside each container in one atomic call, eliminating the
alignment failure mode of the manual-loop pattern.

Signature: \$extractWithHover(containerSel, fieldMap, opts) → Promise<Array<Record>>
  - containerSel: CSS selector for the list containers (e.g. 'li.result-item').
  - fieldMap: same shape as \$extractList ({ fieldName: subSel | { selector, attr? } }).
    Each field gets ONE value (the first match) per container — scalar, not array.
    fieldMap 字段规格支持 read:'text'|'attr:<名>'|'labelledby'|'describedby'|'hoverPopover'|'hoverPopoverHtml'
    （hoverPopover=悬停本选择器捕获弹层的剥标签原文——"postTime = 时间戳锚点弹层文本" 一行声明；仅 \$extractWithHover 合法）
    与 match:'<正则>'（你自己的识别谓词，基建只应用不解释；不命中得空串、捕获原文仍在 hovercards[].popoverText）。
    例：postTime 字段 { selector: <时间戳锚点>, read:'hoverPopover', match:'\\d{4}' }。
  - opts.hover: { anchorSel (required), popoverSel?, timeoutMs?, dismiss? }.
  - opts.allowEmpty: same semantics as \$extractList.
  - opts.containerIndex / opts.containerRange / opts.maxContainers: narrow
    which containers get processed (only one may be set). Use containerRange
    to slice a large batch across orchestrator iterations when the total
    time would exceed the step timeout.
  - opts.maxWallMs: wall-clock budget for the hover batch (default 25000ms).
    Each hovered anchor burns ~5-10s even when no popover appears, so a long
    feed can outlive the step budget with ZERO results. When the budget is
    hit, the call does NOT error — it resolves to the partial envelope:
      { records: [...processed so far...],
        partial: { processed: K, total: N, maxWallMs: M,
                   note: 'wall budget reached — K of N containers processed; re-run with containerRange:[K,N] (or maxContainers) to continue, or raise opts.maxWallMs' } }
    Resume by re-running with containerRange:[K,N] (already-processed containers are NOT re-hovered).
    When ALL containers fit the budget, the call returns the plain records
    array exactly as before (check partial first; Array.isArray means all-fit).

Returned records (one per processed container, in document order):
  [
    {
      // ...fields from fieldMap (scalar values — same as \$extractList)
      hovercards: [
        { hovered: bool, htmlSnippet: string|null, popoverSelector: string|null,
          autoDiscovered: bool, reason: string|null, anchorIndex: number,
          anchorHref: string, anchorText: string,
          labelledbyText: string|null, labelledbyAttr: string|null,
          labelledbyNote: string|null },
        // one entry per anchor inside THIS container, in document order.
        // anchorHref is the raw href attribute of the hovered anchor
        // (empty string when absent) — the primary signal for classifying
        // which kind of entity the hovercard describes. anchorText is the
        // trimmed anchor text (capped at 120 chars). labelledbyText is the
        // anchor's accessible label resolved from its aria-labelledby/
        // aria-describedby reference chain (harvested at dwell time, also
        // present on failed entries); labelledbyNote carries the
        // falsification reason when it resolved to nothing.
      ]
    }
  ]

  const records = await \$extractWithHover('li.result-item', {
    title: 'h3.title',
    anchorHref: { selector: 'a.profile-link', attr: 'href' }
  }, {
    hover: {
      anchorSel: 'a.profile-link',
      popoverSel: 'div[role="dialog"]',
      timeoutMs: 3000
    },
    allowEmpty: true
  });
  // Step 2: classify hovercards per record. The framework returns raw
  // htmlSnippet[] — classification is your job. Parse each snippet with
  // DOMParser and bucket by snippet-specific signals.
  for (const rec of records) {
    rec.categoryA = [];
    rec.categoryB = [];
    for (const card of rec.hovercards) {
      if (!card.htmlSnippet) continue;
      const doc = new DOMParser().parseFromString(card.htmlSnippet, 'text/html');
      if (doc.querySelector('[data-kind="a"]')) rec.categoryA.push(card.htmlSnippet);
      else if (doc.querySelector('[data-kind="b"]')) rec.categoryB.push(card.htmlSnippet);
    }
  }
  return { done: true, records };

WHY THIS EXISTS — the manual-loop alternative is WRONG for variable anchors per container:
  // BAD: manual loop with global anchor index
  for (let i = 0; i < records.length; i++) {
    const r = await \$hover('a.profile-link', '...', { index: i });  // ← WRONG
    records[i].someField = parse(r.htmlSnippet);
  }
The bug: opts.index addresses the i-th match of 'a.profile-link' GLOBALLY
(across the whole document), not the i-th container's first anchor. When
containers hold variable numbers of anchors, the global array interleaves
across containers and the i-th global anchor belongs to a different
container than records[i]. Use \$extractWithHover to make per-container
anchor iteration the framework responsibility.

RULES:
- PREFER \$extractWithHover whenever you need hovercard data for items in
  a list. Use the standalone \$hover primitive ONLY for one-off hovers
  outside a list context (a single header avatar, a standalone link).
- CLASSIFY BY card.anchorHref FIRST. The href of the hovered anchor is the
  most robust signal for which kind of entity a hovercard describes (its
  URL path shape — segment prefixes, id patterns). Only fall back to
  parsing card.htmlSnippet when anchors are href-less.
- ANCHOR SCOPE — anchorSel is evaluated per container as
  container.querySelectorAll(anchorSel): it must match INSIDE each
  container's subtree. When it matches 0 anchors in every container, hover
  NEVER runs and every record comes back with hovercards:[] holding ZERO
  entries — that empty array is the signature of "anchor not found", NOT of
  "hovered but no card appeared" (a hovered-but-empty attempt produces one
  entry per anchor with htmlSnippet:null and a reason). Two traps seen in
  real failures: (a) wrapper nesting — the visible interactive link sits
  inside a wrapper element (an <object> wrapper, an aria-hidden shell
  around the real link), so a chain naming the visible block misses it;
  (b) sibling-branch chaining — naming an intermediate block (a heading or
  metadata wrapper) that is NOT an ancestor of the link. Prefer a short,
  container-scoped tag+[attr] form (e.g. 'a[role="link"][aria-label]')
  over long descendant chains, and verify it against one container's
  actual HTML before committing.
- Field extraction and hover enrichment happen atomically per container
  in one call. There is no inter-step DOM drift.
- LABELLED-BY FIELDS RESOLVE ACROSS THE HOVER BATCH: on a cold tab the
  hover pass is what mounts the lazily-hydrated aria-labelledby chain, so
  a fieldMap field with { labelledby: true } that read empty BEFORE the
  hover is re-read from the post-hover DOM automatically — you do not need
  assembly gymnastics to copy labelledbyText into it (though the hovercard
  copy remains available). If it is STILL empty after the call, read the
  matching card's labelledbyNote — it names the reason (absent attribute /
  stale ids / nothing in the subtree) before you conclude unverifiable.
- Fields are SCALAR (one value per field per container, same as
  \$extractList). If you need array-valued fields (e.g. all tag links
  in a record), call \$extractListMulti separately on the same containers
  and zip the results by index.
- Hovercards within a record are ordered by anchor document position
  inside that container. anchorIndex is the per-container index (NOT
  global).
- The framework dismisses each popover before hovering the next anchor
  (dismiss defaults to true). Do not set dismiss:false unless you have
  a specific reason — lingering popovers contaminate the next hover.
- HOVER PIPELINE TIME BUDGET: each hovered anchor can burn 5-10s of wall
  time even when no popover appears — hover wait, no-signal early-exit,
  dismiss, and extraction are all time-bounded waits, so this is timeout
  burn, not network latency. Estimate containers × anchors × ~10s and keep
  it comfortably under the ceiling stated in CRITICAL TIME CONSTRAINT: with
  a 60s ceiling that means ~3-4 containers (1 anchor each) per iteration.
  Slice larger batches via containerRange across orchestrator iterations
  (maxIterations>1 + { done: false }) — a step killed mid-batch by
  SCRIPT_TIMEOUT loses ALL of its work. Services using
  \$extractWithHover get the per-step ceiling auto-raised to 120s, but
  slicing is still safer than maxing out the batch width.
- \$extractWithHover requires Enhanced Mode (it uses \$hover under the
  hood, which needs CDP Input.dispatchMouseEvent). Surface this via
  test-result feedback, not by retrying.
- Per-hover reliability (popover detection, baseline-diff, stability,
  contamination scoring) inherits from \$hover — same diagnostics, same
  RC33-RC44 invariants.
- Each hovercard entry carries the full \$hover result shape. If
  htmlSnippet is null, check reason: 'popover_timeout' means the popover
  never appeared; 'popover_failed' means the hover dispatch itself failed.

HOVER ENRICHMENT (hovercard / link-preview fields): some sites surface richer data — group name, member count, account bio, profile image URL — only in a popover that appears when the user hovers a link. The popover is NOT in the list DOM; it's injected into a portal layer on hover. Use \$hover to fire the popover, then parse fields out of htmlSnippet with \$extractListMulti on a temporary DOM root. Signature: \$hover(anchorSelector, popoverSelector?, opts?) → { hovered: bool, htmlSnippet: string|null, popoverSelector: string|null, reason?: 'popover_timeout'|'hover_failed'|<bg reason> }. A no-popover \$hover result may carry rejectedAddedTexts — text READ out of hover-mounted nodes the visual popover filter rejected (hidden or zero-height mounts; a tooltip whose layout never materialized still carries its payload as text). If the value you need appears in rejectedAddedTexts, bind the field from it directly — reads are not visibility-gated, so do not keep re-hovering waiting for a visible popover that never renders.
 **PREFERRED for list contexts:** if you are extracting a list of records AND enriching each with hovercard data, use \$extractWithHover (see the EXTRACT-WITH-HOVER section above). It scopes anchor iteration per container, eliminating the alignment failure mode of the manual-loop pattern below. The standalone \$hover primitive (this section) is for one-off hovers outside a list context.
  // Step 4: extract list with anchor hrefs / link elements
  const records = await \$extractListMulti('li.result-item', {
    anchorHref: { selector: 'a.profile-link', attr: 'href' },
    title: { selector: 'h3.title' }
  });
  // Step 5: hover EACH record's anchor to enrich with popover-only fields.
  //   Use opts.index to address the Nth match of the anchor selector — NEVER
  //   \`a.profile-link:nth-of-type(\${i+1})\` (CSS TRAP — see the warning below).
  for (let i = 0; i < records.length; i++) {
    const r = await \$hover('a.profile-link', 'div[role="dialog"][data-hovercard]', {
      index: i,            // pick the i-th match of 'a.profile-link'
      timeoutMs: 3000
    });
    if (r.hovered && r.htmlSnippet) {
      const doc = new DOMParser().parseFromString(r.htmlSnippet, 'text/html');
      records[i].groupName = (doc.querySelector('div[data-name]') || {}).textContent?.trim() || '';
      records[i].memberCount = (doc.querySelector('span[data-count]') || {}).textContent?.trim() || '';
    }
  }
CSS TRAP (CRITICAL) — Do NOT address the Nth anchor in a list with \`selector:nth-of-type(\${i+1})\`. As documented in the CSS TRAP rule above, \` nth-of-type(N)\` matches the Nth sibling OF THE SAME TAG inside its parent, not the Nth compound-selector match — so on a real component-library DOM it silently picks the wrong anchor (or none) for every i>0. The fix is \$hover's \`opts.index\` parameter: pass \`{ index: i }\` and the framework enumerates all matches of the anchor selector via querySelectorAll, then picks the i-th — same semantics as indexing into a \$list() array, no fragile CSS gymnastics.
RULES:
- \$hover requires Enhanced Mode (it uses CDP Input.dispatchMouseEvent under the hood to produce an isTrusted=true hover — JS-only mouseover is filtered by hover-gated loaders). Without Enhanced Mode, hovered:false with reason:'enhanced mode disabled' — DETERMINISTIC (a Settings toggle, not a transient): no retry will change it, popover-mounted values are unavailable for the whole session, and hover-dependent fields need either the user enabling the toggle or contract renegotiation. Surface this to the user via test-result feedback, not by retrying; labelledby/attr/text reads still work without it.
- ANCHOR MUST HAVE A BOX — an anchor with reason:'anchor_not_hoverable' (display:none / zero-size, typically a HIDDEN tooltip span that a broad union anchorSel like [aria-labelledby] matched) has no rendered box, so no mouse dispatch can ever target it: DETERMINISTIC, do not retry. The dispatch, dwell, and dismiss are all skipped and the anchor-label harvest still ran (labelledby/attr/text reads work on hidden elements). Narrow anchorSel to VISIBLE interactive elements — hover anchors must be things a human can point a mouse at. EXCEPTION — attached-but-box-less (reasonDetail mentions virtualized): an ATTACHED anchor whose box a virtualized feed reclaimed off-screen gets ONE automatic scroll-retry inside the gate; if it still fails, scroll the card into view and RE-RESOLVE the anchor (re-query after scroll) before retrying — the node exists, only its pixels were reclaimed.
- popoverSelector is the popover container, NOT the field inside it. Inspect the page (DevTools Elements panel) while manually hovering the anchor to find the popover container selector. A weak popoverSelector (e.g. 'div') will match the wrong element; a too-specific one will time out.
- After \$hover returns, the framework auto-dismisses (moves the trusted cursor to (1,1) so the popover closes). Pass { dismiss: false } ONLY if you want the popover to linger (rare — usually you want it gone before the next iteration).
- AUTO-DISCOVERY: if your popoverSelector does not match within timeoutMs, the framework falls back to watching DOM mutations and picks up any new visible element of non-trivial size (>=50x50 px) added during the hover window. The result then carries \`autoDiscovered: true\` and \`popoverSelector: '[auto-discovered popover]'\`. This catches React Portal / Vue Teleport / Popper / Floating UI popovers when you don't know the exact container selector. It is still BETTER to provide the right popoverSelector (explicit beats heuristic) — use auto-discovery as a safety net, not a substitute for inspecting the popover DOM.
- POPOVER SELECTOR FROM EVIDENCE — when hovers fail with reason 'popover_timeout' while anchors WERE found, your popoverSelector is the prime suspect: the popover mounted, but your selector describes a different container. The popover's role attribute varies by site and widget (dialog, tooltip, menu, region — no single role is typical), so a guessed role WILL miss on some sites. Do NOT re-guess blind: every FAILED hovercard entry carries \`observedPopover { tag, role, ariaLabel, id, classHead, source, wonTicks, ... }\` — the structural identity of the element auto-discovery actually observed mounting near the anchor. Rewrite popoverSelector from THAT element, e.g. \`div[role="<observedPopover.role>"]\`, tightened with its aria-label/id/class when the role alone is ambiguous. Two failure shapes, two responses: (1) observedPopover PRESENT with reason 'popover_timeout' ⇒ a popover-sized element mounted and your selector missed it — rewrite the selector from the observation. (2) observedPopover ABSENT with reason 'no_hover_signal_early_exit' ⇒ nothing mounted for that anchor at all — the anchor has no popover (skip it, or narrow anchorSel); re-guessing popoverSelector cannot help. And any SUCCESSFUL capture with \`autoDiscovered: true\` means your popoverSelector matched nothing even though the capture was rescued — fix the selector the same way before it starts timing out on slower renders.
- For MULTIPLE records: pass \`{ index: i }\` per call. Do NOT batch-hovers — only one popover is on screen at a time, and most sites close the previous popover on the next hover.
- PREFER \$hover over \$openTab for hovercard data. \$openTab opens a NEW TAB (full navigation lifecycle, network refetch, 5-15s per record). \$hover stays in-page (~250-500ms per record) because the popover content is already loaded or fetched via XHR the page already knows how to make.
- If htmlSnippet is null after hover (popover never appeared), common causes: (a) popoverSelector wrong — read \`observedPopover\` on the failed entry and rewrite from it (see POPOVER SELECTOR FROM EVIDENCE above) instead of inspecting blind, (b) anchor offscreen — \$hover calls scrollIntoView first but some popovers only fire for fully-visible anchors, (c) hover handler gated on Enhanced Mode being enabled. Do NOT retry in a tight loop — surface the failure to the framework.
- HOVERCARD vs LINK-PREVIEW vs TOOLTIP — when an anchor triggers MULTIPLE popover types on the same page (a link-preview card with OpenGraph image+title AND a hovercard with entity stats/member-count/bio AND a small URL tooltip), popoverSelector MUST specifically match the HOVERCARD container — not the link-preview and not the tooltip. The hovercard carries the entity-detail fields you want; the link-preview carries page-preview fields (OG title, OG image, page description) which look similar but are the WRONG card. How to disambiguate in DevTools: (1) manually hover the anchor until every popover has appeared, (2) inspect each popover's data-* attributes and ARIA role/label, (3) pick the one whose DOM contains the field you actually want to extract (member count, bio, follower count, etc.) and use its specific selector — usually a stable container with a distinct [role], [aria-label], or [data-*] attribute. A popoverSelector like 'div[role="dialog"]' or 'div[data-hovercard]' fits SOME sites but the role varies by site and widget — verify against the page (or against observedPopover on a failed entry) rather than assuming; 'div[aria-label="...preview..."]' or any selector matching the link-preview card is the WRONG card. When unsure, prefer the popover whose [role] is "dialog" or "tooltip" with a non-preview [aria-label].
- ANCHOR SELECTOR ROBUSTNESS — keep \$hover's anchorSelector SHORT and use DESCENDANT combinators (spaces), not CHILD (>). Component-library DOM commonly wraps the visible link in 5-10 anonymous intermediate wrappers (div > div > div > ... > a). A selector like \`section h3 a[role="link"]\` (descendant) tolerates wrapper-level refactors; a selector like \`section h3 > span > span > span > span > span > a[role="link"]\` (child chain) breaks the moment the page adds or removes one wrapper level. Prefer: \`<stable-container> <stable-leaf>\` (e.g. \`div[role="article"] a[role="link"]\`). The framework's selector generator already produces short descendant selectors for annotated elements — mirror that style.
- ANCHOR BY REQUIREMENT SEMANTICS, NOT ELEMENT TYPE — hover and click handlers attach to ANY element (span, abbr, time, div, li — not just \`a[href]\`). Choose the anchor by WHAT THE REQUIREMENT ASKS FOR: to read a timestamp tooltip, hover the TIMESTAMP element itself (the abbr/time/span rendering the relative age like "2 d"); to read a profile hovercard, hover the element that names the author. An anchor typed \`a[href^='http']\` or otherwise filtered to hyperlinks both MISSES the semantic target (its popover never triggers, so that field stays empty while other captures succeed) and burns budget on navigation chrome (header/footer links match first in document order before the content you want). The element that RENDERS the wanted value is the natural hover target — scope anchorSel to the card/container and let it match that element (or its nearest wrapper), and when the value lives on a tooltip attached to the timestamp/link that DISPLAYS it, that display element IS the anchor, never a generic link population.
- POPOVER CONTAMINATION FROM PRIOR \$click (cross-step) — auto_discovery picks ANY visible popover-sized posAbsolute element when your popoverSelector doesn't match. Popovers do NOT auto-close between steps. If a PRIOR step's \$click or \$clickInList opened an unrelated popover (a 3-dot action menu, a share dialog, a notifications dropdown), that popover STAYS OPEN and will be picked INSTEAD OF the actual hovercard — returning the WRONG card's htmlSnippet. Two prevention rules:
  (a) BE SPECIFIC IN \$clickInList's BUTTON SELECTOR. Bare \`div[role="button"]\` matches EVERY button inside each list item — including 3-dot action menus, like/share buttons, dropdown triggers. Clicking these opens context menus that contaminate subsequent hover operations in the same flow. Always use a button selector targeting ONLY the intended buttons: \`div[role="button"][aria-label*="more" i]\` for "see more" expanders, \`div[role="button"][aria-label*="comment" i]\` for comment expanders, etc. A bare \`div[role="button"]\` is a STRONG CODE SMELL — it indicates you didn't disambiguate.
  (b) PROVIDE A popoverSelector MATCHING THE HOVERCARD's SPECIFIC [role]. Path (a) explicit-match runs BEFORE auto_discovery and wins immediately on a specific match — use it to bypass the contaminated candidate pool entirely. A popoverSelector like \`div[role="dialog"]\` or \`div[data-hovercard]\` matches the hovercard; if it matches, path (a) wins before auto_discovery even runs. The risk arises ONLY when path (a) doesn't match (popoverSelector wrong or hovercard not yet mounted) and auto_discovery falls back to scoring visible posAbsolute elements — at which point any open menu/nav/bannerpopover with posAbsolute + size + cursor-overlap can win.

ROBUSTNESS RULES (MANDATORY — these prevent the most common silent failures):

1. TIME BUDGET: Every step has a HARD execution timeout (config.timeoutMs, default 30s). A step that runs longer is killed with SCRIPT_TIMEOUT and FAILS. NEVER write a single in-script loop that could exceed the timeout. For long waits, set maxIterations>1 and return { done: false } — each retry iteration is itself bounded by the same timeout and the orchestrator re-invokes the step. Keep each iteration's total sleep+poll well under the timeout.

2. CONTENT-STABILITY COMPLETION: A "done" signal must include CONTENT STABILITY, not just a loading class disappearing — a spinner can vanish while text is still streaming, yielding a truncated extraction. Prefer $waitForStable(selector) (returns true once the element's text stops changing). Or hand-roll: sample the text, sleep ~1.5s, sample again; done only when both samples are equal AND non-empty.

3. VERIFY AFTER INTERACTION: After a $click that is meant to change state (submit, toggle, expand, navigate), VERIFY the intended change happened before reporting done — read a distinguishing signal (results container appeared, attribute toggled, URL changed). If the change did not happen, return { done: false } so the step retries (requires maxIterations>1); do NOT proceed to extraction as if the click succeeded.

4. DISTINGUISH TRANSIENT-EMPTY FROM EXTRACTION-COMPLETED-BUT-EMPTY (critical — misreading this is a top cause of multi-round autoFix failure):
   - (a) TRANSIENT "CONTENT-NOT-YET-PRESENT": the page is still rendering, the list has not entered the DOM yet, or a network pipeline is still pending. SYMPTOMS: zero containers match the list selector, the surrounding page is still showing a spinner / "loading" / partial DOM, or other signals say the page is mid-load. CORRECT RESPONSE: { done: false } (requires maxIterations>1) — the next iteration may catch the content.
   - (b) DETERMINISTIC "EXTRACTION-COMPLETED-BUT-EMPTY": the $extractList / $extractListMulti / $list / $extract call COMPLETED (it returned — possibly an empty array, possibly records whose fields are all empty strings/null because the sub-selectors did not match anything). The page is in steady state — the surrounding DOM is stable, the list container IS present, but the field selectors inside it don't match the page's actual structure. RETRYING IS HARMFUL HERE: the same selectors against the same steady-state DOM produce the same empty result every iteration. CORRECT RESPONSE: return { done: true, <field>: [], ... } (or whatever the (possibly empty) records resolved to). Let the framework's EMPTY_EXTRACTION / EMPTY_FIELDS detectors fire — they feed a data-driven signal into autoFix naming the exact empty fields, which is what allows selector repair.
   WHY IT MATTERS: if you return { done: false } for case (b), the step burns its iteration budget retrying a deterministic outcome → the framework raises POLL_EXHAUSTED (a TIMING signal: "ran out of retries"). That MASKS the underlying EXTRACTION-QUALITY problem (empty fields → selector mismatch) — autoFix sees "poll exhausted, retry timing" instead of "fields empty, fix selector", and starts hallucinating causes (maxIterations too low, missing wait, etc.) instead of repairing selectors. The EMPTY_FIELDS signal (which names the actually-empty fields with contrastive non-empty samples) cannot fire because the step never returns { done: true, <field>:[] }.
   ANTI-PATTERN (do NOT write this — it confuses case (b) for case (a)):
     const records = await $extractList(container, fieldMap, { allowEmpty: true });
     if (!records.length) return { done: false };   // ← WRONG: deterministic empty, masks EMPTY_EXTRACTION behind POLL_EXHAUSTED
     return { done: true, posts: records };
   CORRECT:
     const records = await $extractList(container, fieldMap, { allowEmpty: true });
     return { done: true, posts: records };   // ← empty list is a real signal, let it through
   The same applies to records whose field values are all "" / null after extraction — that is also case (b). Return { done: true, <field>: records } and let the EMPTY_FIELDS detector report which fields are empty across the board. Use { done: false } ONLY when you have POSITIVE EVIDENCE that content is still arriving (spinner still visible, container count still climbing between iterations, etc.) — not as a panic response to empty fields.

5. OUTPUT SCHEMA CONFORMANCE (field names): The final extraction step's return object MUST use the EXACT field names declared in outputSchema.properties, and MUST include every field listed in outputSchema.required. Do NOT invent or rename fields. EXAMPLE: if outputSchema declares a field named "thinking", return { thinking: "..." } — NOT { thinkingProcess: "..." } or { think: "..." }. A field-name mismatch causes the job to be marked FAILED (REQUIRED_OUTPUT_MISSING) even when data was extracted, because external callers read the result by the schema's field names. ECHO-BACK: if outputSchema.required includes a field with the same name as an input field (e.g., question, query), the final return MUST include that field echoing the original input value (e.g., { question: __input__.question, ... }) — do NOT omit it just because it is not "extracted" from the page. Before writing the final return, list outputSchema.required and verify each one is present with the exact name.

6. PER-RECORD SUB-SELECTORS MUST BE SCOPED TO THE CURRENT RECORD (critical — violating this is a top cause of N identical records silently shipped as success):
When iterating a list of records (a for-loop over \`$list(container)\`, or any per-record extraction), each per-field lookup MUST be scoped to the current record element, NOT the whole document. A GLOBAL sub-selector inside a per-record loop returns the SAME first-match on every iteration → every record is populated with the SAME values → the framework's DUPLICATE_RECORDS detector fires and the result is rejected.
ANTI-PATTERN (do NOT write this — produces N IDENTICAL records):
   const articles = await $list('div[role="article"]');
   for (const article of articles) {
     // WRONG: this $list is GLOBAL — returns the same first-match every iteration
     const groupEls = await \$list('div[role="article"] h3 a[href*="/groups/"] span');
     if (groupEls.length > 0) group = groupEls[0].textContent;   // always same first match
     const userEls  = await \$list('div[role="article"] h3 a[href*="/user/"] span');     // WRONG
     const contEls  = await \$list('div[role="article"] div[data-field="content"]');      // WRONG
     posts.push({ group, username, content, ... });   // every post ends up identical
   }
RIGHT (preferred) — use \$extractListMulti with sub-selectors RELATIVE to each container; the framework scopes them per-record automatically:
   const records = await \$extractListMulti('div[role="article"]', {
     group:    'h3 a[href*="/groups/"] span',      // scoped per-article
     username: 'h3 a[href*="/user/"] span',         // scoped per-article
     content:  'div[data-field="content"]'          // scoped per-article
   });
   return { posts: records };
RIGHT (fallback) — if you genuinely cannot use \$extractListMulti and must hand-roll, the \$ API is document-global and \$list returns PLAIN DATA objects (NOT DOM elements). You CANNOT call article.querySelector / article.querySelectorAll / article.closest on items returned by \$list — those properties do not exist on data objects. The ONLY correct hand-rolled pattern is to pre-compute every per-field array with a SEPARATE \$list call scoped by a selector that includes the Nth container's positional prefix (rare; usually wrong due to the CSS TRAP above), OR (much simpler) just call \$extractListMulti:
   const records = await \$extractListMulti('div[role="article"]', {
     group:    'h3 a[href*="/groups/"] span',
     username: 'h3 a[href*="/user/"] span',
     content:  'div[data-field="content"]',
     mediaUrls: { selector: 'img[src*="scontent"]', attr: 'src' }   // multi-match per container → array
   });
   return { posts: records };
NEVER write this (BROKEN — \$list items are not DOM elements):
   const articles = await \$list('div[role="article"]');
   for (const article of articles) {
     article.querySelector(...);     // ❌ TypeError: article.querySelector is not a function
     article.querySelectorAll(...);  // ❌ TypeError: article.querySelectorAll is not a function
   }
Prefer \$extractListMulti — it handles per-record scoping, attribute reads, and empty-value defaults correctly without per-iteration bookkeeping. Hand-rolled \$list loops are a common source of "X is not a function" runtime errors, DUPLICATE_RECORDS, FIELD-NAME-COLLISION, and silent-empty-field bugs that autoFix then has to repair round after round.

7. NEVER RETURN THE SAME SCRIPT (autoFix no-op rule): When you receive a fix request (after ACK), your response MUST actually change the code. Do NOT ACK the hint and then return the same script char-for-char — a no-op fix wastes an autoFix attempt and produces the SAME wrong output again. If you genuinely cannot see how to fix the problem after inspecting the script, the snapshot, and the annotations, use NACK with specifics (e.g., "// NACK: cannot determine username field — the page's profile_name area has no element matching 'Mamur Obaid' in the snapshot I was given; need an annotation on the username element") instead of faking a fix. A NACK surfaces a concrete question to the user; a no-op ACK wastes everyone's time.

ANNOTATION INTENT (use these hints verbatim — do not re-derive):

!!! SELECTOR FIDELITY RULE (CRITICAL — violating this is the #1 cause of broken scripts) !!!
Do NOT simplify, shorten, rewrite, or "improve" selectors from annotations. Use them VERBATIM (character for character, copy-paste into your code). The selector looks long because the page's DOM structure genuinely requires that path. "Simplifying" it to a shorter class-based selector WILL BREAK IT — the shortened version does not exist in the page DOM, causing permanent ELEMENT_NOT_FOUND or false negatives in $exists.
- CORRECT: const done = await $exists('div:nth-of-type(1) > div.\\n._chat-container_r2am5_1…i.cos-icon-copy');
- WRONG:   const done = await $exists('.cs-answer-hover-menu-container i.cos-icon-copy');  // ← invented, does not exist
If a selector contains nth-of-type, CSS module hashes (_xxxxx_N), or newlines, that is EXPECTED — copy it as-is.

CRITICAL: When an annotation has a selector AND a waitCondition, THAT selector is the user's hand-picked completion signal. The user chose it because they know it appears/disappears exactly when the content is ready. Use THAT selector — do NOT search the snapshot for a different loading indicator. This is far more reliable than guessing class names.
- waitCondition: appear → a poll step (maxIterations>1): return { done: await $exists(THE_ANNOTATED_SELECTOR) }. The annotated element appearing = done.
- waitCondition: disappear → a poll step (maxIterations>1): return { done: !await $exists(THE_ANNOTATED_SELECTOR) }. The annotated element vanishing = done.
- waitCondition: textStable → use $waitForStable(THE_ANNOTATED_SELECTOR) to confirm content stopped changing.
- outputField: X on an extract → $extract(THE_ANNOTATED_SELECTOR) and include key X in the return object. Direct mapping; do not rename or use a different selector. DOTTED NOTATION: when outputField is "arrayName.subField" (e.g. "posts.group"), it means each item of the arrayName array has a subField — extract into item[subField], NOT into a literal "arrayName.subField" key. Build the array by iterating the list selector and pushing objects with the mapped sub-fields.
- inputField: X on an input → $type(THE_ANNOTATED_SELECTOR, __input__.X).
- purpose: toggle/submit/navigate on a click → $click(THE_ANNOTATED_SELECTOR) then VERIFY the state changed (per ROBUSTNESS RULE 3).
- purpose: check-login → if the element is present, return { done:true, loginRequired:true } so the orchestrator can surface LOGIN_REQUIRED.
- purpose: expand on a click inside a list → the user wants EVERY list item's expander clicked. Use $clickInList(containerSel, THE_ANNOTATED_SELECTOR) — NOT a single $click. If the user annotated the SAME expand selector in MULTIPLE list items (common case), the derived $clickInList call template above the annotations block already encodes the container; copy it verbatim.`;

const ANNOTATION_PURPOSES = [
  { value: 'submit', label: 'Submit' },
  { value: 'toggle', label: 'Toggle State (e.g. deep-thinking)' },
  { value: 'navigate', label: 'Navigate / Paginate' },
  { value: 'expand', label: 'Expand / Collapse' },
  { value: 'wait-for-load', label: 'Wait for Load' },
  { value: 'check-login', label: 'Check Login State' },
  { value: 'verify-state', label: 'Verify State' },
  { value: 'other', label: 'Other (free text)…' }
];
const WAIT_CONDITIONS = [
  { value: 'appear', label: 'Element Appears' },
  { value: 'disappear', label: 'Element Disappears' },
  { value: 'textStable', label: 'Text Stabilizes' },
  { value: 'attributeChange', label: 'Attribute Changes' }
];

// Build the annotations block fed to the LLM (flat path). When the annotations
// describe a repeating list (multiple entries sharing a dotted outputField like
// "posts.author"), we first derive generalized $extractList / $clickInList
// templates from the shared selector prefix and emit those ABOVE the raw
// per-annotation lines. The LLM is instructed to copy the derived templates
// verbatim — this is the Spec 4 fix for the "flat-zip 18 lines" failure mode
// where the model emits one record per annotation instead of a loop.
// The per-annotation lines always remain (as a fallback / source of truth).
//
// This is the FLAT emitter — it does NOT cluster annotations by container.
// buildAnnotationsText (below) dispatches between multi-sample (≥2 cluster
// samples) and this flat path. Body preserved verbatim from the previous
// buildAnnotationsText so existing LIST EXTRACTION PATTERN + per-annotation
// line tests continue to pass unchanged.
function buildFlatAnnotationsText(annotations) {
  const list = annotations || [];
  const pattern = (typeof deriveListPattern === 'function') ? deriveListPattern(list) : null;
  const blocks = [];

  if (pattern && pattern.patterns && pattern.patterns.length) {
    blocks.push('LIST EXTRACTION PATTERN (derived from ' + pattern.annotationCount + ' annotations — copy these verbatim):');
    for (const p of pattern.patterns) {
      const fields = '{ ' + Object.entries(p.fieldMap)
        .map(([k, v]) => {
          if (typeof v === 'string') return `${k}: '${v}'`;
          const attrPart = v.attr ? `, attr: '${v.attr}'` : '';
          return `${k}: { selector: '${v.selector}'${attrPart} }`;
        })
        .join(', ') + ' }';
      blocks.push(`  $extractList('${p.container}', ${fields})  // produces array of records for output field "${p.outputArray}"`);
    }
    for (const c of pattern.clickInList) {
      blocks.push(`  $clickInList('${c.container}', '${c.subSelector}', { delayMs: ${c.delayMs || 500} })  // ${c.intent}`);
    }
    blocks.push('');
    blocks.push('Per-annotation details (the templates above were derived from these — use them as the source of truth when in doubt):');
  }

  blocks.push(...list.map((a, i) => {
    const tag = `ANNOTATION[${i}]`;
    const parts = ['- ' + tag + ' type: ' + a.type];
    if (a.text) parts.push('text: "' + a.text + '"');
    if (a.selector) parts.push('selector: ' + a.selector + '  ← USE THIS EXACT SELECTOR VERBATIM IN YOUR CODE (do NOT simplify/rewrite)');
    if (a.domPath) parts.push('domPath: ' + a.domPath);
    if (a.purpose) parts.push('purpose: ' + a.purpose);
    if (a.waitCondition) parts.push('waitCondition: ' + a.waitCondition + ' (USER-MARKED completion signal — use THIS selector, not a different loading indicator)');
    if (a.outputField) {
      const parts2 = a.outputField.split('.');
      if (parts2.length >= 3) {
        // Multi-dot path: arrayName.objectField.leafField (e.g.
        // posts.groupInfo.groupName). Build explicit nested guidance so the
        // LLM places the value at item.objectField.leafField, not at a
        // literal "a.b.c" key.
        const arrName = parts2[0];
        const leaf = parts2[parts2.length - 1];
        const middle = parts2.slice(1, -1).join('.');
        parts.push('outputField: ' + a.outputField + ' (extract using the selector above into the "' + leaf + '" field of the "' + middle + '" object inside EACH item in the "' + arrName + '" array — NOT into a literal dotted key)');
      } else if (parts2.length === 2) {
        const arrName = parts2[0];
        const subField = parts2[1];
        parts.push('outputField: ' + a.outputField + ' (extract using the selector above into the "' + subField + '" field of EACH item in the "' + arrName + '" array — NOT into a literal dotted key)');
      } else {
        parts.push('outputField: ' + a.outputField + ' (extract using the selector above into this field)');
      }
    }
    if (a.inputField) parts.push('inputField: ' + a.inputField + ' (type into the selector above using __input__.' + a.inputField + ')');
    return parts.join(', ');
  }));
  return blocks.join('\n');
}

// Build the annotations block fed to the LLM. Dispatches on
// clusterAnnotationsByContainer's sample count:
//   - ≥2 samples → multi-sample block (buildMultiSampleText) so the LLM
//     sees that the user annotated multiple list-item shapes and reasons
//     about per-shape selector differences.
//   - ≤1 sample → flat format (buildFlatAnnotationsText, the previous
//     implementation) so existing LIST EXTRACTION PATTERN + per-annotation
//     lines continue working for backward compatibility.
function buildAnnotationsText(annotations) {
  const list = annotations || [];
  const clustered = (typeof clusterAnnotationsByContainer === 'function')
    ? clusterAnnotationsByContainer(list)
    : { samples: [], supplemental: list };

  if (clustered.samples.length >= 2) {
    return buildMultiSampleText(clustered);
  }
  return buildFlatAnnotationsText(list);
}

// Multi-sample annotation text emitter. Implemented in subsequent tasks
// (header + per-sample blocks, cross-sample observations, supplemental block).
function buildMultiSampleText(clustered) {
  const blocks = [];
  blocks.push(`ANNOTATION SAMPLES (${clustered.samples.length} distinct list items annotated — fields may differ across shapes; account for per-shape selector differences):`);
  blocks.push('');
  clustered.samples.forEach((sample, idx) => {
    const confTag = sample.confidence === 'low'
      ? ' [LOW CONFIDENCE — branching segment does not match known list-item patterns]'
      : '';
    blocks.push(`[SAMPLE ${idx + 1} — annotations on one list item (${sample.containerTag || 'unknown'})${confTag}]`);
    for (const a of sample.annotations) {
      blocks.push(formatAnnotationLine(a));
    }
    blocks.push('');
  });
  const observations = deriveCrossSampleObservations(clustered.samples);
  if (observations.length) {
    blocks.push('CROSS-SAMPLE OBSERVATIONS (framework-derived):');
    for (const line of observations) blocks.push('- ' + line);
    blocks.push('');
  }
  if (clustered.supplemental && clustered.supplemental.length) {
    blocks.push('SUPPLEMENTAL ANNOTATIONS (outside list items — likely interaction-triggered; treat as enrichment hints):');
    clustered.supplemental.forEach(a => blocks.push(formatAnnotationLine(a)));
    blocks.push('');
  }
  return blocks.join('\n');
}

// Classify each outputField that appears in the samples:
//   UNIVERSAL: appears in all samples with the SAME (cleaned) selector
//   SHAPE-DEPENDENT: appears in all samples with DIFFERENT selectors
//   OPTIONAL: appears in only some samples
// Returns an array of human-readable lines for the prompt.
function deriveCrossSampleObservations(samples) {
  const fieldMap = new Map(); // field -> [{ sampleIdx, selector }]
  samples.forEach((s, idx) => {
    for (const a of s.annotations) {
      if (!a || !a.outputField) continue;
      if (!fieldMap.has(a.outputField)) fieldMap.set(a.outputField, []);
      fieldMap.get(a.outputField).push({ sampleIdx: idx, selector: a.selector || '' });
    }
  });
  const lines = [];
  for (const [field, entries] of fieldMap) {
    const sampleCount = new Set(entries.map(e => e.sampleIdx)).size;
    if (sampleCount === samples.length) {
      const selectors = new Set(entries.map(e => e.selector));
      if (selectors.size === 1) {
        lines.push(`UNIVERSAL field: ${field} (same selector in all ${samples.length} samples)`);
      } else {
        lines.push(`SHAPE-DEPENDENT field: ${field} (present in all samples but selectors differ)`);
      }
    } else {
      lines.push(`OPTIONAL field: ${field} (only in ${sampleCount} of ${samples.length} samples)`);
    }
  }
  return lines;
}

// Format one annotation as a single line (no leading ANNOTATION[N] tag —
// the multi-sample block already provides sample context).
function formatAnnotationLine(a) {
  const parts = ['- type: ' + (a.type || 'extract')];
  if (a.outputField) parts.push('outputField: ' + a.outputField);
  if (a.selector) parts.push('selector: ' + a.selector);
  if (a.purpose) parts.push('purpose: ' + a.purpose);
  return parts.join(', ');
}

// DEPRECATED — kept as a no-op for backward compatibility with older tests.
//
// Previously this performed a verbatim-substring check that punished the LLM
// for not using annotated selectors verbatim. That was counterproductive:
// when the annotation itself was brittle (long nth-of-type chain), the LLM
// was doing the RIGHT thing by dropping it in favor of a stable selector
// like div[role="article"]. The new approach is scoreAnnotationChain,
// which warns the USER when the annotation is fragile instead of accusing
// the LLM. See wizard.js deploy hook for the new call site.
function checkSelectorFidelity(script, annotations) {
  return { ok: true, mismatches: [] };
}

function parseSchemaFields(schema) {
  return Object.keys(schema.properties || {}).map(k => `${k} (${schema.properties[k].type || '?'})`).join(', ') || 'none';
}

// Single source of truth for the per-step timeout wording given to the LLM.
// Every generation/fix prompt calls this so generation, auto-fix, test, and deploy
// all agree on the ceiling (default 30s = deploy config.timeoutMs).
function buildTimeoutGuidance(timeoutMs) {
  const t = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000;
  const seconds = Math.floor(t / 1000);
  const iterBudget = Math.max(3, Math.floor((t * 0.75) / 3000));
  const iterSeconds = Math.min(iterBudget * 3, Math.floor(seconds * 0.75));
  return {
    ceilingMs: t,
    text: `CRITICAL TIME CONSTRAINT:
Each step script has a HARD execution timeout of ${seconds}s (${t}ms). The script MUST return before ${seconds}s; otherwise the executor kills it with SCRIPT_TIMEOUT and the step FAILS.
- NEVER write a single in-script loop that runs longer than ${seconds}s. For long waits, set maxIterations>1 and return { done: false } — each retry iteration is itself bounded by this same ${seconds}s ceiling and the orchestrator re-invokes the step.
- For polling inside one iteration: use at most ${iterBudget} checks with >=3s delays (total ~${iterSeconds}s), staying under ${seconds}s.
- Use $exists(selector, 1000) for quick existence checks; use $wait(selector) for one-shot waits up to 30s.
- If a logical unit genuinely needs longer than ${seconds}s, split it across retry iterations (maxIterations>1 + { done: false }) — do NOT raise the timeout by sleeping longer.`
  };
}

function buildIORenderString(inputSchema, outputSchema) {
  return 'Input: ' + parseSchemaFields(inputSchema || {}) + ' | Output: ' + parseSchemaFields(outputSchema || {});
}

// $extractWithHover burns ~5-10s per hovered anchor in time-bounded waits
// (not network), so the default 60s ceiling deterministically kills a
// 5-container batch mid-pipeline. Raise the per-step ceiling for services
// that use it. max() semantics: never lower an explicit higher config.
function hoverAwareTimeoutMs(steps, baseMs) {
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 30000;
  const usesHoverPipeline = (steps || []).some(s => /\$extractWithHover\s*\(/.test(s.script || ''));
  return usesHoverPipeline ? Math.max(base, 120000) : base;
}

// console.log 2026-08-23 (search-feed site): step 3's $clickInList clicked 0,
// errored on all 10 containers, and returned done:true — the requirement's
// expand action silently no-opped. Detects the total failure from
// STEP_ITERATION events (framework-level diagnostics), independent of which
// fields the LLM chose to surface in its step result. Fires only on TOTAL
// failure: containers matched, every call clicked nothing, and no later
// iteration of the same step recovered.
function detectClickInListTotalFailure(events) {
  if (!Array.isArray(events)) return null;
  const perStep = new Map();
  for (const evt of events) {
    if (!evt || evt.type !== 'STEP_ITERATION') continue;
    const diags = Array.isArray(evt.selectorDiagnostics) ? evt.selectorDiagnostics : [];
    for (const d of diags) {
      if (!d || d.api !== 'clickInList' || !(d.containerMatches > 0)) continue;
      if (!perStep.has(evt.stepId)) {
        perStep.set(evt.stepId, { stepId: evt.stepId, calls: 0, clicked: 0, errorCount: 0, notFoundCount: 0, containerMatches: 0, subSelector: null });
      }
      const agg = perStep.get(evt.stepId);
      agg.calls += 1;
      agg.clicked += (d.clicked || 0);
      agg.errorCount += (d.errorCount || 0);
      agg.notFoundCount += (d.notFoundCount || 0);
      if (!agg.containerMatches) agg.containerMatches = d.containerMatches;
      if (!agg.subSelector && d.subSelector) agg.subSelector = d.subSelector;
    }
  }
  for (const agg of perStep.values()) {
    if (agg.calls > 0 && agg.clicked === 0) return agg;
  }
  return null;
}

// console.log 2026-08-23 14:51:59 (second session): step 3's $clickInList
// used the never-fixed rigid container selector — 0 containers matched, so
// clickInListItems iterated an empty array: clicked 0 AND errors 0. The
// subSel detector above requires containerMatches>0 and stayed silent (its
// message would have been misleading). This detector covers the other half:
// every clickInList call saw ZERO containers. The remedy differs too — the
// CONTAINER selector (often shared with sibling steps) is what needs fixing.
function detectClickInListEmptyContainers(events) {
  if (!Array.isArray(events)) return null;
  const perStep = new Map();
  for (const evt of events) {
    if (!evt || evt.type !== 'STEP_ITERATION') continue;
    const diags = Array.isArray(evt.selectorDiagnostics) ? evt.selectorDiagnostics : [];
    for (const d of diags) {
      if (!d || d.api !== 'clickInList') continue;
      if (!perStep.has(evt.stepId)) {
        perStep.set(evt.stepId, { stepId: evt.stepId, calls: 0, nonEmptyCalls: 0, containerSelector: null, subSelector: null });
      }
      const agg = perStep.get(evt.stepId);
      agg.calls += 1;
      if ((d.containerMatches || 0) > 0) agg.nonEmptyCalls += 1;
      if (!agg.containerSelector && d.containerSelector) agg.containerSelector = d.containerSelector;
      if (!agg.subSelector && d.subSelector) agg.subSelector = d.subSelector;
    }
  }
  for (const agg of perStep.values()) {
    if (agg.calls > 0 && agg.nonEmptyCalls === 0) return agg;
  }
  return null;
}

// Forty-eighth log: v6's verify was vetoed by CLICK_CONTAINERS_EMPTY — the
// expand step's $clickInList ran before the feed mounted (container matched
// 0) while the SAME run's extract step matched the SAME container selector
// on every call — a mount-timing transient flipped a completed run red. A
// zero-match clickInList container is only a REAL selector failure when the
// rest of the run agrees the container never appears; a later same-run
// container-scoped match on the identical selector proves mount timing and
// downgrades the gate to an advisory.
function corroborateContainerZero(events, agg) {
  if (!Array.isArray(events) || !agg || !agg.containerSelector) return null;
  const target = agg.containerSelector;
  let flat = 0;
  let zeroPos = -1;
  const later = [];
  for (const evt of events) {
    if (!evt || evt.type !== 'STEP_ITERATION') continue;
    const diags = Array.isArray(evt.selectorDiagnostics) ? evt.selectorDiagnostics : [];
    for (const d of diags) {
      if (d) {
        if (d.api === 'clickInList') {
          if (zeroPos === -1 && d.containerSelector === target && (d.containerMatches || 0) === 0) zeroPos = flat;
        } else {
          const n = typeof d.containerMatches === 'number' ? d.containerMatches : 0;
          later.push({ pos: flat, stepId: evt.stepId, api: d.api, matches: n, sel: d.containerSelector });
        }
      }
      flat += 1;
    }
  }
  if (zeroPos === -1) return null;
  const matches = [];
  const seen = new Set();
  for (const m of later) {
    if (m.pos <= zeroPos) continue;
    if (m.sel !== target || m.matches <= 0) continue;
    const key = m.stepId + '|' + m.api + '|' + m.matches;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ stepId: m.stepId, api: m.api, containerMatches: m.matches });
    if (matches.length >= 3) break;
  }
  return matches.length ? matches : null;
}

// console.log 2026-08-23 14:44-14:48 (second session): step 2 polled 20
// iterations at {done:false, uniqueCount:0} while its $list counting selector
// matched 0 elements on EVERY iteration — the page visibly filled with posts
// the script could not see, and the only signal reaching autoFix was the
// generic POLL_EXHAUSTED. The LLM then guessed at causes. This detector runs
// post-hoc over the full STEP_ITERATION history: a step is COUNT-blind when
// (a) >= 3 not-ready iterations carried selector diagnostics, (b) EVERY one
// of those diagnostics matched 0, and (c) no later iteration ever matched
// anything (a recovered step was slow-render, not blind — run 3 of the same
// log recovered on iteration 5 and MUST NOT fire). "Every selector matched 0"
// means the script saw NOTHING on the page it queried for; a step where the
// container matched but the item selector didn't is NOT blind — that partial
// evidence is already surfaced per-selector by summarizeAllStepDiagnostics.
function detectCountSelectorBlind(events) {
  if (!Array.isArray(events)) return null;
  const perStep = new Map();
  for (const evt of events) {
    if (!evt || evt.type !== 'STEP_ITERATION') continue;
    const stepId = evt.stepId;
    if (stepId == null) continue;
    if (!perStep.has(stepId)) {
      perStep.set(stepId, { stepId, iterations: 0, blindIterations: 0, selectors: new Map(), recovered: false });
    }
    const agg = perStep.get(stepId);
    agg.iterations += 1;
    const diags = Array.isArray(evt.selectorDiagnostics) ? evt.selectorDiagnostics : [];
    if (diags.length === 0) continue; // no evidence this iteration — can't judge
    let anyMatch = false;
    for (const d of diags) {
      if (!d) continue;
      const sel = d.selector || d.containerSelector || null;
      const count = (typeof d.matchCount === 'number') ? d.matchCount
        : (typeof d.containerMatches === 'number') ? d.containerMatches : null;
      if (sel && !agg.selectors.has(sel)) agg.selectors.set(sel, 0);
      if (sel && typeof count === 'number') agg.selectors.set(sel, agg.selectors.get(sel) + count);
      if (typeof count === 'number' && count > 0) anyMatch = true;
    }
    if (anyMatch) {
      agg.recovered = true; // saw real content at some point — never blind
      continue;
    }
    // All selectors matched 0 this iteration. Only not-ready (polling)
    // iterations count: a done:true with 0 matches is EMPTY_EXTRACTION's
    // domain, not scroll-blindness.
    if (/"done"\s*:\s*false/.test(String(evt.resultPreview || ''))) {
      agg.blindIterations += 1;
    }
  }
  for (const agg of perStep.values()) {
    if (agg.blindIterations >= 3 && !agg.recovered) {
      return { stepId: agg.stepId, iterations: agg.iterations, blindIterations: agg.blindIterations, selectors: [...agg.selectors.keys()] };
    }
  }
  return null;
}

// console.log 2026-08-31 16:06-16:15 (fourth session): after a user-feedback
// autoFix rewrote the scroll counter to count only permalink-bearing cards,
// the permalink regex matched 0 hrefs on EVERY card — uniqueCount stayed 0 for
// 33 straight not-ready iterations (~9.5 min of scrolling the user watched
// and finally aborted). The selector diagnostics saw nothing wrong (the
// containers themselves match; the SCRIPT-LEVEL JS filter zeroed the count),
// and the exhausted exit was guarded by `&& uniqueCount > 0`, making it
// unreachable at count 0. This detector covers the half COUNT_SELECTOR_BLIND
// cannot see: the script's own result announces a counter field stuck at 0.
// Fires when a step's not-ready iterations carried counter fields that were
// 0 on EVERY occurrence and never once positive (a count that went positive
// then froze is a stall the script's own noGrowth handles — not a trap).
const FROZEN_ZERO_STREAK_THRESHOLD = 8;

// The live breaker additionally requires the streak to SPAN this long:
// iteration cadence varies wildly (2s wait-steps vs 17s scroll-steps in one
// log), so a count-only threshold fires at 16s on a fast-cadence step and
// misdiagnoses a slowly-rendering page as a broken counting filter. Steps
// with a small maxIterations fall through to natural POLL_EXHAUSTED, where
// the post-hoc detectFrozenZeroCounter relabels with the same guidance.
const FROZEN_ZERO_MIN_ELAPSED_MS = 60000;

// Parse one resultPreview for counter-shaped numeric fields. A counter name
// ends with "count" (uniqueCount, postCount, newCount, ...) or is one of the
// bare aggregate names. Control fields (noGrowth, stalled, iteration, ...)
// are deliberately excluded — they legitimately count failures, not content.
function parseCounterFields(resultPreview) {
  const out = { zero: [], positive: [] };
  const s = String(resultPreview || '');
  if (!s) return out;
  const re = /"([A-Za-z_$][A-Za-z0-9_$]*)"\s*:\s*(-?\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const name = m[1];
    const isCounter = /count$/i.test(name) || /^(total|matched|found|loaded)$/i.test(name);
    if (!isCounter) continue;
    const val = Number(m[2]);
    if (val > 0) out.positive.push(name);
    else if (val === 0) out.zero.push(name);
  }
  return out;
}

// isFrozenZeroNotReady(resultPreview): the iteration is a poll retry whose
// counters are all zero. Previews without counter fields are "no evidence" —
// neither frozen nor recovering.
function isFrozenZeroNotReady(resultPreview) {
  const s = String(resultPreview || '');
  if (!/"done"\s*:\s*false/.test(s)) return false;
  const c = parseCounterFields(s);
  return c.zero.length > 0 && c.positive.length === 0;
}

function detectFrozenZeroCounter(events) {
  if (!Array.isArray(events)) return null;
  const perStep = new Map();
  for (const evt of events) {
    if (!evt || evt.type !== 'STEP_ITERATION') continue;
    const stepId = evt.stepId;
    if (stepId == null) continue;
    if (!perStep.has(stepId)) {
      perStep.set(stepId, {
        stepId: stepId, iterations: 0, frozenIterations: 0,
        counterFields: new Set(), everPositive: false, selectorMatchedSomething: false
      });
    }
    const agg = perStep.get(stepId);
    agg.iterations += 1;
    const counters = parseCounterFields(evt.resultPreview);
    if (counters.positive.length > 0) {
      agg.everPositive = true; // saw real content — never a zero-trap
    }
    for (const z of counters.zero) agg.counterFields.add(z);
    if (isFrozenZeroNotReady(evt.resultPreview)) agg.frozenIterations += 1;
    // Selector evidence distinguishes the two zero classes: selectors
    // matching while counters stay 0 PROVES a script-level filter trap
    // (COUNT_SELECTOR_BLIND is the other class — selectors themselves 0).
    const diags = Array.isArray(evt.selectorDiagnostics) ? evt.selectorDiagnostics : [];
    for (const d of diags) {
      if (!d) continue;
      const count = (typeof d.matchCount === 'number') ? d.matchCount
        : (typeof d.containerMatches === 'number') ? d.containerMatches : null;
      if (typeof count === 'number' && count > 0) agg.selectorMatchedSomething = true;
    }
  }
  for (const agg of perStep.values()) {
    if (agg.frozenIterations >= FROZEN_ZERO_STREAK_THRESHOLD && !agg.everPositive) {
      return {
        stepId: agg.stepId,
        iterations: agg.iterations,
        frozenIterations: agg.frozenIterations,
        counterFields: [...agg.counterFields],
        selectorMatchedSomething: agg.selectorMatchedSomething
      };
    }
  }
  return null;
}

// Forty-ninth log (2026-09-09): the frozen-NONZERO scroll stall had no
// detector — detectFrozenZeroCounter owns the all-zero trap (fourth log),
// while the verify's feed count froze at 2 for seven iterations, jumped to
// 8, then froze for ten more and the model rewrote the scroll step seven
// times with no evidence. The trailing-streak shape distinguishes "growth
// stopped mid-run" (grewFrom set — the page DID load more once) from
// "never moved".
function parsePositiveCounterValues(resultPreview) {
  const out = [];
  const s = String(resultPreview || '');
  if (!s) return out;
  const re = /"([A-Za-z_$][A-Za-z0-9_$]*)"\s*:\s*(-?\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const name = m[1];
    const isCounter = /count$/i.test(name) || /^(total|matched|found|loaded)$/i.test(name);
    if (!isCounter) continue;
    const val = Number(m[2]);
    if (val > 0) out.push([name, val]);
  }
  return out;
}

const FROZEN_NONZERO_STREAK_THRESHOLD = 4;

function detectFrozenScrollCount(events) {
  if (!Array.isArray(events)) return [];
  let anyScrollApi = false;
  const perField = new Map();
  for (const evt of events) {
    if (!evt || evt.type !== 'STEP_ITERATION') continue;
    const diags = Array.isArray(evt.selectorDiagnostics) ? evt.selectorDiagnostics : [];
    for (const d of diags) {
      if (d && d.api && /scroll/i.test(String(d.api))) anyScrollApi = true;
    }
    if (evt.stepId == null) continue;
    const s = String(evt.resultPreview || '');
    const pairs = parsePositiveCounterValues(s);
    if (!pairs.length) continue;
    // Fiftieth log: done:false previews build the streak, but EVERY mention of
    // the counter (done:true included) updates lastMention — a later mention at
    // a different value, or a done:true at any value, proves the freeze
    // RESOLVED itself (the feed mounts in bursts; a poll can sit at 2 for six
    // iterations then jump to 5 and succeed). Tagging a resolved freeze on a
    // green run trains the model to ignore the tag.
    const doneTrue = /"done"\s*:\s*true/.test(s);
    const doneFalse = /"done"\s*:\s*false/.test(s);
    for (const pair of pairs) {
      const key = evt.stepId + '.' + pair[0];
      if (!perField.has(key)) perField.set(key, { stepId: evt.stepId, field: pair[0], values: [], lastMention: { value: pair[1], done: doneTrue } });
      const agg = perField.get(key);
      agg.lastMention = { value: pair[1], done: doneTrue };
      if (doneFalse) agg.values.push(pair[1]);
    }
  }
  // No scroll API anywhere in the run → a frozen poll is the
  // poll-exhaustion class (seventeenth log), not a scroll stall.
  if (!anyScrollApi) return [];
  const out = [];
  for (const agg of perField.values()) {
    const vals = agg.values;
    if (vals.length < FROZEN_NONZERO_STREAK_THRESHOLD) continue;
    const last = vals[vals.length - 1];
    if (!(last > 0)) continue;
    // Fiftieth log: the freeze must be TERMINAL — the last time this counter
    // was mentioned it equaled the frozen value AND was still not-ready.
    if (agg.lastMention.done || agg.lastMention.value !== last) continue;
    let streak = 0;
    for (let i = vals.length - 1; i >= 0; i--) {
      if (vals[i] === last) streak++; else break;
    }
    if (streak < FROZEN_NONZERO_STREAK_THRESHOLD) continue;
    const prevIdx = vals.length - streak - 1;
    const grewFrom = (prevIdx >= 0 && vals[prevIdx] !== last) ? vals[prevIdx] : null;
    out.push({
      stepId: agg.stepId,
      field: agg.field,
      frozenCount: last,
      streak: streak,
      iterations: vals.length,
      grewFrom: grewFrom
    });
  }
  return out;
}

// Forty-ninth log: the green v7 shipped the SAME owner id as postId on three
// records (plus two empty) — repeated identity values are the fingerprint of
// an extractor that fell back to a value every record shares instead of a
// per-record identifier. Report-only: names the duplicated value and the
// record ordinals so the failing records can be re-probed directly.
function detectDuplicateIdValues(data, schema) {
  const out = [];
  if (!data || typeof data !== 'object') return out;
  const props = (schema && schema.properties) || {};
  for (const arrField of Object.keys(props)) {
    const prop = props[arrField];
    if (!prop || prop.type !== 'array' || !prop.items || prop.items.type !== 'object') continue;
    const records = data[arrField];
    if (!Array.isArray(records) || records.length < 2) continue;
    const itemProps = (prop.items && prop.items.properties) || {};
    for (const field of Object.keys(itemProps)) {
      if (!/id$/i.test(field)) continue; // identity-semantic names only
      const seen = new Map();
      for (let i = 0; i < records.length; i++) {
        const v = records[i] ? records[i][field] : null;
        if (typeof v !== 'string' || !v) continue; // empties belong to the empty-ratio census
        if (!seen.has(v)) seen.set(v, []);
        seen.get(v).push(i + 1);
      }
      for (const value of seen.keys()) {
        const indices = seen.get(value);
        if (indices.length < 2) continue;
        out.push({
          path: arrField + '.' + field,
          field: field,
          value: value.length > 80 ? value.slice(0, 80) + '…' : value,
          count: indices.length,
          totalRecords: records.length,
          indices: indices.slice(0, 6),
          note: 'an id-like value shared by ' + indices.length + ' of ' + records.length + ' records usually means the extractor fell back to a container-level shared value (e.g. the list owner id) instead of a per-record identifier — re-probe the listed records; per-record ids live on per-record elements (links/attrs inside each card), not on the shared container'
        });
      }
    }
  }
  return out;
}
// Fiftieth log: likes read empty on every record while shares extracted real
// values from the SAME action-bar family — the family demonstrably renders
// counts, so the empty field's value lives outside textContent (an aria-label
// attribute or an aria-labelledby-referenced hidden span, the mechanism
// timestamp anchors use). No census contrasted sibling count fields, so the
// model shipped empty after two textContent probes. Report-only: the
// populated sibling is the proof that "unextractable" was premature.
const COUNT_LIKE_SUFFIX_RE = /(?:count|total|tally|num(?:ber)?)$/i;
const COUNT_LIKE_WORD_RE = /^(likes?|comments?|shares?|replies|views?|votes?|reposts?|retweets?|forwards?|favorites?|favourites?|upvotes?|downvotes?|downloads?|plays|subscribers?|followers)$/i;
function isCountLikeFieldName(name) {
  const n = String(name || '');
  return COUNT_LIKE_SUFFIX_RE.test(n) || COUNT_LIKE_WORD_RE.test(n);
}

function detectSiblingCountContrast(data, schema) {
  const out = [];
  if (!data || typeof data !== 'object') return out;
  const props = (schema && schema.properties) || {};
  for (const arrField of Object.keys(props)) {
    const prop = props[arrField];
    if (!prop || prop.type !== 'array' || !prop.items || prop.items.type !== 'object') continue;
    const records = data[arrField];
    if (!Array.isArray(records) || records.length < 2) continue;
    const itemProps = (prop.items && prop.items.properties) || {};
    const countFields = Object.keys(itemProps).filter(isCountLikeFieldName);
    if (countFields.length < 2) continue; // no sibling to contrast against
    const stats = new Map();
    for (const f of countFields) {
      let empty = 0;
      let sample = null;
      for (const r of records) {
        const v = r ? r[f] : undefined;
        const str = (typeof v === 'string') ? v.trim() : (v == null ? '' : String(v));
        if (!str) empty++;
        else if (sample == null) sample = str.slice(0, 40);
      }
      stats.set(f, { empty: empty, ratio: empty / records.length, sample: sample });
    }
    for (const f of countFields) {
      const me = stats.get(f);
      if (!(me.ratio >= 0.6)) continue;
      let sib = null;
      for (const g of countFields) {
        if (g === f) continue;
        const st = stats.get(g);
        if (st.ratio <= 0.4 && st.sample != null) { sib = { field: g, sample: st.sample }; break; }
      }
      if (!sib) continue;
      out.push({
        field: f,
        path: arrField + '.' + f,
        emptyRatio: Math.round(me.ratio * 100) / 100,
        populatedSibling: sib.field,
        siblingSample: sib.sample,
        note: 'sibling count field ' + sib.field + ' extracts real values (e.g. ' + JSON.stringify(sib.sample) + ') from the same record family while this one reads empty — the family DOES render counts, so the empty value typically lives OUTSIDE textContent: read the aria-label ATTRIBUTE (probe.attrStats {containerSel, attr:"aria-label"} over the element family) or the aria-labelledby reference (probe.labelledby on the empty field\'s element — the same hidden-span mechanism timestamp anchors use), then bind the field spec {attr:"aria-label"} or {labelledby:true}; renegotiate the field away only after both routes falsify'
      });
    }
  }
  return out;
}


// console.log 2026-08-23 16:13-16:15 (third session): the session ran green
// end-to-end, but every record had hovercards:[] — and a user-feedback
// autoFix round could not repair it because the true cause was invisible.
// $extractWithHover enumerates anchors with container.querySelectorAll(
// anchorSel); when anchorSel matches 0 elements inside every container the
// hover function is NEVER invoked, so each record gets hovercards:[] with
// ZERO entries — indistinguishable in the output from "hovered but no card
// appeared". hoverSummary.anchorsFound:0 was present in the diagnostics
// channel all along; nothing consumed it. Fires when EVERY extractWithHover
// call that processed containers found 0 anchors and no call ever matched an
// anchor (matched-anywhere ⇒ not blind). Calls with processedContainers===0
// are excluded from the blind judgment (container-empty is the
// CLICK_CONTAINERS_EMPTY failure class with a different remedy).


// Fifty-second log: the confirmed outputSchema carried likes/comments/shares/
// htmlSnippet/hoverCards declared at the ARRAY-ITEMS level, OUTSIDE the
// object's "properties" — malformed, and admitted everywhere. The strays were
// invisible to every schema-driven gate: the never-extracted lint enumerated
// only properties keys (so `role: ''` sat hardcoded through SEVEN artifact
// versions with no receipt naming it — the nested hoverCards recursion never
// ran), required-coverage and the empty/junk censuses never read them. A stray
// declaration is an object value with schema shape (type/properties/items/
// required keys) sitting under a key that is NOT a JSON-Schema keyword.
const SCHEMA_KEYWORD_ALLOWLIST = {
  type: 1, properties: 1, required: 1, items: 1, description: 1, title: 1,
  examples: 1, default: 1, enum: 1, const: 1, additionalProperties: 1,
  anyOf: 1, oneOf: 1, allOf: 1, not: 1, '$schema': 1, '$id': 1, '$ref': 1,
  '$defs': 1, definitions: 1, minimum: 1, maximum: 1, exclusiveMinimum: 1,
  exclusiveMaximum: 1, minLength: 1, maxLength: 1, minItems: 1, maxItems: 1,
  pattern: 1, format: 1, multipleOf: 1, uniqueItems: 1, patternProperties: 1,
  propertyNames: 1, dependencies: 1, dependentRequired: 1, dependentSchemas: 1,
  nullable: 1, deprecated: 1, readOnly: 1, writeOnly: 1
};

function detectStrayFieldDeclarations(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const byPath = new Map();
  const visit = (node, path) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const k of Object.keys(node)) {
      if (SCHEMA_KEYWORD_ALLOWLIST[k]) continue;
      const v = node[k];
      if (v && typeof v === 'object' && !Array.isArray(v) &&
          (('type' in v) || ('properties' in v) || ('items' in v) || ('required' in v))) {
        if (!byPath.has(path)) byPath.set(path, []);
        byPath.get(path).push(k);
      }
    }
    if (node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)) {
      for (const pk of Object.keys(node.properties)) visit(node.properties[pk], path + '.' + pk);
    }
    if (node.items && typeof node.items === 'object' && !Array.isArray(node.items)) {
      visit(node.items, path + '[]');
    }
  };
  visit(schema, '$');
  if (!byPath.size) return null;
  const hits = [];
  for (const p of Array.from(byPath.keys())) {
    hits.push({ at: p, strays: byPath.get(p).sort() });
  }
  return hits;
}

// Fifty-second log: postTime shipped as "m.meCatMachine Learning (ML)
// Explained | Types…" — the labelledby resolution of the WRONG anchor (its
// referenced texts concatenate: redirect domains + page title). The value has
// no date/time shape, but the relative-timestamp/empty/junk censuses all
// passed it: not relative, not empty, not a junk token. A time-NAMED field
// whose non-empty values mostly carry no date shape is an implausible bind.
const TIME_FIELD_NAME_RE = /(?:time|date|posted|created|published|updated|timestamp)/i;
const TIME_SHAPE_RES = [
  /(?:january|february|march|april|may|june|july|august|september|october|november|december)/i,
  /\d{1,2}:\d{2}/,
  /\b\d+\s*(?:second|sec|minute|min|hour|hr|day|week|month|year)s?\b/i,
  /\b(?:second|minute|hour|day|week|month|year)s?\s+ago\b/i,
  /\d{4}[-/]\d{1,2}[-/]\d{1,2}/,
  /\d{4}\s*年/,
  /[0-9一二三四五六七八九十百千]+\s*(?:秒|分钟|分|小时|时|天|日|周|月|年)/
];

function looksLikeDate(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return true; // empties belong to the partial-empty census
  for (const re of TIME_SHAPE_RES) {
    if (re.test(s)) return true;
  }
  return false;
}

// Sixty-ninth log: full-vs-partial ABSOLUTE classification. "August 2" is a
// month-day WITHOUT a year — date-shaped, not relative, and the binary
// relative flag blessed it as a full absolute while the hover tooltip carried
// "August 2, 2024 at 3:14 PM". Calendar-generic year tokens only: a 4-digit
// 19xx/20xx number or a CJK 年 year. No site vocabulary.
function hasYearToken(v) {
  const s = String(v == null ? '' : v);
  return /\b(?:19|20)\d{2}\b/.test(s) || /\d{4}\s*年/.test(s);
}

// Sixty-fourth log: whole-string date predicates (looksLikeDate) answer "is
// this FIELD plausibly a time field" — containment is enough there. But
// probe.timestamp used the same predicate as a VALUE gate, and prose that
// merely MENTIONS a duration ("…solve the first Millennium Prize Problem in
// 20 years—the field's gr…") passed via \b\d+\s*years\b and shipped in the
// ABSOLUTE slot. Long strings are prose, not dates; what they can still
// offer is date-shaped SUBSTRINGS (the hover-mounted tooltip's snippet
// carries "Friday, September 11, 2026 at 1:43 AM" inside popover markup).
// Extraction patterns are calendar-generic (ISO / month-name / slash / CJK
// absolute; "N units ago" / CJK relative) — no site vocabulary.
var DATE_SUBSTRING_RES = [
  /\d{4}-\d{1,2}-\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?)?/g,
  /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}(?:[ ,]+at[ ,]+\d{1,2}:\d{2}\s*(?:AM|PM|am|pm))?/g,
  /\b\d{1,2}\/\d{1,2}\/\d{4}(?:\s+\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?)?/g,
  /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日(?:\s*\d{1,2}:\d{2})?/g,
  /\b\d+\s*(?:second|minute|hour|day|week|month|year)s?\s+ago\b/g,
  // Substring extraction requires the 前 marker — without it every date
  // FRAGMENT ("25日", "6月") inside an absolute CJK date becomes its own
  // (mis-classified relative) candidate. Whole-string tests keep the
  // looser TIME_SHAPE_RES form.
  /[0-9一二三四五六七八九十百千]+\s*(?:秒|分钟|分|小时|时|天|日|周|月|年)\s*前/g
];
function extractDateSubstrings(text) {
  const s = String(text == null ? '' : text);
  if (!s) return [];
  const out = [];
  const seen = new Set();
  for (const re of DATE_SUBSTRING_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      const v = m[0].replace(/\s+/g, ' ').trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
  }
  // A candidate fully contained in another candidate is a fragment of it
  // (the CJK fragment class above, or a month+year inside a full date).
  return out.filter((v) => !out.some((w) => w !== v && w.includes(v)));
}

function detectImplausibleTimeFields(data, schema) {
  const out = [];
  if (!data || typeof data !== 'object') return null;
  const props = (schema && schema.properties) || {};
  for (const arrField of Object.keys(props)) {
    const prop = props[arrField];
    if (!prop || prop.type !== 'array' || !prop.items || prop.items.type !== 'object') continue;
    const records = data[arrField];
    if (!Array.isArray(records) || records.length < 2) continue;
    const itemProps = (prop.items && prop.items.properties) || {};
    for (const field of Object.keys(itemProps)) {
      if (!TIME_FIELD_NAME_RE.test(field)) continue;
      let nonEmpty = 0;
      let bad = 0;
      let sample = null;
      for (const r of records) {
        const v = r ? r[field] : undefined;
        const str = (typeof v === 'string') ? v.trim() : (v == null ? '' : String(v));
        if (!str) continue;
        nonEmpty += 1;
        if (!looksLikeDate(str)) {
          bad += 1;
          if (sample == null) sample = str.slice(0, 60);
        }
      }
      if (nonEmpty >= 2 && bad >= 2 && (bad / nonEmpty) >= (1 / 3)) {
        out.push({
          field: field,
          path: arrField + '.' + field,
          nonEmpty: nonEmpty,
          implausibleCount: bad,
          sample: sample,
          note: 'values carry no date/time shape (no month name, clock, time-unit word, ISO/CJK date) — typically an ARIA labelledby resolution on the WRONG anchor: its referenced texts concatenate (redirect domains + page titles). Filter candidate anchors by date SHAPE, re-bind the timestamp field to the anchor whose labelledby/text value matches a real date, or renegotiate the field via io.confirm.'
        });
      }
    }
  }
  return out.length ? out : null;
}

// Fifty-fifth log: postId shipped as the small ascending integers 3..11 —
// the extractor read aria-posinset (position-in-set) as the per-record
// identity. Identity values are long opaque tokens everywhere; an id-named
// field whose non-empty values are mostly small integers is a position or
// list index, not an id. Report-only: names the mechanism and where real
// ids live (the record permalink / link href).
function detectPositionLikeIds(data, schema) {
  const out = [];
  if (!data || typeof data !== 'object') return null;
  const props = (schema && schema.properties) || {};
  for (const arrField of Object.keys(props)) {
    const prop = props[arrField];
    if (!prop || prop.type !== 'array' || !prop.items || prop.items.type !== 'object') continue;
    const records = data[arrField];
    if (!Array.isArray(records) || records.length < 3) continue;
    const itemProps = (prop.items && prop.items.properties) || {};
    for (const field of Object.keys(itemProps)) {
      if (!/id$/i.test(field)) continue;
      let nonEmpty = 0;
      let small = 0;
      let sample = null;
      for (const r of records) {
        const v = r ? r[field] : undefined;
        const str = (typeof v === 'string') ? v.trim() : (v == null ? '' : String(v));
        if (!str) continue;
        nonEmpty += 1;
        if (/^[1-9][0-9]{0,2}$/.test(str)) {
          small += 1;
          if (sample == null) sample = str;
        }
      }
      if (nonEmpty >= 3 && (small / nonEmpty) >= 0.8) {
        out.push({
          field: field,
          path: arrField + '.' + field,
          count: small,
          totalRecords: records.length,
          sample: sample,
          note: 'identity values are long opaque tokens — these are small ascending integers, the fingerprint of a POSITION/index read (aria-posinset, list index). Per-record ids live in the record permalink / link href; re-bind the field there, or drop it via io.confirm if the page exposes no per-record identity.'
        });
      }
    }
  }
  return out.length ? out : null;
}

// Fifty-seventh log: the model invented a Playwright-style pseudo-class
// (:textless; the fifty-first log had :textish) INSIDE a service selector —
// the STANDARD-CSS prompt rule does not prevent the class, and the browser
// rejects it at querySelectorAll time. Deterministic landing-time lint:
// name the pseudo and teach the standard rewrite. Advisory-only.
const NON_STANDARD_PSEUDO_RE = /:(has-text|textish|textless|contains|visible|hidden|nth-match|above|below|near|within)\b/gi;

function detectNonStandardPseudoSelectors(steps) {
  if (!Array.isArray(steps) || !steps.length) return null;
  const out = [];
  for (const s of steps) {
    const script = String((s && s.script) || '');
    if (!script) continue;
    let m;
    NON_STANDARD_PSEUDO_RE.lastIndex = 0;
    while ((m = NON_STANDARD_PSEUDO_RE.exec(script)) !== null) {
      out.push({
        stepId: s && s.id,
        pseudo: ':' + m[1].toLowerCase(),
        near: script.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ')
      });
      if (out.length >= 8) break;
    }
  }
  return out.length ? out : null;
}

// Fifty-eighth log: likes shipped as "Like: 37 people" — the count is RIGHT
// THERE, parseable, but the census family (36th control-label is digit-FREE;
// 50th sibling-contrast is about EMPTY fields) never named the label-PREFIXED
// shape. A count-named field whose value is a letters-only label followed by
// a number carries extractable data — teach the parse, don't just disclose.
const LABEL_PREFIXED_COUNT_RE = /^[^0-9\n]{1,24}?\d/u;

function detectLabelPrefixedCounts(data, schema) {
  const out = [];
  if (!data || typeof data !== 'object') return null;
  const props = (schema && schema.properties) || {};
  for (const arrField of Object.keys(props)) {
    const prop = props[arrField];
    if (!prop || prop.type !== 'array' || !prop.items || prop.items.type !== 'object') continue;
    const records = data[arrField];
    if (!Array.isArray(records) || records.length < 1) continue;
    const itemProps = (prop.items && prop.items.properties) || {};
    for (const field of Object.keys(itemProps)) {
      if (!isCountLikeFieldName(field)) continue;
      let hits = 0;
      let sample = null;
      let parsed = null;
      for (const r of records) {
        const v = r ? r[field] : undefined;
        const str = (typeof v === 'string') ? v.trim() : '';
        if (!str) continue;
        if (!LABEL_PREFIXED_COUNT_RE.test(str)) continue;
        if (!/\d/.test(str)) continue;
        hits += 1;
        if (sample == null) {
          sample = str.slice(0, 40);
          const m = str.match(/(\d[\d.,]*\s*[KkMm]?)/);
          parsed = m ? m[1].trim() : null;
        }
      }
      if (hits > 0 && (hits / records.length) >= 0.5) {
        out.push({
          field: field,
          path: arrField + '.' + field,
          count: hits,
          sample: sample,
          parsedSample: parsed,
          note: 'the value is a CONTROL LABEL plus the count (e.g. ' + JSON.stringify(sample) + ') — the number is right there: parse it in the assembly with value.match(/(\\d[\\d.,]*\\s*[KkMm]?)/)[1]' +
            ' (or bind the field to the count-carrying element/attribute instead of the labeled control). Shipping the label prefix passes every empty detector while carrying a parseable count.'
        });
      }
    }
  }
  return out.length ? out : null;
}

// Seventy-fourth log: the container selector kept AI-image-prompt junk cards
// (long prompt text as content, NO postId/postTime) mixed with real posts —
// verify went red REQUIRED_FIELD_EMPTY on identity fields the junk cards
// structurally lack, and the model burned the remaining turns rewriting
// identity extraction for a subpopulation that never carries the values.
// Identity-ish required fields: time-named (TIME_FIELD_NAME_RE above) or
// id/permalink-named.
const JUNK_IDENTITY_FIELD_RE = /(^|_)id$|postid|permalink/i;

// Returns one entry per array field whose records split into a junk-shaped
// subpopulation (ALL identity-ish required fields empty AND a single content
// string field > 500 chars) alongside at least one non-junk record, when the
// junk share reaches 1/3. Report-only: the shape is a population split, not
// an extraction bug — the fix is the container selector or the contract.
function detectJunkShapeRecords(data, schema) {
  if (!data || typeof data !== 'object') return null;
  const props = (schema && schema.properties) || {};
  const out = [];
  for (const arrField of Object.keys(props)) {
    const prop = props[arrField];
    if (!prop || prop.type !== 'array' || !prop.items || prop.items.type !== 'object') continue;
    const records = data[arrField];
    if (!Array.isArray(records) || records.length < 2) continue;
    const itemProps = (prop.items.properties && typeof prop.items.properties === 'object') ? prop.items.properties : {};
    const declaredRequired = Array.isArray(prop.items.required) ? prop.items.required.map(String) : Object.keys(itemProps);
    const identityFields = declaredRequired.filter((f) => TIME_FIELD_NAME_RE.test(f) || JUNK_IDENTITY_FIELD_RE.test(f));
    if (!identityFields.length) continue;
    const junkIdx = [];
    let realCount = 0;
    let contentLenSum = 0;
    records.forEach((r, i) => {
      const rec = (r && typeof r === 'object' && !Array.isArray(r)) ? r : {};
      const allIdEmpty = identityFields.every((f) => rec[f] == null || String(rec[f]).trim() === '');
      let maxContentLen = 0;
      for (const f of Object.keys(itemProps)) {
        if (identityFields.indexOf(f) !== -1) continue;
        const v = rec[f];
        if (typeof v === 'string' && v.length > maxContentLen) maxContentLen = v.length;
      }
      contentLenSum += maxContentLen;
      if (allIdEmpty && maxContentLen > 500) junkIdx.push(i);
      else realCount += 1;
    });
    if (!junkIdx.length || realCount < 1) continue; // no contrast → nothing to teach
    if ((junkIdx.length / records.length) < (1 / 3)) continue;
    out.push({
      field: arrField,
      junkCount: junkIdx.length,
      totalCount: records.length,
      sampleIndexes: junkIdx.slice(0, 3).map((i) => i + 1),
      markers: {
        avgContentLen: Math.round(contentLenSum / records.length),
        identityFieldsAllEmpty: true
      },
      note: 'a subpopulation shares the junk shape (overlong text content, no identity links/timestamps — e.g. machine-generated prompt/media cards): tighten the container selector to exclude that shape, or make identity fields optional for it via io.confirm — do NOT keep rewriting identity extraction; the junk cards structurally lack the values'
    });
  }
  return out.length ? out : null;
}

// Seventy-fifth log: the session completed at the turn cap writing artifact
// v4 that was NEVER verified (last verify ran against red v3), while the
// completion presented v3's green-era report — the deploy path would bind
// the UNVERIFIED v4 steps behind a green-looking panel. Pure helper over
// the wizard's artifact bookkeeping state: {currentArtifactVersion,
// lastVerified:{version}} → is the CURRENT artifact newer than the last
// version a verify.run report blessed green?
function unverifiedArtifactState(state) {
  const cur = (state && typeof state.currentArtifactVersion === 'number') ? state.currentArtifactVersion : 0;
  const lv = state && state.lastVerified;
  const ver = (lv && typeof lv.version === 'number') ? lv.version : 0;
  return { unverified: cur > 0 && cur > ver, currentV: cur, verifiedV: ver };
}

// Seventy-fourth log: a FRESH session on a new keyword rebuilt the site's
// knowledge from scratch even though a deployed service for the SAME
// targetUrl already carried a findings ledger (author/time hovercards work).
// Cross-session seeding by exact targetUrl match — same site, same page
// structure, prior findings carry forward. Registry injected (best-effort:
// callers wrap in try/catch like the edit-mode seed).
async function seedLedgerFromSameSite(registry, targetUrl) {
  if (!registry || typeof registry.getAll !== 'function') return null;
  if (!targetUrl || typeof targetUrl !== 'string') return null;
  let all = null;
  try { all = await registry.getAll(); } catch (e) { return null; }
  const list = Array.isArray(all) ? all : [];
  for (const svc of list) {
    if (!svc || svc.targetUrl !== targetUrl) continue;
    if (svc.findingsLedger && Array.isArray(svc.findingsLedger.entries) && svc.findingsLedger.entries.length) return svc;
  }
  return null;
}

// Fifty-ninth log: the model's CONTRACT RENEGOTIATION carried
// "postId": {"type": "type", "description": "placeholder"} — a literal
// unfilled stub — and io.confirm's validation admitted it, surfacing the
// garbage in the USER's confirm panel (the user rejected it twice, correctly,
// burning turns). The user must never be the lint layer: type values outside
// the JSON-Schema enum set and placeholder-shaped descriptions are stubs.
const SCHEMA_LEGAL_TYPES = { object: 1, string: 1, number: 1, integer: 1, boolean: 1, array: 1, null: 1 };
const SCHEMA_PLACEHOLDER_DESC_RE = /^(placeholder|todo.*|tbd|\.\.\.|…|xxx+|fixme.*)$/i;

function detectSchemaPlaceholderFields(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const out = [];
  const visit = (node, path) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const problems = [];
    if (typeof node.type === 'string' && !SCHEMA_LEGAL_TYPES[node.type.toLowerCase()]) {
      problems.push('invalid type ' + JSON.stringify(node.type) + ' (legal: object/string/number/integer/boolean/array/null)');
    }
    const desc = typeof node.description === 'string' ? node.description.trim() : null;
    if (desc && SCHEMA_PLACEHOLDER_DESC_RE.test(desc)) {
      problems.push('placeholder description ' + JSON.stringify(desc.slice(0, 40)));
    }
    if (problems.length) out.push({ field: path.split('.').pop(), path: path, problems: problems });
    if (node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)) {
      for (const k of Object.keys(node.properties)) visit(node.properties[k], path + '.' + k);
    }
    if (node.items && typeof node.items === 'object' && !Array.isArray(node.items)) {
      visit(node.items, path + '.items');
    }
  };
  visit(schema, '$');
  return out.length ? out : null;
}

function detectHoverAnchorsBlind(events) {
  if (!Array.isArray(events)) return null;
  const perStep = new Map();
  for (const evt of events) {
    if (!evt || evt.type !== 'STEP_ITERATION') continue;
    const stepId = evt.stepId;
    if (stepId == null) continue;
    const diags = Array.isArray(evt.selectorDiagnostics) ? evt.selectorDiagnostics : [];
    for (const d of diags) {
      if (!d || d.api !== 'extractWithHover') continue;
      if (!perStep.has(stepId)) {
        perStep.set(stepId, {
          stepId: stepId, calls: 0, processedCalls: 0, anchorsFound: 0,
          hovercardsCaptured: 0, containersProcessed: 0,
          anchorSel: null, containerSelector: null, anchorCensus: null
        });
      }
      const agg = perStep.get(stepId);
      agg.calls += 1;
      const hs = d.hoverSummary || {};
      agg.anchorsFound += (hs.anchorsFound || 0);
      agg.hovercardsCaptured += (hs.hovercardsCaptured || 0);
      if (!agg.anchorSel && d.anchorSel) agg.anchorSel = d.anchorSel;
      if (!agg.containerSelector && d.containerSelector) agg.containerSelector = d.containerSelector;
      // Eighty-fourth log: the blind-container anchor census rides the same
      // diagnostics — verify embeds it so the next anchorSel is written
      // against the verify population's observed anchor forms.
      if (!agg.anchorCensus && d.anchorCensus) agg.anchorCensus = d.anchorCensus;
      if ((d.processedContainers || 0) > 0) {
        agg.processedCalls += 1;
        agg.containersProcessed += d.processedContainers;
      }
    }
  }
  for (const agg of perStep.values()) {
    if (agg.processedCalls > 0 && agg.anchorsFound === 0) return agg;
  }
  return null;
}

// Thirteenth live log (2026-09-03): five consecutive EMPTY_EXTRACTION reds
// while the page was healthy. The verify input (keyword "cat") produced a
// different result-card population than the researched page (q=news): 19
// cards matched the container selector but ZERO carried the grounded
// permalink sub-selector, and the step's own dedup filter dropped every
// extracted record — {done:true, posts:[]}. The per-field matchCount census
// sat in selectorDiagnostics the whole time. This detector surfaces it:
// a field whose sub-selector matched 0 containers on EVERY diagnostic that
// saw containers, per step. A field that matches on any later call is a
// healthy cold-load transient and stays silent.
function detectFieldMatchZero(events) {
  if (!Array.isArray(events)) return null;
  const agg = new Map(); // stepId + '\u0000' + field → stats
  for (const evt of events) {
    if (!evt || evt.type !== 'STEP_ITERATION') continue;
    const diags = Array.isArray(evt.selectorDiagnostics) ? evt.selectorDiagnostics : [];
    for (const d of diags) {
      if (!d || !Array.isArray(d.perField)) continue;
      const containers = d.containerMatches || 0;
      if (containers <= 0) continue;
      for (const f of d.perField) {
        if (!f || typeof f.field !== 'string') continue;
        if (!f.subSelector) continue; // self-read of the container — matchCount 0 is shape, not evidence
        const key = evt.stepId + '\u0000' + f.field;
        let e = agg.get(key);
        if (!e) {
          e = { stepId: evt.stepId, field: f.field, subSelector: f.subSelector, api: d.api || 'extractList', calls: 0, zeroCalls: 0, containerMatches: 0 };
          agg.set(key, e);
        }
        e.calls += 1;
        e.containerMatches = Math.max(e.containerMatches, containers);
        if ((f.matchCount || 0) === 0) e.zeroCalls += 1;
      }
    }
  }
  const hits = [];
  for (const e of agg.values()) {
    if (e.calls > 0 && e.zeroCalls === e.calls) hits.push(e);
  }
  return hits.length ? hits : null;
}

// Fourteenth-log follow-up (user request): the inverse fingerprint — every
// list call for a step+container saw containerMatches 0. When the page shows
// ZERO result items, the input VALUE itself is the prime suspect (an obscure
// keyword the site has no content for, an over-specific filter) — NOT the
// selectors. detectFieldMatchZero skips containers<=0 entries; this detector
// consumes exactly those.
function detectContainerMatchZero(events) {
  if (!Array.isArray(events)) return null;
  const agg = new Map(); // stepId + ' ' + containerSelector → stats
  for (const evt of events) {
    // Fifty-first log: a step that THREW on zero containers emits STEP_FAILED
    // (the sandbox's error path relays the failing call's _diagnostics into
    // event.selectorDiagnostics) and never emits a STEP_ITERATION — scanning
    // only iterations made the throw shape invisible to this census, so the
    // "$extractWithHover: no containers matched" red verify carried no
    // container census at all. Both event types carry the same payload shape.
    if (!evt || (evt.type !== 'STEP_ITERATION' && evt.type !== 'STEP_FAILED')) continue;
    const diags = Array.isArray(evt.selectorDiagnostics) ? evt.selectorDiagnostics : [];
    for (const d of diags) {
      if (!d) continue;
      // Twenty-fifth log: diagnostics WITHOUT a numeric containerMatches
      // ($count/$wait/$exists carry matchCount or nothing) used to aggregate
      // as `container "" matched 0 items` lines — noise the session model
      // misread as "the feed never loaded". Only list-family diagnostics
      // participate in the CONTAINER census.
      if (typeof d.containerMatches !== 'number') continue;
      const key = evt.stepId + ' ' + String(d.containerSelector || '');
      let e = agg.get(key);
      if (!e) {
        e = { stepId: evt.stepId, api: d.api || 'extractList', containerSelector: d.containerSelector || '', calls: 0, zeroCalls: 0, selectorDifferential: null };
        agg.set(key, e);
      }
      e.calls += 1;
      if (d.containerMatches === 0) {
        e.zeroCalls += 1;
        // Twenty-fifth log: keep the latest live differential (counts of the
        // selector with trailing :not()/:has() clauses stripped) so the verify
        // message can say whether the caller's own clauses removed the
        // population.
        if (Array.isArray(d.selectorDifferential)) e.selectorDifferential = d.selectorDifferential;
      }
    }
  }
  const hits = [];
  for (const e of agg.values()) {
    if (e.calls > 0 && e.zeroCalls === e.calls) hits.push(e);
  }
  return hits.length ? hits : null;
}

function validateTestInput(inputStr, schemaStr, testInputStr) {
  try {
    return {
      valid: true,
      inputSchema: JSON.parse(inputStr),
      outputSchema: JSON.parse(schemaStr),
      testInput: JSON.parse(testInputStr)
    };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

function cleanLLMResponse(raw) {
  // === Spec 5: strip leading ACK/NACK protocol line (if present) ===
  if (typeof raw === 'string') {
    const match = raw.match(/^\s*\/\/\s*(ACK|NACK):\s*([^\n]*)\n?/);
    if (match) {
      const kind = match[1];           // 'ACK' | 'NACK'
      const ackText = match[2] || '';  // paraphrase/reason
      try {
        if (typeof debugLogger !== 'undefined') {
          debugLogger.log('info', 'wizard', 'LLM ACK/NACK', { kind, text: ackText });
        }
      } catch {}
      raw = raw.slice(match[0].length);
    }
  }
  // === End Spec 5 ===

  let text = raw.trim();
  if (!text) return text;

  // Extract code from markdown fences — robust to the ways LLMs actually emit code:
  //   - closed:    ```js\ncode\n```
  //   - UNCLOSED:  ```js\ncode            (LLM forgot the closing fence — very common, previously broke auto-fix)
  //   - no newline after marker, optional ws/tab, \r\n — all tolerated
  // Takes the last non-empty fenced block.
  const allFences = [...text.matchAll(/```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)(?:\r?\n?```|$)/g)];
  const withContent = allFences.filter(m => m[1].trim());
  if (withContent.length) {
    return withContent[withContent.length - 1][1].trim();
  }

  // No code fences — check if the entire response looks like JSON or code
  if (text.startsWith('{') || text.startsWith('[') || text.startsWith('//') ||
      text.startsWith('const ') || text.startsWith('let ') || text.startsWith('return ') ||
      text.startsWith('async ') || text.startsWith('await ')) {
    return text;
  }

  // Try to find JSON or code embedded in explanatory text
  const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    return jsonMatch[0].trim();
  }

  return text;
}

// Walk a string char-by-char and strip C-style comments (// line and
// /* block */) that appear OUTSIDE JSON string values. Used by parseJsonLenient
// to tolerate LLM-generated JSON that mixes in JS comments.
//
// Why char-walk instead of regex: regex can't tell whether `//` is inside a
// string (e.g. `"script": "// hello"`) without tracking string state, and
// naively stripping all `//...` corrupts embedded script values.
function stripJSComments(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\' && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      const nl = text.indexOf('\n', i + 2);
      i = nl === -1 ? text.length : nl + 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// Walk a JSON-ish string char-by-char and repair the LLM mistakes that most
// often produce "Expected property name or '}'" / "Unexpected token" errors:
//
//   - Bare (unquoted) keys:            { id: "1" }            → { "id": "1" }
//   - Single-quoted strings:           { 'a': 'b' }           → { "a": "b" }
//   - Missing commas between members:  { "a":1 "b":2 }        → { "a":1,"b":2 }
//   - Leading commas:                  { ,"a":1 } / [,1]      → { "a":1 } / [1]
//   - Double commas:                   [1,,2]                 → [1,2]
//   - Unescaped " in code-bearing      "script":"...role='x'\"..."
//     string values (bugx.log          →  "script":"...role='x'\\\"..."
//     2026-07-24 pos 6671): the
//     LLM emits JS selectors like
//     $count('div[role="article"]')
//     with literal " because that's
//     legal inside JS single-quoted
//     strings.
//
// Why char-walk instead of regex: every one of these repairs is unsafe inside
// a JSON string value (a script may legitimately contain `{'a':1}` as text),
// so we must track string state. The walker also tracks an object/array
// context stack so bare identifiers are only treated as keys inside objects,
// and a last-token category so comma insertion fires only between values.
//
// What this does NOT fix: truncated input, unescaped control chars inside
// string values (e.g. literal newlines), JS template literals. Those need a
// full tokenizer; if the LLM emits them, the caller sees the failure and
// reports position context (see parseLLMJson in wizard.js).
//
// CODE_BEARING_KEYS: keys whose values frequently contain JS source code. The
// LLM routinely emits unescaped " inside these (from JS selectors/strings),
// which a strict JSON parser treats as the string terminator. For these keys
// only, we use a peek-ahead reader that escapes any " NOT followed by a
// structural char (, } ] : or EOF). We deliberately do NOT apply this to all
// string values — it's too risky for free-text fields where an unescaped "
// followed by , } ] : might be a genuine truncation we shouldn't paper over.
const CODE_BEARING_KEYS = new Set(['script', 'functionBody', 'expression', 'code', 'condition']);
function repairCommonJsonMistakes(text) {
  if (typeof text !== 'string' || !text) return text;
  const isIdentStart = (c) => /[a-zA-Z_$]/.test(c);
  const isIdentPart = (c) => /[a-zA-Z0-9_$]/.test(c);
  const isWhitespace = (c) => /\s/.test(c);
  // Categories of "last emitted token" relevant to comma insertion.
  // Value-terminators are the only ones that may need a comma before the next value.
  const VALUE_ENDS = new Set(['string', 'number', 'ident', 'close-brace', 'close-bracket']);
  // Structural characters that may legitimately follow a real string terminator.
  // `:` is excluded — a value string cannot be followed by `:` in valid JSON.
  const STRING_TERMINATOR_NEXT = new Set([',', '}', ']']);

  let out = '';
  let i = 0;
  let inString = false;
  let escape = false;
  let stack = []; // 'object' | 'array'
  let lastCat = 'none';
  let lastKeyName = null; // most recent key parsed at the current object level

  const inObject = () => stack[stack.length - 1] === 'object';
  const needsComma = () => stack.length > 0 && VALUE_ENDS.has(lastCat);

  while (i < text.length) {
    const c = text[i];

    // Inside a double-quoted string: copy verbatim, track escapes.
    if (inString) {
      out += c;
      if (escape) { escape = false; i++; continue; }
      if (c === '\\') { escape = true; i++; continue; }
      if (c === '"') { inString = false; lastCat = 'string'; }
      i++;
      continue;
    }

    if (isWhitespace(c)) { out += c; i++; continue; }

    // Double-quoted string. Peek ahead to disambiguate key vs value, and
    // detect code-bearing values that need unescaped-quote-aware reading.
    if (c === '"') {
      // Scan to the matching closing quote, respecting backslash escapes.
      // If we run off the end, end === text.length and there's no closing quote.
      let end = i + 1;
      while (end < text.length) {
        if (text[end] === '\\') { end += 2; continue; }
        if (text[end] === '"') break;
        end++;
      }
      const hasClose = end < text.length;
      // Peek past the closing quote to detect key context.
      let after = hasClose ? end + 1 : text.length;
      while (after < text.length && isWhitespace(text[after])) after++;
      const isKey = hasClose && text[after] === ':' && inObject();

      if (isKey) {
        if (needsComma()) out += ',';
        // Preserve the key verbatim (including any escape sequences).
        out += text.slice(i, end + 1) + ':';
        lastKeyName = text.slice(i + 1, end);
        lastCat = 'colon';
        i = after + 1;
        continue;
      }

      // Value string. For code-bearing keys, the LLM routinely emits
      // unescaped " inside the value (from JS selectors like
      // $count('div[role="article"]')). The inString state machine below would
      // terminate the string at the first such ", corrupting everything after.
      // Use a context-tracking reader: maintain a depth counter for JS brackets
      // ( [ { ( ), so a " inside a CSS selector / array / parenthesised call
      // is always escaped (the matching ])} has not been seen yet). When depth
      // is 0, a " is the real JSON terminator only when the next non-whitespace
      // char is a JSON structural separator (, } ] or EOF).
      if (lastKeyName && CODE_BEARING_KEYS.has(lastKeyName)) {
        if (needsComma()) out += ',';
        out += '"';
        let p = i + 1;
        let pesc = false;
        let depth = 0; // tracks [ { ( inside the JS code
        while (p < text.length) {
          const cp = text[p];
          if (pesc) {
            // Preserve existing escape sequences verbatim. The backslash was
            // NOT emitted when cp='\\' was seen — we deferred to here so the
            // escaped char gets joined with its backslash.
            out += '\\' + cp;
            pesc = false; p++; continue;
          }
          if (cp === '\\') { pesc = true; p++; continue; }
          if (cp === '"' && depth > 0) {
            // Inside a JS nested context (e.g. CSS selector) — never terminate.
            out += '\\"';
            p++; continue;
          }
          if (cp === '"') {
            let q = p + 1;
            while (q < text.length && isWhitespace(text[q])) q++;
            const nc = q < text.length ? text[q] : '';
            if (nc === '' || STRING_TERMINATOR_NEXT.has(nc)) break;
            // Unescaped " at depth 0 not followed by a separator — escape it.
            out += '\\"';
            p++; continue;
          }
          if (cp === '[' || cp === '{' || cp === '(') depth++;
          else if (cp === ']' || cp === '}' || cp === ')') depth = Math.max(0, depth - 1);
          out += cp;
          p++;
        }
        out += '"';
        lastCat = 'string';
        i = p + 1;
        continue;
      }

      // Normal value string — defer to the inString state machine.
      if (needsComma()) out += ',';
      inString = true;
      out += c;
      i++;
      continue;
    }

    // Single-quoted string → convert to double-quoted.
    // Walk to the matching closing single quote (respecting \' escapes),
    // unescape \' → ', escape any literal " inside.
    if (c === "'") {
      if (needsComma()) out += ',';
      let j = i + 1;
      let inner = '';
      let esc = false;
      while (j < text.length) {
        const cj = text[j];
        if (esc) {
          if (cj === "'") inner += "'";
          else if (cj === '"') inner += '\\"';
          else inner += '\\' + cj;
          esc = false; j++;
          continue;
        }
        if (cj === '\\') { esc = true; j++; continue; }
        if (cj === "'") break;
        if (cj === '"') inner += '\\"';
        else inner += cj;
        j++;
      }
      out += '"' + inner + '"';
      lastCat = 'string';
      i = j + 1;
      continue;
    }

    // Identifier (covers bare keys AND literal values true/false/null/Infinity/etc.)
    if (isIdentStart(c)) {
      let j = i;
      let ident = '';
      while (j < text.length && isIdentPart(text[j])) { ident += text[j]; j++; }
      let k = j;
      while (k < text.length && isWhitespace(text[k])) k++;

      // Bare-key: inside an object, identifier immediately followed by `:`.
      // Allow this regardless of lastCat — if the LLM also forgot the comma
      // before this key, we repair both mistakes at once (needsComma handles
      // the comma, the wrap handles the quotes).
      if (inObject() && text[k] === ':') {
        if (needsComma()) out += ',';
        out += '"' + ident + '":';
        lastKeyName = ident;
        lastCat = 'colon';
        i = k + 1;
        continue;
      }

      // Otherwise it's a value-position identifier (true/false/null/etc.) —
      // emit as-is, with comma insertion if we just finished another value.
      if (needsComma()) out += ',';
      out += ident;
      lastCat = 'ident';
      i = j;
      continue;
    }

    // Number literal (including leading - and exponent/sign chars).
    if (/[0-9\-]/.test(c)) {
      if (needsComma()) out += ',';
      let j = i;
      if (text[j] === '-') j++;
      while (j < text.length && /[0-9eE+\-.]/.test(text[j])) j++;
      out += text.slice(i, j);
      lastCat = 'number';
      i = j;
      continue;
    }

    // Structural characters.
    if (c === '{' || c === '[') {
      if (needsComma()) out += ',';
      out += c;
      stack.push(c === '{' ? 'object' : 'array');
      lastCat = c === '{' ? 'open-brace' : 'open-bracket';
      lastKeyName = null; // reset on nested structure
      i++;
      continue;
    }
    if (c === '}' || c === ']') {
      out += c;
      if (stack.length) stack.pop();
      lastCat = c === '}' ? 'close-brace' : 'close-bracket';
      lastKeyName = null; // reset on structure exit
      i++;
      continue;
    }
    if (c === ':') {
      out += c;
      lastCat = 'colon';
      i++;
      continue;
    }
    if (c === ',') {
      // Leading commas ({, / [,) and double/trailing commas (,, / ,} / ,]) are
      // never valid — drop them.
      if (lastCat === 'open-brace' || lastCat === 'open-bracket' || lastCat === 'comma' || lastCat === 'none') {
        i++;
        continue;
      }
      out += c;
      lastCat = 'comma';
      i++;
      continue;
    }

    // Any other char (rare): copy through, treat as opaque value.
    out += c;
    lastCat = 'value';
    i++;
  }
  return out;
}

// Quote-aware string rewrite for the "unescaped double quotes inside a string
// value" failure class (third-live-log incident 4: the model quoted English
// names with bare ASCII quotes inside think text). Inside a double-quoted
// string, a `"` is treated as the string terminator ONLY when the next
// non-whitespace char is a JSON structural separator (, } ]) or `:` (key
// close); every other `"` is content and gets escaped. A no-op on valid JSON
// (all real terminators match the rule; content quotes are already escaped).
// Returns null when a string never closes (truncated input).
function repairUnescapedQuotes(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      out += '"';
      i++;
      let closed = false;
      while (i < n) {
        const d = text[i];
        if (d === '\\') { out += text.slice(i, i + 2); i += 2; continue; }
        if (d === '"') {
          let q = i + 1;
          while (q < n && /\s/.test(text[q])) q++;
          const nc = q < n ? text[q] : '';
          if (nc === '' || nc === ',' || nc === '}' || nc === ']' || nc === ':') {
            out += '"';
            i++;
            closed = true;
            break;
          }
          out += '\\"';
          i++;
          continue;
        }
        out += d;
        i++;
      }
      if (!closed) return null;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Sixty-third log: position-guided inner-quote escaping. That session's TWO
// terminal protocol violations were replies whose think prose quoted page
// evidence ("Like: 179 people", "Wow: 11 people") while the args were
// perfectly escaped. repairUnescapedQuotes' closer-set heuristic (a quote
// followed by ,/}/]/: closes the string) mis-fires exactly on prose that
// quotes two things comma-separated: `"people", "Wow"` is indistinguishable
// from a value close + the next key. The V8 parse error carries the exact
// position of the structural expectation failure — escape the quote that
// prematurely closed the value and re-parse; iterate one quote per round.
// Only the two premature-close signatures act:
//   - "Expected ',' or '}' after property value" @N → the value string
//     closed early; escape the nearest unescaped " before N.
//   - "Expected ':' after property name" @N → the PREVIOUS value closed
//     early, making the following prose look like a key; escape back past
//     the phantom key's quotes and the comma to the value's premature close.
// Truncation ("Unterminated string") and trailing-junk classes return null —
// they stay with their existing owners (close-braces salvage, continuation
// repair round), and valid JSON returns src unchanged on round 0.
function escapePrematureQuoteClosers(src, maxRounds) {
  if (typeof src !== 'string' || !src) return null;
  const nearestUnescapedQuote = (s, pos) => {
    for (let i = pos - 1; i >= 0; i--) {
      if (s[i] !== '"') continue;
      let esc = false;
      for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) esc = !esc;
      if (!esc) return i;
    }
    return -1;
  };
  let s = src;
  let rounds = 0;
  for (let round = 0; round < (maxRounds || 24); round++) {
    try { JSON.parse(s); return { text: s, rounds }; } catch (e) {
      const msg = String(e.message || e);
      const m = /position (\d+)/.exec(msg);
      if (!m) return null;
      const pos = +m[1];
      let idx = -1;
      if (/Expected ',' or '}' after property value/.test(msg)) {
        idx = nearestUnescapedQuote(s, pos);
      } else if (/Expected ':' after property name/.test(msg)) {
        const keyClose = nearestUnescapedQuote(s, pos);
        const keyOpen = keyClose >= 0 ? nearestUnescapedQuote(s, keyClose) : -1;
        if (keyOpen < 0) return null;
        let i = keyOpen - 1;
        while (i >= 0 && /[\s,]/.test(s[i])) i--;
        idx = nearestUnescapedQuote(s, i + 1);
      } else return null;
      if (idx < 0) return null;
      s = s.slice(0, idx) + '\\' + s.slice(idx);
      rounds += 1;
    }
  }
  return null;
}

// Code-review P2 (string-aware comma strip): the old blanket
// `s.replace(/,(\s*[}\]])/g, '$1')` edited commas INSIDE string values too —
// a payload quoting page evidence like "a, ] b" got silently rewritten. Walk
// the text with a string-state machine (the same brace/quote scanner pattern
// as repairUnescapedQuotes) and strip a comma only when it sits in STRUCTURAL
// position (outside any string, next non-ws char is } or ]).
function stripStructuralTrailingCommas(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = '';
  let i = 0;
  const n = text.length;
  let inString = false;
  while (i < n) {
    const c = text[i];
    if (inString) {
      if (c === '\\') { out += text.slice(i, i + 2); i += 2; continue; }
      if (c === '"') inString = false;
      out += c; i++; continue;
    }
    if (c === '"') { inString = true; out += c; i++; continue; }
    if (c === ',') {
      let q = i + 1;
      while (q < n && /\s/.test(text[q])) q++;
      if (q < n && (text[q] === '}' || text[q] === ']')) { i++; continue; }
      out += c; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

// Lenient JSON parser for LLM output. Tries strict JSON.parse first; on
// failure, applies a small set of safe repairs (strip JS comments outside
// strings, repair bare keys / single-quotes / missing commas, drop trailing
// commas) and re-tries. Returns {ok, value, error, repairs} so callers can
// log what was repaired.
//
// What this does NOT fix: truncated input, unescaped control chars inside
// string values, JS template literals. Those need a real tokenizer and are
// risky to fix with heuristics — if the LLM emits those, the caller should
// see the failure and report the exact position (see parseLLMJson in
// wizard.js which logs the position context).
function parseJsonLenient(text) {
  if (typeof text !== 'string' || !text) {
    return { ok: false, error: 'empty input', repairs: [] };
  }
  try {
    return { ok: true, value: JSON.parse(text), repairs: [] };
  } catch (_) {}
  const repairs = [];
  let s = text;
  const stripped = stripJSComments(s);
  if (stripped !== s) {
    repairs.push('strip-comments');
    s = stripped;
  }
  // Fourteenth-log turn 22: the LLM dropped the `":` after a key —
  // ,"hypotheses null,"tool": … — the broken "string" `ident null,` absorbs
  // the NEXT key's opening quote, so the repair must reattach it: match the
  // full double-key signature and rewrite to "ident": null,"tool":. Run
  // BEFORE repairCommonJsonMistakes (its char-walker mangles this shape into
  // a junk single-key object = false success). Narrow by design:
  // exact-content ident+null/true/false only, so prose never matches;
  // numbers excluded (YAGNI). Loop to a fixpoint — chained malformations
  // repair every OTHER occurrence per pass.
  let colonFixed = s;
  for (let i = 0; i < 5; i++) {
    const next = colonFixed.replace(/"([A-Za-z_][\w-]*)\s+(null|true|false)\s*,?\s*"([A-Za-z_][\w-]*)"\s*:/g, '"$1": $2, "$3":');
    if (next === colonFixed) break;
    colonFixed = next;
  }
  if (colonFixed !== s) {
    repairs.push('repair-missing-colon');
    s = colonFixed;
  }
  // Fifteenth log (segment-2 finish): the LLM collapsed the taught finish
  // shape {"finish": { "summary": "..." }} into {"finish":"summary":"..."} —
  // a double colon after the label string, which is never valid JSON. Drop
  // the "summary" label so the trailing text becomes the finish value; the
  // protocol layer (parseAssistantTurn) tolerates the bare-string finish.
  // Narrow by design: exact "finish"/"summary" literals only, and this whole
  // block runs only after a parse failure.
  const finishFixed = s.replace(/("finish"\s*:\s*)"summary"\s*:\s*/g, '$1');
  if (finishFixed !== s) {
    repairs.push('repair-finish-double-colon');
    s = finishFixed;
  }
  const commonFixed = repairCommonJsonMistakes(s);
  if (commonFixed !== s) {
    repairs.push('repair-common-mistakes');
    s = commonFixed;
  }
  // Remove commas that directly precede a closing } or ] (with optional
  // whitespace) — STRING-AWARE (code review P2): commas inside quoted values
  // are content, never structural.
  const trailingFixed = stripStructuralTrailingCommas(s);
  if (trailingFixed !== s) {
    repairs.push('remove-trailing-commas');
    s = trailingFixed;
  }
  try {
    return { ok: true, value: JSON.parse(s), repairs };
  } catch (e) {
    // Last resort, now two passes on the comment-stripped ORIGINAL (the
    // common-mistakes pass above has already corrupted unescaped-quote
    // strings by then). Sixty-third log: the position-guided pass runs
    // FIRST — precise where the closer-set heuristic mis-fires (prose that
    // quotes two things: `"people", "Wow"`). Purely additive coverage; the
    // corpus-proven behavior only runs when it fails.
    const posEscaped = escapePrematureQuoteClosers(stripped);
    if (posEscaped != null && posEscaped.text != null && posEscaped.text !== stripped) {
      const posFixed = stripStructuralTrailingCommas(posEscaped.text);
      try {
        // Code-review P2: the repairs token carries the ROUND COUNT — the
        // escape pass is inherently ambiguous (it guesses which quote closed
        // early), and N rounds in the receipt discloses how much guessing
        // happened.
        return { ok: true, value: JSON.parse(posFixed), repairs: repairs.concat(['escape-inner-quotes:' + posEscaped.rounds]) };
      } catch (e2) { /* fall through to the closer-set rewrite */ }
    }
    // Quote-aware rewrite of the comment-stripped ORIGINAL. Only fires when
    // everything above failed, so the corpus-proven behavior is untouched;
    // purely additive coverage.
    const rewritten = repairUnescapedQuotes(stripped);
    if (rewritten != null && rewritten !== stripped) {
      const rewrittenFixed = stripStructuralTrailingCommas(rewritten);
      try {
        return { ok: true, value: JSON.parse(rewrittenFixed), repairs: repairs.concat(['escape-content-quotes']) };
      } catch (e2) { /* fall through to the failure report */ }
    }
    return { ok: false, error: e.message, repairs, repairedPreview: s.slice(0, 500) };
  }
}

// --- framework guardrails (WS3) ---------------------------------------------

// Coarse static estimate of a script's single-iteration wall-clock delay from
// literal setTimeout delays + explicit $exists/$wait timeouts. Conservative:
// dynamic delays (setTimeout(r, variable)) are invisible. Used to WARN only.
function estimateScriptTimeBudget(script) {
  if (!script) return 0;
  let total = 0;
  let m;
  const reSleep = /setTimeout\s*\(\s*[^,)]+\s*,\s*(\d+)\s*\)/g;
  while ((m = reSleep.exec(script)) !== null) total += parseInt(m[1], 10);
  const reWait = /\$(?:exists|wait)\s*\([^)]*,\s*(\d+)\s*\)/g;
  while ((m = reWait.exec(script)) !== null) total += parseInt(m[1], 10);
  return total;
}

// Validate external input against a service's inputSchema. {valid} or {valid:false, code, error}.
// Used at the host/execute boundary (WS2.3) so bad input is rejected before queueing.
const MAX_INPUT_CHARS = 500000;   // ~500KB overall payload guard (queue-abuse prevention)
const MAX_INPUT_STRING_LEN = 100000; // 100KB per string field
function validateInputAgainstSchema(input, inputSchema) {
  if (input === null || input === undefined) return { valid: false, code: 400, error: 'input is required' };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, code: 400, error: 'input must be a JSON object' };
  }
  // Overall payload size guard (rejects oversized inputs that would abuse the serial queue).
  let size = 0;
  try { size = JSON.stringify(input).length; } catch { size = 0; }
  if (size > MAX_INPUT_CHARS) {
    return { valid: false, code: 400, error: `Input too large (${size} chars > ${MAX_INPUT_CHARS})` };
  }
  // Per-field string length cap.
  for (const k of Object.keys(input)) {
    const v = input[k];
    if (typeof v === 'string' && v.length > MAX_INPUT_STRING_LEN) {
      return { valid: false, code: 400, error: `Input '${k}' too long (${v.length} chars > ${MAX_INPUT_STRING_LEN})` };
    }
  }
  const required = (inputSchema && inputSchema.required) || [];
  const props = (inputSchema && inputSchema.properties) || {};
  for (const k of required) {
    if (input[k] === undefined || input[k] === null || input[k] === '') {
      return { valid: false, code: 400, error: `Missing required input: ${k}` };
    }
    const want = props[k] && props[k].type;
    if (want) {
      const got = Array.isArray(input[k]) ? 'array' : typeof input[k];
      if (got !== want) {
        return { valid: false, code: 400, error: `Input '${k}' must be ${want}, got ${got}` };
      }
    }
  }
  return { valid: true };
}

// Validate a job's final result against outputSchema.required. A required field
// is "missing" if '', null, undefined, or empty array. {ok} or {ok:false, missing, code}.
// Used at job completion (WS2.2) and the test step (WS4.2).
function validateOutputAgainstSchema(finalResult, outputSchema) {
  const data = finalResult && typeof finalResult === 'object' && 'data' in finalResult ? finalResult.data : finalResult;
  if (!outputSchema || !Array.isArray(outputSchema.required) || outputSchema.required.length === 0) {
    return { ok: true };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, missing: outputSchema.required.slice(), code: 'REQUIRED_OUTPUT_MISSING' };
  }
  const missing = outputSchema.required.filter(k =>
    data[k] === undefined || data[k] === null || data[k] === '' ||
    (Array.isArray(data[k]) && data[k].length === 0)
  );
  return missing.length === 0
    ? { ok: true }
    : { ok: false, missing, code: 'REQUIRED_OUTPUT_MISSING' };
}

// Detect "schema-valid but extraction-empty" results: a required field whose
// value is an array of objects where EVERY object has only empty values
// ('', null, undefined, []). validateOutputAgainstSchema above passes these
// because the array length is > 0, but the extraction clearly failed — the
// script found list items but couldn't extract any fields from them. Without
// this check, the wizard's testScript reports success and autoFix uses the
// weak "improve based on feedback" prompt instead of the strong "fix failing
// step" prompt, so the LLM keeps generating similar broken selectors.
// findUpstreamExtractionStepId(steps, fallbackStepId)
//
// Walks the steps array in REVERSE, returning the id of the first step whose
// script calls an array-extraction primitive ($extractList / $extractListMulti
// / $list). Used by testScript's EMPTY_EXTRACTION and DUPLICATE_RECORDS paths
// so the failing-step pointer the LLM sees targets the ACTUAL extractor — not
// a schema-conformance finalizer that just maps over __stepResults__['N'].
//
// Why this matters (console.log 2026-08-06 feed-search extraction): step graph was
//   4 extract_posts ($extractListMulti) → 5 extract_hovercard_details (pass-through) → 6 finalize_output (pass-through)
// Step 4's post-filter (if (isAd) return null; .filter(p => p !== null))
// collapsed every record to null because the ad-detection regex matched
// legitimate content attributes. Result: {posts:[]}. Steps 5 and 6 are pure
// pass-throughs. The framework attributed EMPTY_EXTRACTION to step 6 — autoFix
// spent 3 iterations rewriting the finalizer and never touched step 4.
//
// The walk-back finds step 4 (last step with an extraction call) so the LLM
// gets pointed at the real extractor. We walk in REVERSE so we find the
// CLOSEST upstream extractor to the failing finalizer — if step 5 ALSO called
// $extractListMulti, we'd want step 5 (whose output flows directly into 6),
// not an earlier step whose output is already transformed.
//
// Falls back to fallbackStepId unchanged when no step in the chain calls an
// extraction primitive (defensive — preserves prior behavior for hand-rolled
// loops the DSL guide nonetheless discourages).
const ARRAY_EXTRACTION_RE = /\$(extractList|extractListMulti|extractWithHover|list)\s*\(/;
function findUpstreamExtractionStepId(steps, fallbackStepId) {
  if (!Array.isArray(steps) || steps.length === 0) return fallbackStepId;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s && typeof s.script === 'string' && ARRAY_EXTRACTION_RE.test(s.script)) {
      return s.id;
    }
  }
  return fallbackStepId;
}

// RC42: Producing-primitive finder for REQUIRED_OUTPUT_MISSING fallback.
// console.log 2026-08-12 incident: finalResult {accountInfoHtml:"", groupInfoHtml:""}
// where both fields are STRINGS produced by step 5's `$hover` calls. The script
// returned cleanly (try/catch swallowed the underlying hover failure), so the
// orchestrator's catch path with its ELEMENT_NOT_FOUND/SCRIPT_ERROR autoFix
// gate never fired. validateOutputAgainstSchema DID fire REQUIRED_OUTPUT_MISSING,
// but the failure path returned without attempting autoFix — and even if it had,
// findUpstreamExtractionStepId only matches $extractList/$extractListMulti/$list
// (ARRAY primitives), so step 5's $hover was invisible to the walk-back.
//
// This helper matches a BROADER set of producing primitives — anything that
// pulls content out of the page ($hover, $extract, $extractList,
// $extractListMulti, $list). It deliberately excludes predicate primitives
// ($count, $exists, $check) which return booleans/numbers for control flow,
// not extracted content. Used by background.js's REQUIRED_OUTPUT_MISSING path
// to point autoFix at the actual producer when scalar output fields come back
// empty.
const PRODUCING_PRIMITIVE_RE = /\$(hover|extract|extractList|extractListMulti|list)\s*\(/;
function findUpstreamProducingStepId(steps, fallbackStepId) {
  if (!Array.isArray(steps) || steps.length === 0) return fallbackStepId;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s && typeof s.script === 'string' && PRODUCING_PRIMITIVE_RE.test(s.script)) {
      return s.id;
    }
  }
  return fallbackStepId;
}

// schemaArrayItemFieldKeys(prop) → string[] | null
//
// Canonical field discovery for a schema property that declares an array of
// records. Returns required-first item field keys, falling back to declared
// item properties; null when the property is not a fielded array.
//
// Nineteenth log (2026-09-04): the LLM authored outputSchema with
// items:{properties:{...}} and NO items.type:'object'. Consumers gating on
// items.type went blind while scoreAttemptResult (properties-only) kept
// reading the same schema — 10 of 11 fields empty in every record verified
// GREEN with partialEmpty:[] and score 140. A fielded items node counts
// regardless of whether the type tag is spelled out.
function schemaArrayItemFieldKeys(prop) {
  if (!prop || prop.type !== 'array' || !prop.items || typeof prop.items !== 'object') return null;
  const ir = (Array.isArray(prop.items.required) ? prop.items.required : []).filter(k => typeof k === 'string');
  const ip = (prop.items.properties && typeof prop.items.properties === 'object' && !Array.isArray(prop.items.properties))
    ? prop.items.properties
    : {};
  const propKeys = Object.keys(ip).filter(k => typeof k === 'string');
  // Twenty-second log: returning required ALONE when present made every
  // per-record census (empty-ratio, duplicate signatures, all-empty) blind
  // to fields a contract revision moved OUT of required — postTime stayed
  // declared under properties, shipped "" in 5/5 records, and verify stayed
  // green. The census scope is every DECLARED field: required first (the
  // author's priority order), then the remaining properties.
  const seen = new Set(ir);
  const keys = ir.concat(propKeys.filter(k => !seen.has(k)));
  return keys.length ? keys : null;
}

function findEmptyExtractionFields(data, outputSchema) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  if (!outputSchema || typeof outputSchema !== 'object' || Array.isArray(outputSchema)) return [];

  // Field source: required first, then declared properties. Seventeenth log:
  // schemas declaring fields ONLY via properties (no required) were skipped
  // entirely — the early return demanded a non-empty required list.
  const props = (outputSchema.properties && typeof outputSchema.properties === 'object' && !Array.isArray(outputSchema.properties))
    ? outputSchema.properties
    : {};
  const required = (Array.isArray(outputSchema.required) ? outputSchema.required : []).filter(k => typeof k === 'string');
  const fieldKeys = required.length ? required : Object.keys(props);
  if (!fieldKeys.length) return [];

  const isEmptyValue = (v) =>
    v === '' || v === null || v === undefined || (Array.isArray(v) && v.length === 0);

  // A property is "array-of-objects" if the schema declares type:'array' with
  // fielded items (items.type:'object' OR items:{properties} — nineteenth
  // log: the type tag may be omitted). For these fields, an empty array means
  // the script ran but extracted zero records — a clear extraction failure
  // (the page has items, the selectors missed them). For scalar-array fields
  // (string[]), an empty array can legitimately mean "the page had no matching
  // items", so we leave those for validateOutputAgainstSchema to surface as a
  // missing-field.
  // Nineteenth log: schemaArrayItemFieldKeys returns null for a bare
  // items:{type:'object'} (no declared fields) — that is still an explicit
  // array-of-objects declaration, so it counts for the empty-array flag;
  // only the per-record field scoping needs derivable keys.
  const isArrayOfObjects = (key) => {
    const p = props[key];
    if (!p || p.type !== 'array' || !p.items || typeof p.items !== 'object') return false;
    return schemaArrayItemFieldKeys(p) !== null || p.items.type === 'object';
  };

  // Per-record emptiness is scoped to the SCHEMA's item fields when the
  // schema declares them. Seventeenth log: Object.values(el) picked up
  // synthetic keys the step's map added (serialNumber: 1, counts 0), so a
  // record whose every DECLARED field was empty read as non-empty and the
  // all-empty signal never fired.
  const itemFieldKeys = (key) => schemaArrayItemFieldKeys(props[key]) || [];

  const empty = [];
  for (const key of fieldKeys) {
    const v = data[key];
    if (isArrayOfObjects(key) && Array.isArray(v) && v.length === 0) {
      empty.push(key);
      continue;
    }
    if (!Array.isArray(v) || v.length === 0) continue; // scalar or empty scalar-array: leave to validateOutputAgainstSchema
    // Array of objects where every object has only empty values for the
    // fields in scope (schema item fields; all own keys as fallback when
    // the schema declares none — an empty {} record still counts as empty).
    const scoped = itemFieldKeys(key);
    const recordAllEmpty = (el) => {
      if (!el || typeof el !== 'object' || Array.isArray(el)) return false;
      const keys = scoped.length ? scoped : Object.keys(el);
      return keys.every(k => isEmptyValue(el[k]));
    };
    if (v.every(recordAllEmpty)) {
      empty.push(key);
    }
  }
  return empty;
}

// detectEmptyOutputFieldsByRatio(data, outputSchema, options?) → array of
// { field, path, emptyCount, totalCount, emptyRatio, sampleNonEmpty }
//
// Surfaces PARTIAL-EMPTY fields: fields declared in the schema that are empty
// in a significant fraction of records but NOT all (which findEmptyExtractionFields
// already handles as a separate case). A past feed-extraction incident
// (console.log 2026-07-27 RC15): finalResult had 3 posts with `likes` populated
// ("4","1","294") but `comments` and `shares` empty ("") across ALL records.
// findEmptyExtractionFields returned [] because the records had other non-empty
// fields (domHtml, author, content). The user-feedback autoFix prompt had no
// data-driven signal connecting "fields X,Y are empty across records" to the
// LLM — so glm-5.1 misread the ambiguous Chinese feedback ("为空的不正常") as
// "not enough posts" and rewrote the scroll step instead of fixing the
// extraction selectors.
//
// This function analyzes the finalResult OBJECTively: walks array-of-objects
// outputs, counts how often each declared sub-field is empty, and returns the
// fields whose emptyRatio exceeds a threshold. The autoFix prompt then has a
// data-driven "EMPTY FIELDS IN OUTPUT" block that pins the LLM's attention on
// the actual failing fields, regardless of how the user phrased the feedback.
//
// Threshold default 0.5: a field empty in >half of records is suspicious.
// Fields empty in 100% of records are included (findEmptyExtractionFields
// treats that as a different kind of failure but it's still a useful signal
// here for the prompt). `sampleNonEmpty` shows up to 3 non-empty values from
// the same record set, giving the LLM a contrastive example.
//
// options:
//   emptyRatioThreshold (default 0.5) — fields with emptyRatio >= this are
//     returned. Lower = more sensitive. 0 = return any field with at least
//     one empty value (rarely useful).
//   maxSamples (default 3) — cap on sampleNonEmpty values per field.
//   minRecords (default 1) — ignore output arrays shorter than this. The
//     default dropped to 1 in the twenty-seventh log: the only container on
//     a cold verify tab was a loading skeleton, the output had ONE record
//     with an items.required field (content) empty — and the ≥2 floor made
//     both this advisory signal and the REQUIRED_FIELD_EMPTY verify gate
//     blind to it, so a score-111 GREEN shipped. Emptiness in the only
//     record is total emptiness for that field; callers that genuinely
//     need a multi-record "pattern" pass { minRecords: 2 }.
function detectEmptyOutputFieldsByRatio(data, outputSchema, options) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  if (!outputSchema || typeof outputSchema !== 'object') return [];
  const opts = options || {};
  const threshold = typeof opts.emptyRatioThreshold === 'number' ? opts.emptyRatioThreshold : 0.5;
  const maxSamples = typeof opts.maxSamples === 'number' ? opts.maxSamples : 3;
  const minRecords = typeof opts.minRecords === 'number' ? opts.minRecords : 1;

  const isEmptyValue = (v) =>
    v === '' || v === null || v === undefined ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === 'string' && v.trim() === '');

  // Forty-eighth log: partialEmptyFields named a WORKING sample but never
  // WHICH records were empty M-bM-^@M-^T five verifies said postId 2/4 and the
  // model blind-rewrote the regex five times without ever re-probing. Each
  // census entry now fingerprints the empty records (1-based ordinal + the
  // record's longest other string, so record #2 can be matched to the photo
  // post by its content alone).
  const HINT_CAP = 60;
  const contentHint = (rec, excludeField) => {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return '';
    let best = '';
    for (const k of Object.keys(rec)) {
      if (k === excludeField) continue;
      const v = rec[k];
      if (typeof v === 'string' && v.trim() && v.trim().length > best.length) best = v.trim();
    }
    return best.slice(0, HINT_CAP);
  };

  const props = outputSchema.properties && typeof outputSchema.properties === 'object'
    ? outputSchema.properties
    : {};

  const result = [];
  // Seventy-eighth log: single-object output contracts. The census used to
  // walk ONLY array-typed properties, so a {answer,question,...} single-record
  // schema produced zero census entries — a missing required key had no
  // REQUIRED_FIELD_EMPTY path at all. When the schema declares NO top-level
  // array property, the result OBJECT itself is the one record: census each
  // declared top-level key against it.
  const propNames = Object.keys(props);
  const hasArrayProp = propNames.some((k) => props[k] && props[k].type === 'array');
  if (!hasArrayProp && propNames.length > 0) {
    for (const key of propNames) {
      if (!isEmptyValue(data[key])) continue;
      result.push({
        field: key,
        path: key,
        emptyCount: 1,
        totalCount: 1,
        emptyRatio: 1,
        sampleNonEmpty: [],
        emptyRecordSamples: [{ index: 1, hint: contentHint(data, key) }]
      });
    }
    return result;
  }

  for (const key of Object.keys(props)) {
    const prop = props[key];
    const fieldKeys = schemaArrayItemFieldKeys(prop);
    if (!fieldKeys) continue;
    const arr = data[key];
    if (!Array.isArray(arr) || arr.length < minRecords) continue;
    for (const fk of fieldKeys) {
      let emptyCount = 0;
      const samples = [];
      const emptyRecordSamples = [];
      for (let ri = 0; ri < arr.length; ri++) {
        const rec = arr[ri];
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
          emptyCount += 1;
          if (emptyRecordSamples.length < maxSamples) emptyRecordSamples.push({ index: ri + 1, hint: '' });
          continue;
        }
        const v = rec[fk];
        if (isEmptyValue(v)) {
          emptyCount += 1;
          if (emptyRecordSamples.length < maxSamples) emptyRecordSamples.push({ index: ri + 1, hint: contentHint(rec, fk) });
        } else if (samples.length < maxSamples) {
          samples.push(typeof v === 'string' ? v.slice(0, 80) : v);
        }
      }
      const emptyRatio = emptyCount / arr.length;
      if (emptyRatio < threshold) continue;
      result.push({
        field: fk,
        path: `${key}.${fk}`,
        emptyCount,
        totalCount: arr.length,
        emptyRatio,
        sampleNonEmpty: samples,
        emptyRecordSamples
      });
    }
    // Forty-seventh log: nested record arrays were scalar leaves here — a
    // non-empty hoverCards array with every card's `type` hardcoded '' read
    // "not empty" at depth 1 and nothing ever descended, so the contract's
    // richest structure was the one no census could see. Census sub-fields
    // of record-valued array fields across ALL nested records from ALL
    // parents, path 'a.b[].c', keys = schema-declared nested fields UNION
    // fields present in the data (declared-but-absent counts as empty;
    // present-but-undeclared still gets surfaced).
    const itemProps = (prop.items && prop.items.properties && typeof prop.items.properties === 'object' && !Array.isArray(prop.items.properties))
      ? prop.items.properties : null;
    for (const fk of fieldKeys) {
      const nestedDecl = itemProps ? itemProps[fk] : null;
      const nestedRecs = [];
      let parentsWithRecords = 0;
      for (let pi = 0; pi < arr.length; pi++) {
        const rec = arr[pi];
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
        const v = rec[fk];
        if (!Array.isArray(v)) continue;
        const objs = v.filter((c) => c && typeof c === 'object' && !Array.isArray(c));
        if (!objs.length) continue;
        parentsWithRecords += 1;
        objs.forEach((c, oi) => nestedRecs.push({ rec: c, parent: rec, parentIndex: pi + 1, subIndex: oi + 1 }));
      }
      if (!nestedRecs.length || nestedRecs.length < minRecords) continue;
      const nestedItemsProps = (nestedDecl && nestedDecl.type === 'array' && nestedDecl.items && typeof nestedDecl.items === 'object' && nestedDecl.items.properties && typeof nestedDecl.items.properties === 'object' && !Array.isArray(nestedDecl.items.properties))
        ? nestedDecl.items.properties : null;
      const subKeys = [];
      const seenSub = Object.create(null);
      if (nestedItemsProps) {
        for (const sk of Object.keys(nestedItemsProps)) { if (!seenSub[sk]) { seenSub[sk] = 1; subKeys.push(sk); } }
      }
      for (const nr of nestedRecs) {
        for (const sk of Object.keys(nr.rec)) { if (!seenSub[sk]) { seenSub[sk] = 1; subKeys.push(sk); } }
      }
      for (const sk of subKeys) {
        let nestedEmpty = 0;
        const nestedSamples = [];
        const nestedEmptySamples = [];
        for (const nr of nestedRecs) {
          const v = nr.rec[sk];
          if (isEmptyValue(v)) {
            nestedEmpty += 1;
            if (nestedEmptySamples.length < maxSamples) {
              nestedEmptySamples.push({ parentIndex: nr.parentIndex, subIndex: nr.subIndex, hint: contentHint(nr.parent, null) });
            }
          } else if (nestedSamples.length < maxSamples) {
            nestedSamples.push(typeof v === 'string' ? v.slice(0, 80) : v);
          }
        }
        const nestedRatio = nestedEmpty / nestedRecs.length;
        if (nestedRatio < threshold) continue;
        result.push({
          field: sk,
          path: `${key}.${fk}[].${sk}`,
          parentField: `${key}.${fk}`,
          parentRecords: parentsWithRecords,
          emptyCount: nestedEmpty,
          totalCount: nestedRecs.length,
          emptyRatio: nestedRatio,
          sampleNonEmpty: nestedSamples,
          emptyRecordSamples: nestedEmptySamples
        });
      }
    }
  }
  return result;
}

// formatEmptyOutputFieldsSignal(fields) → string
//
// Renders the output of detectEmptyOutputFieldsByRatio into a prompt-ready
// "EMPTY FIELDS IN OUTPUT" block. Returns '' when there's nothing to surface
// (so the caller can unconditionally interpolate the result).
//
// Format:
//   EMPTY FIELDS IN OUTPUT (data-driven — these fields are empty in >50% of
//   extracted records, regardless of how the user phrased their feedback):
//     - path: empty in N/M records (XX%). Other fields in the same records
//       produced values like: "sample1", "sample2". Find the step whose
//       selector / JS post-processing extracts `field` and fix it.
//
// Why this framing: when the LLM is told "fix the empty fields", it can
// mis-interpret ambiguous user feedback (Chinese "为空的不正常" was read as
// "not enough posts" instead of "fields are empty"). A data-driven signal
// that NAMES the failing fields and shows CONTRASTIVE non-empty examples
// from neighboring fields pins the LLM's attention on extraction-quality,
// not scroll/pagination.
function formatEmptyOutputFieldsSignal(fields) {
  if (!Array.isArray(fields) || fields.length === 0) return '';
  const lines = [];
  lines.push('EMPTY FIELDS IN OUTPUT (data-driven — these fields are empty in ≥50% of');
  lines.push('extracted records, regardless of how the user phrased their feedback —');
  lines.push('fix the step whose selector / JS post-processing produces these fields):');
  for (const f of fields) {
    const pct = Math.round((f.emptyRatio || 0) * 100);
    const samples = (f.sampleNonEmpty || [])
      .filter(s => s !== '' && s !== null && s !== undefined)
      .slice(0, 3)
      .map(s => typeof s === 'string' ? `"${s.slice(0, 60)}"` : JSON.stringify(s));
    const tail = samples.length > 0
      ? ` Other fields in the same records produced values like: ${samples.join(', ')} — so the container selector is correct; only this sub-field's selector is wrong.`
      : '';
    lines.push(`  - ${f.path}: empty in ${f.emptyCount}/${f.totalCount} records (${pct}%).${tail}`);
  }
  return lines.join('\n');
}

// detectDuplicateRecords(data, outputSchema, options?) → array of
// { field, totalRecords, uniqueSignatures, duplicateRatio, sampleDuplicate }
//
// Surfaces the all-identical-records antipattern: when N≥minRecords records in
// an array-of-objects output share the SAME signature (stable JSON of declared
// sub-field values), the extraction is broken — almost always because the
// script wrote a per-record loop with GLOBAL sub-queries (so every iteration
// captures the same first-match values).
//
// console.log 2026-08-04 04:30:09 incident: feed search step 4 produced 10
// IDENTICAL posts because the LLM-generated loop was:
//
//   const articles = await $list('div[role="article"]');
//   for (const article of articles) {
//     const groupEls = await $list('div[role="article"] h3 a[href*="/groups/"] span'); // ← GLOBAL
//     if (groupEls.length > 0) group = groupEls[0].textContent;  // always same first match
//     // ...same global pattern for username, content, likes, comments, shares
//     posts.push({ group, username, content, ... });
//   }
//
// findEmptyExtractionFields returned [] (no field is empty — they're all set
// to the SAME first-match value). detectEmptyOutputFieldsByRatio returned []
// (no field is empty in >50% of records — they're all populated). The
// framework's EMPTY_EXTRACTION / EMPTY_FIELDS detectors couldn't fire, so
// testScript reported SUCCESS and 10 identical records nearly shipped. The
// detector below closes that gap.
//
// SIGNATURE: we hash the JSON serialization of the record's declared sub-field
// values (per outputSchema). Records with the same field values produce the
// same signature. Only declared fields participate — incidental key
// differences (e.g. one record has a debugging key another lacks) don't
// fragment the signature.
//
// THRESHOLDS (default conservative — block deploy only on the unambiguous case):
//   - minRecords (default 3): can't establish a "duplicate pattern" with <3.
//   - duplicateRatioThreshold (default 1.0 = 100%): only flag when EVERY
// getFirstRecordHtmlFromExecution(events, stepId) → string
//
// Scans executionEvents for STEP_ITERATION events matching stepId, walks each
// event's selectorDiagnostics array, and returns the first non-empty
// firstContainerHtml string found. Returns '' when no matching event or no
// diagnostic carries firstContainerHtml.
//
// Why this exists (2026-08-07 RC32 followup): the initial FIELD CANDIDATES
// wiring tried to read record HTML from `finalData[0]._html` /
// `finalData[0].outerHTML`, but output records are FLAT LLM-extracted values
// (strings, arrays) — they don't carry source HTML. The actual per-record
// HTML is captured at extraction time by computeExtractListDiagnostics (see
// lib/list-extract-ops.js) as `firstContainerHtml`, and surfaced in the
// autoFix prompt via summarizeAllStepDiagnostics as the RECORD HTML block.
// That same source is what discovery needs to scan for leaf candidates.
//
// Generic — works for any site, any extraction step that uses $extractList /
// $extractListMulti / $list with diagnostics instrumentation.
function getFirstRecordHtmlFromExecution(events, stepId) {
  if (!Array.isArray(events) || events.length === 0) return '';
  if (!stepId) return '';
  for (const evt of events) {
    if (!evt || evt.type !== 'STEP_ITERATION') continue;
    if (evt.stepId !== stepId) continue;
    const diags = Array.isArray(evt.selectorDiagnostics) ? evt.selectorDiagnostics : [];
    for (const d of diags) {
      if (d && typeof d.firstContainerHtml === 'string' && d.firstContainerHtml.length > 0) {
        return d.firstContainerHtml;
      }
    }
  }
  return '';
}

// getFirstRecordHtmlFromAnyStep(events) → string
//
// Fallback when getFirstRecordHtmlFromExecution returns '' for the chosen
// stepId. Scans ALL STEP_ITERATION events for any firstContainerHtml. Use when
// the upstream-extraction resolver picks a $list-using step (which doesn't
// capture firstContainerHtml) instead of the real $extractList/$extractListMulti
// step — the record HTML is the record HTML regardless of provenance, and
// field-candidate discovery just needs SOME container snapshot to scan.
//
// Console.log 2026-08-11: production service had step4=$extractListMulti (the
// real extractor, with firstContainerHtml) and step5=hover_enrich (uses $list
// for media URLs). findUpstreamExtractionStepId returned step5 because the
// regex matches $list too — so the chosen-step lookup returned '' and the
// FIELD_CANDIDATES signal was silently suppressed. This fallback recovers.
function getFirstRecordHtmlFromAnyStep(events) {
  if (!Array.isArray(events) || events.length === 0) return '';
  for (const evt of events) {
    if (!evt || evt.type !== 'STEP_ITERATION') continue;
    const diags = Array.isArray(evt.selectorDiagnostics) ? evt.selectorDiagnostics : [];
    for (const d of diags) {
      if (d && typeof d.firstContainerHtml === 'string' && d.firstContainerHtml.length > 0) {
        return d.firstContainerHtml;
      }
    }
  }
  return '';
}

// detectDuplicateRecords(data, outputSchema, options) → array
//
// Schema-aware duplicate detector. Locates the first array-of-objects field
// declared in outputSchema (mirrors detectEmptyOutputFieldsByRatio's lookup)
// and emits one entry per pair of records whose non-empty field values are
// ALL identical. Used by the autoFix prompt builder to surface duplicate-
// record scenarios (e.g. a step accidentally returning the same record N
// times because its selector matches a wrapper that contains all entries).
//
// Options:
//   - duplicateRatioThreshold (default 1.0): fraction of NON-EMPTY fields
//     that must be identical for two records to count as duplicates. Each
//     record is identical. Caller can lower this (e.g. 0.8) for partial
//     detection, but the framework's THROW path uses the default — anything
//     less strict risks blocking deploy when the script produced real
//     diversity alongside a few duplicates.
//
// RETURN SHAPE mirrors detectEmptyOutputFieldsByRatio so the autoFix prompt
// builder can consume either uniformly.
function detectDuplicateRecords(data, outputSchema, options) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  if (!outputSchema || typeof outputSchema !== 'object') return [];
  const opts = options || {};
  const threshold = typeof opts.duplicateRatioThreshold === 'number'
    ? opts.duplicateRatioThreshold
    : 1.0;
  const minRecords = typeof opts.minRecords === 'number' ? opts.minRecords : 3;

  const isEmptyValue = (v) =>
    v === '' || v === null || v === undefined ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === 'string' && v.trim() === '');

  const signatureFor = (rec, fieldKeys) => {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
    const parts = [];
    for (const fk of fieldKeys) {
      const v = rec[fk];
      // Normalize: empty → '' so that records differing only in WHICH empty
      // representation they used (null vs '' vs undefined) still collide.
      const norm = isEmptyValue(v) ? '' : v;
      parts.push(fk + ':' + (typeof norm === 'string' ? norm : JSON.stringify(norm)));
    }
    return parts.join('||');
  };

  const props = outputSchema.properties && typeof outputSchema.properties === 'object'
    ? outputSchema.properties
    : {};
  const result = [];
  for (const key of Object.keys(props)) {
    const prop = props[key];
    const fieldKeys = schemaArrayItemFieldKeys(prop);
    if (!fieldKeys) continue;
    const arr = data[key];
    if (!Array.isArray(arr) || arr.length < minRecords) continue;

    // Count signatures. We don't break early because the caller may want
    // partial-duplicate stats (lower threshold).
    const sigCounts = new Map();
    let firstSig = null;
    for (let i = 0; i < arr.length; i++) {
      const sig = signatureFor(arr[i], fieldKeys);
      if (sig === null) continue;
      if (i === 0 || firstSig === null) firstSig = sig;
      sigCounts.set(sig, (sigCounts.get(sig) || 0) + 1);
    }
    if (sigCounts.size === 0) continue;
    // largest signature count
    let maxCount = 0;
    let maxSig = null;
    for (const [sig, cnt] of sigCounts) {
      if (cnt > maxCount) { maxCount = cnt; maxSig = sig; }
    }
    const dupRatio = maxCount / arr.length;
    if (dupRatio < threshold) continue;

    // Render a sample duplicate for display. Truncate long values so the
    // autoFix prompt doesn't balloon.
    const renderSample = (sig) => {
      const parts = sig.split('||');
      const truncated = parts.map(p => {
        const idx = p.indexOf(':');
        if (idx < 0) return p;
        const k = p.slice(0, idx);
        let v = p.slice(idx + 1);
        if (v.length > 80) v = v.slice(0, 77) + '...';
        return `${k}=${v}`;
      });
      return '{ ' + truncated.join(', ') + ' }';
    };

    result.push({
      field: key,
      totalRecords: arr.length,
      uniqueSignatures: sigCounts.size,
      duplicateRatio: dupRatio,
      sampleDuplicate: renderSample(maxSig)
    });
  }
  return result;
}

// Fortieth log: ENTITY-level duplication. A container selector like
// `div[feed] div[virtualized]:has([story])` matches the SAME card at TWO
// nesting levels (:has() qualifies EVERY ancestor; a union list qualifies
// wrapper AND card), so each entity ships twice — IDENTICAL data fields,
// DIFFERING wrapper htmlSnippet — and slips past detectDuplicateRecords
// (whose all-identical signature includes the wrapper field, splitting
// the pairs). The entity fingerprint below EXCLUDES bookkeeping fields
// (index/serial/position) and raw-wrapper fields (htmlSnippet-class), so
// same-entity captures collide no matter which depth produced them.
// Fires when the largest entity group holds ≥2 records and ≥minRatio
// (default 0.5) of the array — the double-count lie-class, where "N
// records" is announced while fewer distinct entities exist.
//
// UNIVERSALITY: not site-specific — any nested-match container on any
// feed/list produces this signature.
const ENTITY_BOOKKEEPING_FIELD = /^(index|idx|sn|serial|position|order|seq|sequence)$/i;
const ENTITY_RAWISH_FIELD = /(html|markup|snippet|raw|source|embedded|dom)/i;

function detectDuplicateEntities(data, outputSchema, options) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  if (!outputSchema || typeof outputSchema !== 'object') return [];
  const opts = options || {};
  const minRatio = typeof opts.minRatio === 'number' ? opts.minRatio : 0.5;
  const isEmptyValue = (v) =>
    v === '' || v === null || v === undefined ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === 'string' && v.trim() === '');
  const splitCamel = (k) => String(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  const props = outputSchema.properties && typeof outputSchema.properties === 'object'
    ? outputSchema.properties
    : {};
  const result = [];
  for (const key of Object.keys(props)) {
    const prop = props[key];
    const fieldKeys = schemaArrayItemFieldKeys(prop);
    if (!fieldKeys) continue;
    const arr = data[key];
    if (!Array.isArray(arr) || arr.length < 2) continue;
    const sigKeys = fieldKeys.filter((fk) => {
      const sp = splitCamel(fk);
      if (ENTITY_BOOKKEEPING_FIELD.test(sp)) return false;
      if (ENTITY_RAWISH_FIELD.test(fk) || ENTITY_RAWISH_FIELD.test(sp)) return false;
      return true;
    });
    // Nothing semantic left to compare: with only bookkeeping + wrapper
    // fields declared, every collision would be a meaningless one (all
    // records share '' on those once excluded) — skip instead of firing.
    if (!sigKeys.length) continue;
    const sigCounts = new Map();
    let maxCount = 0;
    let maxSig = null;
    for (const rec of arr) {
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
      const normVals = sigKeys.map((fk) => {
        const v = rec[fk];
        if (isEmptyValue(v)) return '';
        return typeof v === 'string' ? v : JSON.stringify(v);
      });
      // Nineteenth-log guard: a record whose every entity field is empty
      // carries NO entity — its all-'' signature collides with every other
      // empty record, which is emptiness (the partial-empty census owns
      // that signal), not duplication. Skip it from the entity count.
      if (normVals.every((nv) => nv === '')) continue;
      const sig = sigKeys.map((fk, i) => fk + ':' + normVals[i]).join('||');
      const c = (sigCounts.get(sig) || 0) + 1;
      sigCounts.set(sig, c);
      if (c > maxCount) { maxCount = c; maxSig = sig; }
    }
    if (!maxSig || maxCount < 2) continue;
    const ratio = maxCount / arr.length;
    if (ratio < minRatio) continue;
    result.push({
      field: key,
      totalRecords: arr.length,
      duplicateCount: maxCount,
      distinctEntities: sigCounts.size,
      duplicateRatio: ratio,
      signatureFields: sigKeys.slice(0, 6)
    });
  }
  return result;
}

// detectOversizedFields(data, outputSchema) → [{field, count, total, maxLen, avgLen}]
//
// Forty-first log: whole-card `attr:'outerHTML'` fields came back
// 82396-99278 chars each (result.json: 332KB for 3 posts). The read layer now
// caps element-HTML property reads at 50000 with a disclosure suffix, but a
// capped-or-uncapped multi-myriad-char field still means the selector grabbed
// whole-card DOM (class names + inline styles + SVG paths) where a semantic
// sub-element was available. This census REPORTS such fields — it never
// blocks, because a big field can be the confirmed contract's honest shape.
// UNIVERSALITY: pure data shape check, no site specifics.
const OVERSIZED_FIELD_THRESHOLD = 20000;
function detectOversizedFields(data, outputSchema) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const out = [];
  const censusStrings = (recs, fields, labelOf) => {
    for (const f of fields) {
      let count = 0, totalLen = 0, maxLen = 0, n = 0;
      const nestedRecs = [];
      for (const r of recs) {
        const v = r[f];
        if (typeof v === 'string') {
          n++; totalLen += v.length;
          if (v.length > maxLen) maxLen = v.length;
          if (v.length > OVERSIZED_FIELD_THRESHOLD) count++;
        } else if (Array.isArray(v)) {
          // Forty-seventh log: a record field holding an array of records
          // was skipped whole — 52818-66956-char card markup rode under
          // the census while depth 1 saw a non-string leaf. Collect nested
          // records and measure their string sub-fields ('a.b[].c' paths).
          for (const c of v) if (c && typeof c === 'object' && !Array.isArray(c)) nestedRecs.push(c);
        }
      }
      if (count > 0) {
        out.push({ field: labelOf(f), count, total: recs.length, maxLen, avgLen: n ? Math.round(totalLen / n) : 0 });
      }
      if (nestedRecs.length) {
        const subNames = new Set();
        for (const c of nestedRecs) for (const sk of Object.keys(c)) subNames.add(sk);
        for (const sf of subNames) {
          let sc = 0, st = 0, sm = 0, sn = 0;
          for (const c of nestedRecs) {
            const sv = c[sf];
            if (typeof sv !== 'string') continue;
            sn++; st += sv.length;
            if (sv.length > sm) sm = sv.length;
            if (sv.length > OVERSIZED_FIELD_THRESHOLD) sc++;
          }
          if (sc > 0) {
            out.push({ field: labelOf(f) + '[].' + sf, count: sc, total: nestedRecs.length, maxLen: sm, avgLen: sn ? Math.round(st / sn) : 0 });
          }
        }
      }
    }
  };
  for (const key of Object.keys(data)) {
    const value = data[key];
    if (Array.isArray(value)) {
      const recs = value.filter((r) => r && typeof r === 'object' && !Array.isArray(r));
      if (!recs.length) continue;
      const fieldNames = new Set();
      for (const r of recs) for (const k of Object.keys(r)) fieldNames.add(k);
      censusStrings(recs, fieldNames, (f) => key + '.' + f);
    } else if (typeof value === 'string' && value.length > OVERSIZED_FIELD_THRESHOLD) {
      out.push({ field: key, count: 1, total: 1, maxLen: value.length, avgLen: value.length });
    }
  }
  return out;
}

// Forty-seventh log F3: posts.htmlSnippet shipped content.slice(0,500) —
// plain text under a markup-named field on a green verify (score 133). A
// captured DOM region always contains tags; a non-empty value with zero
// '<' is text copied from a sibling field (or fabricated), never captured
// markup. copiedFrom names the sibling whose value carries this value
// verbatim/as a prefix whenever the copy is provable. Report-only: the
// confirmed contract may honestly want a text field under that name —
// surface, teach, never block.
function detectHtmlFieldsWithoutTags(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const MARKUP_NAME_RE = /html|markup/i;
  const out = [];
  const census = (recs, labelOf) => {
    const fieldNames = new Set();
    for (const r of recs) for (const k of Object.keys(r)) fieldNames.add(k);
    for (const f of fieldNames) {
      if (!MARKUP_NAME_RE.test(f)) continue;
      let count = 0, maxLen = 0;
      const samples = [];
      for (const r of recs) {
        const v = r[f];
        if (typeof v !== 'string' || !v.length || v.indexOf('<') !== -1) continue;
        count++;
        if (v.length > maxLen) maxLen = v.length;
        if (samples.length < 2) samples.push(v.slice(0, 60));
      }
      if (!count) continue;
      const probe = recs.find((r) => typeof r[f] === 'string' && r[f].length && r[f].indexOf('<') === -1);
      const val = probe ? probe[f] : '';
      const sib = probe ? Object.keys(probe).find((s) => {
        if (s === f || MARKUP_NAME_RE.test(s)) return false;
        const sv = probe[s];
        return typeof sv === 'string' && sv.length > 0 &&
          (sv === val || (val.length >= 16 && sv.indexOf(val) === 0));
      }) : null;
      out.push({ field: labelOf(f), path: labelOf(f), count, total: recs.length, maxLen, copiedFrom: sib || null, samples });
    }
  };
  for (const key of Object.keys(data)) {
    const value = data[key];
    if (!Array.isArray(value)) continue;
    const recs = value.filter((r) => r && typeof r === 'object' && !Array.isArray(r));
    if (!recs.length) continue;
    census(recs, (f) => key + '.' + f);
    const fieldNames = new Set();
    for (const r of recs) for (const k of Object.keys(r)) fieldNames.add(k);
    for (const f of fieldNames) {
      const nested = [];
      for (const r of recs) {
        const v = r[f];
        if (Array.isArray(v)) for (const c of v) if (c && typeof c === 'object' && !Array.isArray(c)) nested.push(c);
      }
      if (nested.length) census(nested, (sf) => key + '.' + f + '[].' + sf);
    }
  }
  return out;
}

// Forty-seventh log F2: the REQUIRED_FIELD_EMPTY gate resolved only depth-1
// paths ('posts.location') against the top array's items.required. A nested
// path ('posts.hoverCards[].type') is governed by the DECLARING array's
// items.required (hoverCards'), not the outer records'. Walk the path
// segments down through each array's items and return the required list
// that governs the FINAL field name (null when any hop is not a declared
// record array or the declaring items carry no required list).
function schemaItemRequiredForPath(outputSchema, path) {
  if (!outputSchema || typeof outputSchema !== 'object' || !outputSchema.properties || typeof outputSchema.properties !== 'object' || Array.isArray(outputSchema.properties)) return null;
  if (typeof path !== 'string' || !path.length) return null;
  const segs = path.split('.');
  if (segs.length < 2) {
    // Seventy-eighth log: single-segment paths arise from the single-object
    // output contract census (path = the top-level key itself). The requiring
    // node for a non-array top-level property is the ROOT schema's required
    // array. Array-typed keys keep the null (their census paths are dotted
    // 'a.b' forms resolved by the walk below).
    const name = segs[0].replace(/\[\]$/, '');
    if (!name) return null;
    const prop = outputSchema.properties[name];
    if (!prop || prop.type === 'array') return null;
    return Array.isArray(outputSchema.required) ? outputSchema.required.map(String) : null;
  }
  let node = outputSchema;
  for (let i = 0; i < segs.length - 1; i++) {
    const name = segs[i].replace(/\[\]$/, '');
    const props = (node && node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)) ? node.properties : null;
    const prop = props ? props[name] : null;
    if (!prop || prop.type !== 'array' || !prop.items || typeof prop.items !== 'object' || Array.isArray(prop.items)) return null;
    node = prop.items;
  }
  const finalName = segs[segs.length - 1].replace(/\[\]$/, '');
  if (!finalName) return null;
  return Array.isArray(node.required) ? node.required.map(String) : null;
}

// detectCountShortfall(data, inputValues, outputSchema, options) → null | {field, requested, extracted, ratio, severe}
//
// Seventh-log survey (2026-09-01): a search-posts service declared input
// count:10 and every "SUCCESS" run returned posts:[1 record] — an ad card
// picked by an inverted container filter. EMPTY_EXTRACTION catches all-empty
// arrays, chronic-empty detection catches empty FIELDS, but nothing compared
// the extracted record count against the requested count, so neither the
// result UI nor the autoFix loop ever saw the shortfall. This detector
// reports it; it deliberately does NOT force retries — a selector that keeps
// only a tiny card subset cannot be fixed by scrolling harder, and pushing
// the scroll loop toward an unreachable count is the ZERO-TRAP deadlock.
// Forty-sixth log: the severe-only gate (extracted >= half → silent) hid the
// log's own 3-of-5 ship — the user asked for five, the report said nothing.
// Now EVERY shortfall under the request is reported with a `severe` flag
// (<0.5); the COUNT_SHORTFALL tag/knowledge attach stays severe-only so a
// 9/10 run is not nagged, but the report and the finish ladder disclose all.
function detectCountShortfall(data, inputValues, outputSchema, options) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (!inputValues || typeof inputValues !== 'object') return null;
  if (!outputSchema || typeof outputSchema !== 'object') return null;
  const opts = options || {};
  const severeRatio = typeof opts.severeRatio === 'number' ? opts.severeRatio : 0.5;
  const minRequested = typeof opts.minRequested === 'number' ? opts.minRequested : 3;

  // Requested-count inputs: exact forms first (count/limit/top/num), then
  // compound forms that name a subject AND a quantity (maxPosts, numResults,
  // resultCount). Keys like timeoutMs or pageNumber carry neither shape.
  const EXACT_COUNT_KEYS = /^(count|limit|top|num|number|n)$/i;
  const SUBJECT_TOKEN = /(item|record|result|post|row|entry|product|card|feed|listing)s?/i;
  const QUANTITY_TOKEN = /(count|limit|num|number|max|total|top)/i;
  let requested = null;
  let requestedKey = null;
  for (const key of Object.keys(inputValues)) {
    const raw = inputValues[key];
    const num = typeof raw === 'number' ? raw : (typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN);
    if (!Number.isFinite(num) || num < minRequested) continue;
    const k = String(key);
    const isExact = EXACT_COUNT_KEYS.test(k);
    const isCompound = SUBJECT_TOKEN.test(k) && QUANTITY_TOKEN.test(k);
    if (!isExact && !isCompound) continue;
    // Prefer the exact form; among equals keep the largest ask.
    if (requested === null || (isExact && !EXACT_COUNT_KEYS.test(requestedKey)) || (isExact === EXACT_COUNT_KEYS.test(requestedKey) && num > requested)) {
      requested = num;
      requestedKey = k;
    }
  }
  if (requested === null) return null;

  const props = outputSchema.properties && typeof outputSchema.properties === 'object'
    ? outputSchema.properties
    : {};
  let worst = null;
  for (const key of Object.keys(props)) {
    const prop = props[key];
    // Count comparison only needs the array itself — a fielded items node is
    // NOT required (nineteenth log: typeless items must not hide a shortfall).
    if (!prop || prop.type !== 'array') continue;
    const arr = data[key];
    const extracted = Array.isArray(arr) ? arr.length : 0;
    if (extracted >= requested) continue;
    if (!worst || extracted > worst.extracted) {
      worst = { field: key, requested: requested, extracted: extracted };
    }
  }
  if (!worst) return null;
  worst.ratio = requested > 0 ? (worst.extracted / requested) : 0;
  // Inclusive boundary: delivering at most half the requested count is severe
  // (5/10 must not slip under a strict <).
  worst.severe = worst.ratio <= severeRatio;
  return worst;
}

// detectRelativeTimestamps(data, outputSchema) → [] | [{field, path, sampleValue, relativeCount, totalRecords}]
//
// Forty-sixth log: postTime shipped "a day ago" / "August 27 at 9:01 PM"
// while the schema note described the field as the absolute timestamp read
// from the tooltip — a string is a string, so every shape check passed and
// the green verify blessed relative ages as the contracted value. A time-like
// field whose values are RELATIVE ages (EN "a day ago"/"yesterday", ZH
// "3天前"/"昨天") is almost always the rendered age label, not the underlying
// timestamp: the absolute value typically lives in the element's datetime
// attribute, the tooltip/labelledby reference, or the hovercard. Report-only
// — the fix is a rebind or a contract renegotiation, never a silent ship.
function detectRelativeTimestamps(data, outputSchema) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  if (!outputSchema || typeof outputSchema !== 'object') return [];
  const props = outputSchema.properties && typeof outputSchema.properties === 'object'
    ? outputSchema.properties
    : {};
  const TIME_FIELD = /time|date|时间|日期|发布|created|updated|published/i;
  // EN: "just now", "5 min ago", "a day ago", "yesterday", "last week"…
  // ZH: 刚刚 / 3分钟前 / 5小时前 / 3天前 / 2周前 / 6个月前 / 昨天 / 前天 / 上周 / 去年…
  const RELATIVE_VALUE = /^\s*(just now|moments? ago|(a|an|few|several|\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|week|weeks|mo|month|months|y|yr|year|years)\s+ago|yesterday|today|tomorrow|last\s+(night|week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|刚刚|刚才|几[秒分小天周月年]前|\d+\s*(秒|分钟|分|小?时|天|日|周|星期|礼拜|个?月|年)前|今天|昨天|前天|大前天|明天|上周|上个月|上月|去年|前年)\s*$/i;
  const isRelative = (v) => typeof v === 'string' && v.trim() && RELATIVE_VALUE.test(v);

  const out = [];
  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (!prop || typeof prop !== 'object') continue;
    if (prop.type === 'array') {
      const arr = data[key];
      if (!Array.isArray(arr) || !arr.length) continue;
      const itemProps = (prop.items && prop.items.properties && typeof prop.items.properties === 'object')
        ? prop.items.properties
        : null;
      if (!itemProps) continue;
      for (const f of Object.keys(itemProps)) {
        if (!TIME_FIELD.test(f)) continue;
        let relativeCount = 0;
        let partialCount = 0;
        let total = 0;
        let sample = null;
        let partialSample = null;
        for (const rec of arr) {
          if (!rec || typeof rec !== 'object') continue;
          total += 1;
          const v = rec[f];
          if (isRelative(v)) {
            relativeCount += 1;
            if (!sample) sample = v;
          } else if (typeof v === 'string' && v.trim() && looksLikeDate(v) && !hasYearToken(v)) {
            // Sixty-ninth log: "August 2" is a PARTIAL absolute — date-shaped,
            // not a relative age, so the relative census never named it, yet it
            // lacks the year the hover tooltip usually carries. Mixed
            // populations render recent items as relative ages and older ones
            // as month-day.
            partialCount += 1;
            if (!partialSample) partialSample = v;
          }
        }
        if (relativeCount > 0 || partialCount > 0) {
          const entry = {
            field: f,
            path: key + '.' + f,
            sampleValue: sample || partialSample,
            relativeCount: relativeCount,
            partialAbsoluteCount: partialCount,
            partialSample: partialSample,
            totalRecords: total
          };
          if (partialCount > 0) {
            entry.note = String(partialSample).slice(0, 60) + ' (no year — partial absolute; the hover tooltip often carries the full date)';
          }
          out.push(entry);
        }
      }
    } else if (prop.type === 'string' && TIME_FIELD.test(key)) {
      const v = data[key];
      const partialOnly = typeof v === 'string' && v.trim() && !isRelative(v) && looksLikeDate(v) && !hasYearToken(v);
      if (isRelative(v) || partialOnly) {
        const entry = {
          field: key,
          path: key,
          sampleValue: v,
          relativeCount: isRelative(v) ? 1 : 0,
          partialAbsoluteCount: partialOnly ? 1 : 0,
          partialSample: partialOnly ? v : null,
          totalRecords: 1
        };
        if (partialOnly) {
          entry.note = String(v).slice(0, 60) + ' (no year — partial absolute; the hover tooltip often carries the full date)';
        }
        out.push(entry);
      }
    }
  }
  return out;
}

// formatDuplicateRecordsSignal(dupes) → string
//
// Renders the output of detectDuplicateRecords into a prompt-ready
// "DUPLICATE RECORDS IN OUTPUT" block. Returns '' when there's nothing to
// surface (so the caller can unconditionally interpolate).
//
// The block names the failing field, the count of identical records, and
// tells the LLM the most likely cause (global sub-selector inside a per-record
// loop) and the fix (use $extractListMulti or scope querySelector).
function formatDuplicateRecordsSignal(dupes) {
  if (!Array.isArray(dupes) || dupes.length === 0) return '';
  const lines = [];
  lines.push('DUPLICATE RECORDS IN OUTPUT (data-driven — these array-of-objects outputs contain');
  lines.push('multiple identical records; the script almost certainly uses a global sub-selector');
  lines.push('inside a per-record loop, capturing the same first-match values on every iteration.');
  lines.push('Fix the step using $extractListMulti with per-record sub-selectors, or scope queries');
  lines.push('to the current record element via element.querySelector):');
  for (const d of dupes) {
    const pct = Math.round((d.duplicateRatio || 0) * 100);
    lines.push(`  - ${d.field}: ${d.totalRecords} records, only ${d.uniqueSignatures} unique signature(s); ${pct}% identical.`);
    if (d.sampleDuplicate) {
      lines.push(`    Sample duplicate: ${d.sampleDuplicate}`);
    }
  }
  return lines.join('\n');
}

// Enumerate the output fields a user can map an annotated selector to.
// Scalar outputs expose their top-level keys. Array-of-objects outputs
// (e.g. posts: [{group, username, ...}]) descend into the array item's
// properties so the user can label a selector with a specific sub-field —
// without this, the dropdown only shows "posts" and the user has no way to
// indicate which sub-field each selector extracts. Dotted value (posts.group)
// preserves the array context for downstream LLM guidance.
//
// 2026-08-05: recurse into NESTED object properties too. The prior version
// only descended one level (array.items.properties.<key>), so schemas like
// posts[].groupInfo.groupName exposed only "posts.groupInfo" in the dropdown
// — the user could not label inner fields. With recursion, the dropdown
// offers "posts → groupInfo → groupName" so each inner field can be
// annotated with its own selector. Handles `type:'object'` AND nullable
// variants like `type:['object','null']`.
function getOutputFieldOptions(outputSchema) {
  if (!outputSchema || !outputSchema.properties || typeof outputSchema.properties !== 'object') return [];
  const options = [];
  for (const key of Object.keys(outputSchema.properties)) {
    collectFieldOptions(outputSchema.properties[key], key, options, 0);
  }
  return options;
}

// Recursive helper for getOutputFieldOptions. Walks object/array-of-object
// properties depth-first, emitting a {value,label} option for each LEAF
// (scalars and arrays-of-scalars). Depth cap is defensive against
// accidentally-cyclic schemas.
function collectFieldOptions(prop, prefix, options, depth) {
  if (!prop || typeof prop !== 'object' || depth > 8) return;
  const types = Array.isArray(prop.type) ? prop.type : [prop.type];
  const isObject = types.includes('object');
  const isArray = types.includes('array');

  if (isArray && prop.items && prop.items.properties) {
    // Array of objects: descend into each item property.
    for (const innerKey of Object.keys(prop.items.properties)) {
      collectFieldOptions(prop.items.properties[innerKey], `${prefix}.${innerKey}`, options, depth + 1);
    }
  } else if (isObject && prop.properties) {
    // Nested object (incl. ['object','null']): descend into its properties.
    for (const innerKey of Object.keys(prop.properties)) {
      collectFieldOptions(prop.properties[innerKey], `${prefix}.${innerKey}`, options, depth + 1);
    }
  } else {
    // Leaf (scalar, array-of-scalars, or scalar array): emit.
    options.push({ value: prefix, label: prefix.split('.').join(' → ') });
  }
}

// Module-scope helper: lazy-require dom-cleaner without throwing if the module
// cannot be resolved in the current environment (e.g. some restricted test envs).
// Kept at module scope so it is NOT redefined on every truncateSnapshotForLLM call.
function safeRequireDomCleaner() {
  try { return require('./dom-cleaner.js'); } catch (_) { return null; }
}

// Thin wrapper: delegates to DomCleaner.cleanHtmlForLLM for structure-preserving
// tiered degradation. Abolished: substring(0, budget) blunt-cut. The function
// preserves the same external signature so callers don't need changes.
//
// Behavior:
// - Non-object / null input → returned as-is.
// - Snapshot already carrying a `mode` field (already tiered by DomCleaner or
//   by an upstream caller) → passed through unchanged. We do not re-cut.
// - Snapshot with a raw `.html` field → DomCleaner.cleanHtmlForLLM chooses a
//   tier (full / annotated / compressed / needs_subtree_selection) based on
//   budget and annotations; the chosen fields are merged into the snapshot.
// - DomCleaner unavailable (rare) → snapshot returned unchanged.
function truncateSnapshotForLLM(snapshot, budget = 30000) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  // Already-tiered snapshots (produced by DomCleaner.cleanHtmlForLLM) pass
  // through. Their mode/fingerprint were chosen by the cleaner; we do not re-cut.
  if (snapshot.mode) return snapshot;
  // Legacy snapshot with raw .html field: delegate to DomCleaner.cleanHtmlForLLM
  // for structure-preserving tiered degradation. Abolished: substring(0, budget).
  if (snapshot.html) {
    const DomCleaner = (typeof global !== 'undefined' && global.DomCleaner)
      || (typeof window !== 'undefined' && window.DomCleaner)
      || (typeof require === 'function' ? safeRequireDomCleaner() : null);
    if (DomCleaner && typeof DomCleaner.cleanHtmlForLLM === 'function') {
      const result = DomCleaner.cleanHtmlForLLM(snapshot.html, snapshot.annotations || [], budget);
      return { ...snapshot, ...result };
    }
    // DomCleaner unavailable (rare, test env): leave snapshot unchanged.
    return snapshot;
  }
  return snapshot;
}

// summarizeStepsGeneration: compact summary of the initial step-generation
// prompt for the llmHistory. Replaces the old blunt-cut truncation of the
// raw prompt. Captures the key signals an autoFix round might need:
// URL, description, html fingerprint, confirmed selectors.
function summarizeStepsGeneration({ url, description, htmlFingerprint, confirmedSelectors } = {}) {
  const lines = [];
  lines.push('[Script Generation]');
  lines.push('URL: ' + (url || '(unknown)'));
  lines.push('Description: ' + (description || '(none)'));
  lines.push('Page HTML fingerprint: ' + (htmlFingerprint || '(unknown)'));
  if (Array.isArray(confirmedSelectors) && confirmedSelectors.length > 0) {
    lines.push('Confirmed selectors:');
    for (const s of confirmedSelectors) {
      const sel = s.status === 'revised' ? s.revisedSelector : s.selector;
      lines.push('  - ' + (s.purpose || '(no purpose)') + ': ' + sel);
    }
  } else {
    lines.push('Confirmed selectors: (none)');
  }
  return lines.join('\n');
}

// summarizeGeneratedSteps: compact summary of the LLM's step-generation
// response. Strips script bodies (those live in wizardState.steps), keeps
// topology (id/name/onSuccess/onFailure/maxIterations) + schemas.
function summarizeGeneratedSteps(rawResult) {
  if (!rawResult || typeof rawResult !== 'string') return '(no response)';
  let parsed;
  try {
    parsed = JSON.parse(rawResult);
  } catch (_) {
    // Try to find a JSON object in code fences
    const m = rawResult.match(/\{[\s\S]*\}/);
    if (!m) return rawResult.slice(0, 1500);
    try { parsed = JSON.parse(m[0]); } catch (__) { return rawResult.slice(0, 1500); }
  }
  const lines = [];
  lines.push('[Generated Steps]');
  if (Array.isArray(parsed.steps)) {
    lines.push('Steps:');
    for (const step of parsed.steps) {
      const s = step || {};
      const parts = ['  - id:' + (s.id || '?'), 'name:' + (s.name || '')];
      if (s.onSuccess) parts.push('onSuccess:' + s.onSuccess);
      if (s.onFailure) parts.push('onFailure:' + s.onFailure);
      if (s.maxIterations) parts.push('maxIter:' + s.maxIterations);
      lines.push(parts.join(' '));
    }
  }
  if (parsed.inputSchema) lines.push('inputSchema: ' + JSON.stringify(parsed.inputSchema).slice(0, 500));
  if (parsed.outputSchema) lines.push('outputSchema: ' + JSON.stringify(parsed.outputSchema).slice(0, 500));
  return lines.join('\n');
}

// stripSnapshotsFromTestResult(testResult) — defensive shape-cleanup before
// serializing a testResult into any LLM-bound string. Removes the per-step
// `snapshot` field (which carries ~150K chars of full-page HTML per step on
// feed-style sites) and caps every remaining string field at FIELD_CHAR_CAP so
// a single huge result value can't blow up the prompt either. Returns a deep
// clone — never mutates the input (the wizard needs the unsimplified
// testResult for the result-summary pane, diagnostics, etc.).
//
// What survives:
//   - top-level: finalResult, steps[], any diagnostics fields
//   - per-step: stepId, stepName, result, error, durationMs, skipped, etc.
//   - per-snapshot: REMOVED entirely (the failing step's DOM is provided
//     separately via the truncated `pageSnapshot` passed alongside).
const TEST_RESULT_FIELD_CHAR_CAP = 5000;
// RC59: head+tail split for capped fields. Engagement-count evidence (and
// attribute-bearing chrome generally) clusters at the END of a record's HTML
// — action-bar aria-labels sit after tens of K of content markup. A head-only
// cap amputated that region in EVERY copy the LLM saw, so missing-field fixes
// iterated blind for ~9 rounds (console.log 2026-08-18). The tail keeps the
// larger share because the head (container open tag + header block) needs
// fewer chars to be recognizable.
const TEST_RESULT_FIELD_TAIL_SHARE = 0.6;
const TEST_RESULT_FIELD_MARKER_BUDGET = 60;
// RC59: per-field cap for RESULT values inside llmHistory summaries. History
// is "what was tried and what came out", not a second copy of the output —
// the current autoFix prompt always carries the fresh full output.
const TEST_RESULT_HISTORY_FIELD_CHAR_CAP = 200;
function capTestResultField(s, cap) {
  if (s.length <= cap) return s;
  const budget = Math.max(0, cap - TEST_RESULT_FIELD_MARKER_BUDGET);
  const head = Math.floor(budget * (1 - TEST_RESULT_FIELD_TAIL_SHARE));
  const tail = budget - head;
  return `[TRUNCATED ${s.length} chars — middle cut, first ${head} + last ${tail} kept] ` +
    s.slice(0, head) + ' …[cut]… ' + s.slice(s.length - tail);
}
function stripSnapshotsFromTestResult(testResult, opts) {
  if (!testResult || typeof testResult !== 'object') return testResult;
  const cap = (opts && typeof opts.fieldCharCap === 'number' && opts.fieldCharCap > 0)
    ? opts.fieldCharCap : TEST_RESULT_FIELD_CHAR_CAP;
  const capStr = (s) => (typeof s !== 'string') ? s : capTestResultField(s, cap);
  // Recursively walk plain data, capping strings + dropping `snapshot` keys.
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        if (k === 'snapshot') continue;            // drop — biggest bloat source
        out[k] = walk(v);
      }
      return out;
    }
    return capStr(node);
  };
  return walk(testResult);
}

// stripPagesFromLLMContext(testResult) — defensive shape-cleanup before
// serializing a testResult into any LLM-bound string. Removes the top-level
// `pages` and `pagesTruncated` fields (RC16) and recursively strips the
// `sourcePageId` field from every record. The pages list can carry ~4MB of
// HTML (50 pages × 80K); sourcePageId is meaningless to the LLM (it's a
// framework-added provenance field). Returns a deep clone — never mutates
// the input. Apply alongside stripSnapshotsFromTestResult at every LLM
// boundary.
function stripPagesFromLLMContext(testResult) {
  if (!testResult || typeof testResult !== 'object') return testResult;
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        if (k === 'pages' || k === 'pagesTruncated' || k === 'sourcePageId') continue;
        out[k] = walk(v);
      }
      return out;
    }
    return node;
  };
  return walk(testResult);
}

// dedupeStepIterations(testResult) — framework-level shape cleanup before
// serializing a testResult into any LLM-bound string. When a step polls
// (maxIterations>1), step-orchestrator emits one stepOutput entry PER
// iteration, all sharing the same stepId. Intermediate entries typically
// carry growing accumulators (updatedPosts, seenSignatures, etc.) that
// bloat the autoFix prompt without adding signal: the LLM only needs the
// FINAL per-step state to diagnose extraction-quality issues.
//
// console.log 2026-08-05 04:32: a 9-iteration step-5 carried updatedPosts
// growing 1→9 posts × ~100K each (capped to 5K by stripSnapshotsFromTestResult).
// Stripped+capped testResult was 885K; autoFix prompt hit 1.83MB; LLM
// timed out 4× then returned finish_reason:model_context_window_exceeded.
// After dedupe: stripped+capped testResult is ~200K.
//
// Per-iteration traces still survive via summarizeAllStepDiagnostics (which
// reads wizardState.lastExecutionEvents, not testResult.steps), so no signal
// is lost — only the redundant intermediate result snapshots are dropped.
//
// Returns a deep clone of testResult with steps[] collapsed to one entry
// per stepId (the LAST entry). Preserves ordering, finalResult, and all
// other top-level fields.
function dedupeStepIterations(testResult) {
  if (!testResult || typeof testResult !== 'object') return testResult;
  if (!Array.isArray(testResult.steps) || testResult.steps.length === 0) {
    // No steps to dedupe — shallow-clone top-level so caller still gets a
    // fresh object (consistent with the with-steps path).
    return { ...testResult };
  }
  const seen = new Map();
  for (const entry of testResult.steps) {
    if (!entry || typeof entry !== 'object') continue;
    const key = entry.stepId != null ? String(entry.stepId) : '__no_step_id__';
    seen.set(key, entry);  // last-write-wins preserves the final iteration
  }
  return { ...testResult, steps: [...seen.values()] };
}

// elideDuplicateFinalResults(testResult) — applied in the serialization
// chain (after dedupe → strip snapshots → strip pages). The terminal step's
// steps[].result and testResult.finalResult are frequently the SAME object:
// the orchestrator derives finalResult from the last successful step, so the
// autoFix prompt embedded every output record twice (~250K chars × 2 in the
// 2026-08-18 console.log incident — on top of the history copy). Steps whose
// result deep-equals finalResult get their result replaced with a marker;
// finalResult itself is kept full so the output appears exactly once.
// RC60: results that are earlier-stage SUBSETS of finalResult (same records
// before a later step enriched them) get the same treatment — deep equality
// alone left the pre-enrichment copy serialized in full.
// Non-mutating: returns a shallow-cloned steps array with cloned step entries
// only where elision occurred — wizardState.testResult is never touched.
// RC60: is a an earlier-stage version of b? a ⊆ b with tolerance: every key
// of a must exist in b with a predecessor value; arrays require equal length
// with >= 80% itemwise predecessor matches (downstream enrichment may rewrite
// individual records — e.g. content expansion — without breaking the
// "same record set, before enrichment" relationship).
function isPredecessorValue(a, b) {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    if (a.length === 0) return true;
    let subsetCount = 0;
    for (let i = 0; i < a.length; i++) {
      if (isPredecessorValue(a[i], b[i])) subsetCount++;
    }
    return subsetCount / a.length >= 0.8;
  }
  if (a && typeof a === 'object') {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return false;
    const keys = Object.keys(a);
    if (keys.length === 0) return true;
    return keys.every(k => k in b && isPredecessorValue(a[k], b[k]));
  }
  return false; // primitives: predecessor only when strictly equal (a === b)
}

function elideDuplicateFinalResults(testResult) {
  if (!testResult || typeof testResult !== 'object') return testResult;
  const finalResult = testResult.finalResult;
  if (finalResult === undefined || finalResult === null) return testResult;
  if (!Array.isArray(testResult.steps)) return testResult;
  let finalJson = null;
  return {
    ...testResult,
    steps: testResult.steps.map((step) => {
      if (!step || typeof step !== 'object' || !('result' in step)) return step;
      if (finalJson === null) finalJson = JSON.stringify(finalResult);
      if (JSON.stringify(step.result) === finalJson) {
        return { ...step, result: '[elided — identical to finalResult]' };
      }
      // RC60 (console.log 2026-08-18): the extraction step's pre-enrichment
      // record set (a subset of finalResult) was serialized in full next to
      // the final one — ~half of a ~300K-char Current output section. Deep
      // equality alone missed it; the subset check collapses it too.
      if (isPredecessorValue(step.result, finalResult)) {
        return { ...step, result: '[elided — earlier-stage subset of finalResult]' };
      }
      return step;
    })
  };
}

// RC60: sampleRecordsForLLMContext — record-array diet for the serialized
// testResult embedded in autoFix prompts (console.log 2026-08-18: single-round
// prompts measured ~504K chars / 235K prompt tokens, dominated by ~10 records
// × several 5K-capped html fields; rounds 1-2 had cached_tokens:0). The LLM
// needs structure + empty-patterns + a few full examples; cross-record shape
// variance is already summarized by the shape-distribution signal, which reads
// the RAW testResult — not this serialization. Long arrays of record objects
// keep their first RECORD_KEEP entries plus a marker element disclosing how
// many were omitted; long primitive arrays (accumulator signature lists) keep
// PRIMITIVE_KEEP. The top-level `steps` array is never sampled itself — one
// entry per step is execution-trace data, not records — but sampling recurses
// INTO each step entry (step results are record arrays too). Non-mutating.
const OUTPUT_RECORD_KEEP = 3;
const OUTPUT_PRIMITIVE_ARRAY_KEEP = 20;
function sampleRecordsForLLMContext(value, opts) {
  const recordKeep = (opts && Number.isFinite(opts.recordKeep) && opts.recordKeep > 0)
    ? Math.floor(opts.recordKeep) : OUTPUT_RECORD_KEEP;
  const primitiveKeep = (opts && Number.isFinite(opts.primitiveKeep) && opts.primitiveKeep > 0)
    ? Math.floor(opts.primitiveKeep) : OUTPUT_PRIMITIVE_ARRAY_KEEP;
  // Eighth-log K1: sampling bounded the record COUNT but not string LENGTH —
  // a verify report kept 3 records whose html fields (per-card outerHTML)
  // totaled 226K chars and landed whole in the session transcript. Opt-in
  // (default 0 = off) so existing autoFix serialization is unchanged.
  const stringCap = (opts && Number.isFinite(opts.stringCap) && opts.stringCap > 0)
    ? Math.floor(opts.stringCap) : 0;
  const capString = (s) => (stringCap && s.length > stringCap)
    ? s.slice(0, stringCap) + '…[truncated from ' + s.length + ' chars]'
    : s;
  const walk = (node) => {
    if (Array.isArray(node)) {
      const mapped = node.map(walk);
      const isRecordArray = mapped.length > 0 &&
        mapped[0] && typeof mapped[0] === 'object' && !Array.isArray(mapped[0]);
      const keep = isRecordArray ? recordKeep : primitiveKeep;
      if (mapped.length > keep) {
        const omitted = mapped.length - keep;
        const noun = isRecordArray ? 'records' : 'items';
        return mapped.slice(0, keep)
          .concat('[+' + omitted + ' more ' + noun + ' omitted — context budget]');
      }
      return mapped;
    }
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        out[k] = (k === 'steps' && Array.isArray(v)) ? v.map(walk) : walk(v);
      }
      return out;
    }
    if (typeof node === 'string') return capString(node);
    return node;
  };
  return walk(value);
}

function formatDomActivitySummary(activities) {
  if (!Array.isArray(activities) || activities.length === 0) return '(no DOM calls)';
  const groups = new Map();
  for (const a of activities) {
    if (!a || typeof a !== 'object') continue;
    const key = `${a.method}(${a.selector})`;
    if (!groups.has(key)) groups.set(key, { count: 0, total: 0 });
    const g = groups.get(key);
    g.count++;
    g.total += (typeof a.outcome === 'number' ? a.outcome : 0);
  }
  const entries = [...groups.entries()];
  const head = entries.slice(0, 3).map(([k, v]) => `${k} ×${v.count} → ${v.total}`);
  const tail = entries.length > 3 ? `, +${entries.length - 3} more` : '';
  return head.join(', ') + tail;
}

function summarizeExecutionDiagnostics(events, failingStepId) {
  if (!Array.isArray(events) || events.length === 0) return '';
  if (typeof failingStepId !== 'string' || failingStepId === '') return '';

  const stepEvents = events.filter(e => e && e.stepId === failingStepId);
  if (stepEvents.length === 0) {
    return `\nRuntime diagnostics: (no events recorded for step "${failingStepId}")\n`;
  }

  const iterations = stepEvents.filter(e => e.type === 'STEP_ITERATION');
  const failed = stepEvents.find(e => e.type === 'STEP_FAILED');

  const lines = [];
  lines.push(`Runtime diagnostics for failing step "${failingStepId}":`);
  lines.push('');

  const renderIteration = (evt) => {
    const out = [];
    out.push(`Iteration ${evt.iteration}:`);
    if (Array.isArray(evt.domActivity) && evt.domActivity.length > 0) {
      const groups = new Map();
      for (const a of evt.domActivity) {
        const key = `${a.method}('${a.selector}')`;
        if (!groups.has(key)) groups.set(key, { count: 0, total: 0 });
        const g = groups.get(key);
        g.count++;
        g.total += (typeof a.outcome === 'number' ? a.outcome : 0);
      }
      for (const [k, v] of groups) {
        out.push(`  ${k} ×${v.count} → ${v.total}`);
      }
    } else {
      out.push('  (no DOM calls)');
    }
    out.push(`  Returned: ${evt.resultPreview || '(no result)'}`);
    return out.join('\n');
  };

  if (iterations.length > 5) {
    lines.push('Iterations 1-3 (representative):');
    for (let i = 0; i < 3; i++) lines.push(renderIteration(iterations[i]));
    lines.push('...');
    lines.push(`Iteration ${iterations.length} (last):`);
    lines.push(renderIteration(iterations[iterations.length - 1]));
  } else {
    for (const it of iterations) lines.push(renderIteration(it));
  }

  // Total line + heuristic
  const allListOutcomes = iterations.flatMap(e => (e.domActivity || []).filter(a => a.method === '$list').map(a => a.outcome));
  const allLoadingTrue = iterations.flatMap(e => (e.domActivity || []).filter(a => a.method === '$exists' && /load|spin|generat/i.test(a.selector)).map(a => a.outcome));
  lines.push('');
  if (failed) {
    lines.push(`Step failed: ${failed.error}`);
    // B2 consumer end: a THROWN step's diagnostics live on the STEP_FAILED
    // event itself (no STEP_ITERATION was ever emitted for it).
    if (Array.isArray(failed.selectorDiagnostics) && failed.selectorDiagnostics.length > 0) {
      lines.push('  SELECTOR DIAGNOSTICS (from the failing call):');
      for (const d of failed.selectorDiagnostics.slice(0, 10)) {
        let s;
        try { s = JSON.stringify(d); } catch { s = String(d); }
        if (s.length > 400) s = s.slice(0, 400) + '…[truncated]';
        lines.push('    - ' + s);
      }
    }
  }
  if (iterations.length > 0) {
    const previews = iterations.map(it => (it.resultPreview == null ? '(empty)' : it.resultPreview));
    const allSame = previews.every(p => p === previews[0]);
    if (allSame) {
      lines.push(`Total: ${iterations.length} iterations, all returned ${previews[0]}.`);
    } else {
      lines.push(`Total: ${iterations.length} iterations with mixed results (first: ${previews[0]}; last: ${previews[previews.length - 1]}).`);
    }
  }

  // Heuristic branch
  lines.push('');
  lines.push('Likely causes:');
  if (allListOutcomes.length > 0 && allListOutcomes.every(n => n === 0)) {
    lines.push('  - The parent list selector is wrong for this page structure');
    lines.push('  - The content has not loaded by the time the script runs (try $wait first)');
    lines.push('  - The page requires interaction (scroll/click) before content appears');
  } else if (allLoadingTrue.length > 0 && allLoadingTrue.every(n => n === 1)) {
    lines.push('  - A loading indicator is still visible; increase the $wait timeout');
    lines.push('  - The page renders content asynchronously and the script runs too early');
  } else {
    lines.push('  - The script\'s ready/done check is wrong (data IS present but the script does not recognize it)');
    lines.push('  - Review the resultPreview above against the script\'s return statement');
  }

  return '\n' + lines.join('\n') + '\n';
}

// formatSelectorDiagnosticsForPrompt(diags) → string
//
// Compact rendering of selector-diagnostics entries for LLM prompts
// (background autoFix on a THROWN step; the error object carries them
// even though no STEP_ITERATION was ever emitted). Caps at 10 entries
// and 400 chars per entry — diagnostics can embed HTML snippets.
// Returns '' when there is nothing to show.
function formatSelectorDiagnosticsForPrompt(diags) {
  if (!Array.isArray(diags) || diags.length === 0) return '';
  const lines = [];
  for (const d of diags.slice(0, 10)) {
    if (!d) continue;
    let s;
    try { s = JSON.stringify(d); } catch { s = String(d); }
    if (s.length > 400) s = s.slice(0, 400) + '…[truncated]';
    lines.push('  - ' + s);
  }
  return lines.length === 0 ? '' :
    'Selector diagnostics (empirical — what the failing call actually observed):\n' + lines.join('\n');
}

// summarizeAllStepDiagnostics(events, steps) → string
//
// Like summarizeExecutionDiagnostics, but iterates over EVERY step in `steps`
// that has at least one STEP_ITERATION event (or a STEP_FAILED event carrying
// selectorDiagnostics — a step that THREW before completing an iteration).
// Used by the user-feedback autoFix
// path where there is no single failing step to anchor on — the LLM needs the
// per-step trace for ALL poll-style steps to diagnose "scroll never progressed"
// vs "selector too narrow" (bugx.log 2026-07-24 misdiagnosis).
//
// Output format (one block per qualifying step):
//   Step <id> (<name>) — <iterationCount> iteration(s):
//     Iteration 1: <preview>
//     Iteration 2: <preview>
//     ...
//     [collapse marker if N identical consecutive previews]
//
// Returns '' if no step has iterations and no step THREW with diagnostics.
function summarizeAllStepDiagnostics(events, steps) {
  if (!Array.isArray(events) || events.length === 0) return '';
  if (!Array.isArray(steps) || steps.length === 0) return '';

  const byStep = new Map();
  for (const evt of events) {
    if (!evt || evt.type !== 'STEP_ITERATION') continue;
    if (!byStep.has(evt.stepId)) byStep.set(evt.stepId, []);
    byStep.get(evt.stepId).push(evt);
  }
  // B2 consumer end: a step that THREW before completing an iteration emits
  // zero STEP_ITERATION events — without this fold, its selector diagnostics
  // (attached to the thrown error) would never reach the LLM.
  const failedByStep = new Map();
  for (const evt of events) {
    if (!evt || evt.type !== 'STEP_FAILED') continue;
    if (!Array.isArray(evt.selectorDiagnostics) || evt.selectorDiagnostics.length === 0) continue;
    if (!failedByStep.has(evt.stepId)) failedByStep.set(evt.stepId, []);
    failedByStep.get(evt.stepId).push(evt);
  }

  const lines = [];
  for (const step of steps) {
    if (!step || !step.id) continue;
    const iterEvents = byStep.get(step.id);
    if ((!iterEvents || iterEvents.length === 0) && failedByStep.has(step.id)) {
      lines.push('Step ' + step.id + ' (' + (step.name || '(unnamed)') + ') — THREW before completing an iteration:');
      const failEvt = failedByStep.get(step.id)[0];
      lines.push('  Error: ' + (failEvt.error || '(unknown)'));
      lines.push('  SELECTOR DIAGNOSTICS (from the failing call):');
      for (const d of failEvt.selectorDiagnostics.slice(0, 10)) {
        let s;
        try { s = JSON.stringify(d); } catch { s = String(d); }
        if (s.length > 400) s = s.slice(0, 400) + '…[truncated]';
        lines.push('    - ' + s);
      }
      lines.push('');
      continue;
    }
    if (!iterEvents || iterEvents.length === 0) continue;

    lines.push('Step ' + step.id + ' (' + (step.name || '(unnamed)') + ') — ' + iterEvents.length + ' iteration(s):');

    // Collapse runs of identical consecutive resultPreviews.
    let i = 0;
    while (i < iterEvents.length) {
      const cur = iterEvents[i];
      let runLen = 1;
      while (i + runLen < iterEvents.length &&
             (iterEvents[i + runLen].resultPreview === cur.resultPreview)) {
        runLen += 1;
      }
      const preview = cur.resultPreview == null ? '(empty)' : cur.resultPreview;
      if (runLen === 1) {
        lines.push('  Iteration ' + cur.iteration + ': ' + preview);
      } else {
        lines.push('  Iterations ' + cur.iteration + '-' + iterEvents[i + runLen - 1].iteration +
                   ' (' + runLen + ' identical): ' + preview);
      }
      i += runLen;
    }

    // Collect selector diagnostics across all iterations of this step.
    // These are empirical records of what each $extractList / $list / $extract
    // / $count call actually matched — surfaced to give the LLM concrete
    // evidence instead of forcing analytical guessing (bugx.log 2026-07-24
    // bugx.log 2026-07-24 publishTime incident: the proposed selector excluded the very
    // element it was trying to match, but no signal exposed that).
    const allDiags = [];
    for (const evt of iterEvents) {
      if (Array.isArray(evt.selectorDiagnostics)) {
        for (const d of evt.selectorDiagnostics) allDiags.push(d);
      }
    }
    if (allDiags.length > 0) {
      lines.push('  SELECTOR DIAGNOSTICS (empirical — what your selectors actually matched):');
      for (const d of allDiags.slice(0, 10)) {  // cap at 10 calls per step
        if (d.api === 'extractList' || d.api === 'extractListMulti') {
          let header = '    $' + d.api + '(\'' + d.containerSelector + '\') — container matched ' + d.containerMatches + ' element(s)';
          if (d.containerMatches === 0) header += ' (returned [] — allowEmpty was set or container selector is wrong)';
          lines.push(header);
          // RC13 (console.log 2026-07-27 02:30): surface the first matched
          // container's actual outerHTML so the LLM can see WHERE each field's
          // value lives inside one record. Without this, when the user reports
          // "field X missing", the LLM has no way to discover that — for
          // example — a count lives in a nested span rather than the button
          // element itself. The cleaned full-page HTML has typically stripped
          // these nested spans, and the per-field sampleTexts only reflect
          // what the LLM's (wrong) selectors already returned. Showing one
          // real record's DOM lets the LLM pick the right sub-element.
          if (d.firstContainerHtml && typeof d.firstContainerHtml === 'string' && d.firstContainerHtml.length > 0) {
            lines.push('      RECORD HTML (first container\'s actual outerHTML — read this to find where missing fields live):');
            // Display cap tracks the source-side capture (8000, head+tail —
            // 2026-08-24 user directive: page evidence the LLM must reason
            // about gets a real budget, not a blind generic threshold; RC59
            // showed tight caps amputate exactly the needed evidence). The
            // aggregate stays bounded by the ≤10-calls-per-step slice above.
            const html = d.firstContainerHtml.length > 8000
              ? d.firstContainerHtml.slice(0, 7977) + '…[truncated]'
              : d.firstContainerHtml;
            lines.push('        ' + html);
          }
          // Compute field collisions up-front: two fields whose non-empty
          // sample sets are identical (order-independent) are clearly grabbing
          // the same elements. Generic signal — surfaces author/publishTime-
          // style collisions without hardcoding field names (bugx.log
          // 2026-07-25: glm-5.1 saw author=["Alice","Bob"] and publishTime=
          // ["Alice","Bob"] in the same prompt but never noticed they were
          // identical across fields).
          const collisionPeers = (function() {
            const peers = new Map();
            const fields = (d.perField || []);
            const normSets = fields.map(f => {
              const samples = Array.isArray(f.sampleTexts) ? f.sampleTexts : [];
              const set = new Set(samples.map(s => String(s).trim()).filter(s => s.length > 0));
              return { field: f.field, set };
            });
            for (let i = 0; i < normSets.length; i++) {
              for (let j = i + 1; j < normSets.length; j++) {
                const a = normSets[i];
                const b = normSets[j];
                if (a.set.size === 0 || b.set.size === 0) continue;
                if (a.set.size !== b.set.size) continue;
                let allMatch = true;
                for (const s of a.set) { if (!b.set.has(s)) { allMatch = false; break; } }
                if (!allMatch) continue;
                if (!peers.has(a.field)) peers.set(a.field, []);
                if (!peers.has(b.field)) peers.set(b.field, []);
                peers.get(a.field).push(b.field);
                peers.get(b.field).push(a.field);
              }
            }
            return peers;
          })();
          // Sort fields: 0-match fields first (those are the suspicious ones), then by name.
          const sortedFields = (d.perField || []).slice().sort((a, b) => {
            if ((a.matchCount === 0) !== (b.matchCount === 0)) return a.matchCount === 0 ? -1 : 1;
            return String(a.field).localeCompare(String(b.field));
          });
          for (const f of sortedFields) {
            const overConstrained = (f.matchCount === 0 && d.containerMatches > 0) ? ' ← OVER-CONSTRAINED (excludes the element you want)' : '';
            const mismatch = (!overConstrained && f.matchCount !== d.containerMatches && f.matchCount > 0)
              ? ' ← PARTIAL (' + f.matchCount + '/' + d.containerMatches + ' containers had this field)'
              : '';
            // EMPTY-EXTRACTIONS: selector matched N elements but every sample
            // text is empty/whitespace. Skipped for attr-based extracts (samples
            // are empty by design there). Skipped when matchCount=0 (OVER-
            // CONSTRAINED handles that case). Without this marker the LLM sees
            // "N matches" and assumes the selector is fine — but the output
            // field is "" because the matched element has no text content
            // (e.g., wrong element, missing attr, or text in a child node).
            const _samplesArr = Array.isArray(f.sampleTexts) ? f.sampleTexts : [];
            const _allEmpty = !f.attr && _samplesArr.length > 0 && _samplesArr.every(s => String(s).trim().length === 0);
            const emptyExtract = (_allEmpty && f.matchCount > 0)
              ? ' ← EMPTY-EXTRACTIONS (matched ' + f.matchCount + ' element(s) but every sample text is empty/whitespace — selector matches the wrong element or this element has no usable text; the field will be "" in the output)'
              : '';
            const _peers = collisionPeers.get(f.field) || [];
            const collision = _peers.length > 0
              ? ' ← FIELD COLLISION with field(s) [' + _peers.join(', ') + '] (sample texts are identical — selectors are matching the SAME elements; narrow one selector to point at a different element)'
              : '';
            const samples = f.sampleTexts && f.sampleTexts.length > 0
              ? ' sample texts: ' + JSON.stringify(f.sampleTexts)
              : '';
            const hrefs = f.sampleHrefs && f.sampleHrefs.length > 0
              ? ' sample hrefs: ' + JSON.stringify(f.sampleHrefs)
              : '';
            let line = '      field ' + f.field + ' (sel \'' + f.subSelector + '\'' + (f.attr ? ', attr=\'' + f.attr + '\'' : '') + '): ' + f.matchCount + ' matches.' + overConstrained + mismatch + emptyExtract + collision + samples + hrefs;
            if (line.length > 240) line = line.slice(0, 237) + '...';
            lines.push(line);
            // Fourth-session log 2026-08-31 (ZERO-TRAP): the actual extracted
            // VALUES — attr fields had no samples before, so a script-level
            // regex filtering hrefs to zero was invisible. These are what a
            // counting/filtering regex must be written against. Own line:
            // 5 values × 160 chars would amputate under the 240-col field cap.
            if (Array.isArray(f.sampleValues) && f.sampleValues.length > 0) {
              let vline = '      observed values for \'' + f.field + '\'' + (f.attr ? ' (attr ' + f.attr + ')' : '') + ': ' + JSON.stringify(f.sampleValues);
              if (vline.length > 1000) vline = vline.slice(0, 997) + '...';
              lines.push(vline);
            }
          }
        } else if (d.api === 'clickInList') {
          // console.log 2026-08-23: a $clickInList whose sub-selector matched
          // nothing in ANY container silently returned done:true. Rendering
          // the dead sub-selector + a real container's HTML gives autoFix the
          // evidence to rewrite the click target (e.g. text-based buttons
          // often carry no aria-label).
          let header = '    $clickInList(\'' + d.containerSelector + '\') — container matched ' + d.containerMatches + ' element(s), clicked ' + d.clicked + ', ' + (d.errorCount || 0) + ' errored';
          if (d.containerMatches === 0) {
            header += ' (the CONTAINER selector itself matched nothing — this call could never click anything; fix the container selector and propagate the fix to every step using the same list)';
          } else if (d.errorCount > 0 && d.notFoundCount === d.errorCount) {
            header += ' (subSel ' + JSON.stringify(d.subSelector) + ' matched NOTHING in any container — the click action did nothing)';
          }
          lines.push(header);
          if (d.sampleTexts && d.sampleTexts.length > 0) {
            lines.push('      container text samples: ' + JSON.stringify(d.sampleTexts));
          }
          if (d.firstContainerHtml && typeof d.firstContainerHtml === 'string' && d.firstContainerHtml.length > 0) {
            // Display cap tracks the source-side 8000 head+tail capture
            // (2026-08-24 user directive on real budgets for page evidence).
            const html = d.firstContainerHtml.length > 8000
              ? d.firstContainerHtml.slice(0, 7977) + '…[truncated]'
              : d.firstContainerHtml;
            lines.push('      CONTAINER HTML (find the actually-clickable element here):');
            lines.push('        ' + html);
          }
        } else if (d.api === 'list' || d.api === 'extract') {
          const fn = d.api === 'list' ? '$list' : '$extract';
          const samples = d.sampleTexts && d.sampleTexts.length > 0
            ? ' sample texts: ' + JSON.stringify(d.sampleTexts)
            : '';
          const hrefs = d.sampleHrefs && d.sampleHrefs.length > 0
            ? ' sample hrefs: ' + JSON.stringify(d.sampleHrefs)
            : '';
          const overConstrained = (d.api === 'extract' && d.matchCount === 0) ? ' ← OVER-CONSTRAINED (selector matched nothing)' : '';
          let line = '    ' + fn + '(\'' + d.selector + '\') — matched ' + d.matchCount + ' element(s).' + overConstrained + samples + hrefs;
          if (line.length > 240) line = line.slice(0, 237) + '...';
          lines.push(line);
        } else if (d.api === 'count') {
          let line = '    $count(\'' + d.selector + '\') — matched ' + d.matchCount + ' element(s).';
          if (line.length > 240) line = line.slice(0, 237) + '...';
          lines.push(line);
        } else if (d.api === 'extractWithHover') {
          // console.log 2026-08-23 16:13-16:15 (third session): the anchor
          // counts lived in hoverSummary on the diagnostics channel but no
          // summary branch rendered them, so the autoFix LLM had to guess why
          // hovercards were [] — and guessed the wrong ancestor block twice.
          const hs = d.hoverSummary || {};
          let header = '    $extractWithHover(\'' + (d.containerSelector || '?') + '\') — processed ' +
            (d.processedContainers || 0) + ' container(s)' +
            (d.anchorSel ? ', anchorSel ' + JSON.stringify(d.anchorSel) : '') +
            ' — anchors found ' + (hs.anchorsFound || 0) +
            ', hovercards captured ' + (hs.hovercardsCaptured || 0) +
            ', failures ' + (hs.hoverFailures || 0);
          if ((d.processedContainers || 0) > 0 && (hs.anchorsFound || 0) === 0) {
            header += ' ← ANCHOR BLIND (anchorSel matched 0 anchors inside every processed container — hover NEVER ran; every record got hovercards:[] with ZERO entries, which is NOT the same as "hovered but no card appeared". anchorSel is evaluated as container.querySelectorAll(anchorSel): it must match INSIDE each container subtree, and the real interactive link is often nested inside wrapper elements — <object> wrappers, aria-hidden shells — or sits in a different branch than the block named in the selector chain)';
          }
          if (header.length > 700) header = header.slice(0, 697) + '...';
          lines.push(header);
          // perField carries the same shape as extractList diagnostics
          // (computed by computeExtractListDiagnostics) — render the compact
          // match line so field-level 0-matches stay visible too.
          for (const f of (d.perField || [])) {
            if (!f || !f.field) continue;
            let line = '      field ' + f.field + ' (sel \'' + (f.subSelector || '') + '\'' + (f.attr ? ', attr=\'' + f.attr + '\'' : '') + '): ' + (f.matchCount || 0) + ' matches.';
            if (line.length > 240) line = line.slice(0, 237) + '...';
            lines.push(line);
          }
          if (d.capturedPopovers && Array.isArray(d.capturedPopovers.samples) && d.capturedPopovers.samples.length) {
            lines.push('      captured popover text (raw, unconsumed unless a field reads hoverPopover): ' + JSON.stringify(d.capturedPopovers.samples));
          }
          if (d.firstContainerHtml && typeof d.firstContainerHtml === 'string' && d.firstContainerHtml.length > 0) {
            // Display cap matches the extractWithHover source-side capture
            // (8000, set in domExtractWithHover) — re-amputating here with the
            // generic 1800 display cap would cut exactly the nesting evidence
            // the anchor fix needs (user directive: page evidence the LLM must
            // reason about gets a real budget, not a blind generic threshold).
            const html = d.firstContainerHtml.length > 8000
              ? d.firstContainerHtml.slice(0, 7977) + '…[truncated]'
              : d.firstContainerHtml;
            lines.push('      CONTAINER HTML (find the real hover anchor here — check where the interactive link actually nests):');
            lines.push('        ' + html);
          }
        }
      }
    }

    lines.push('');
  }

  return lines.length === 0 ? '' : lines.join('\n');
}

// Pure scoring function for autoFix best-of-N comparison.
// Returns { score, breakdown, isData }:
//   score = requiredCoverage * 100 + listItemCount * 10 + avgFieldsPerItem * 5
//     (raw float, NOT rounded — preserves partial-fill signal e.g. 1/3 inner fields
//     scores measurably lower than 2/3, which a rounded integer would erase)
//   isData = false when result is not a non-null object OR no schema → skip best-attempt tracking
// Never throws — malformed input returns { score: 0, isData: false, breakdown: {} }.
function scoreAttemptResult(result, outputSchema) {
  try {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return { score: 0, isData: false, breakdown: {} };
    }
    if (!outputSchema || typeof outputSchema !== 'object') {
      return { score: 0, isData: false, breakdown: {} };
    }

    // Cycle preflight: a circular result would cause unbounded recursion inside
    // isEmptyValue's Object.values(v).every(isEmptyValue) call. The outer try/catch
    // would eventually swallow the stack overflow, but the WeakSet walk short-circuits
    // before that and returns the documented safe shape explicitly.
    const hasCycle = (root) => {
      const seen = new WeakSet();
      const visit = (v) => {
        if (!v || typeof v !== 'object') return false;
        if (seen.has(v)) return true;
        seen.add(v);
        for (const k of Object.keys(v)) {
          if (visit(v[k])) return true;
        }
        return false;
      };
      return visit(root);
    };
    if (hasCycle(result)) {
      return { score: 0, isData: false, breakdown: {} };
    }

    const required = Array.isArray(outputSchema.required) ? outputSchema.required : [];
    const props = outputSchema.properties && typeof outputSchema.properties === 'object' ? outputSchema.properties : {};

    const isEmptyValue = (v) =>
      v === '' || v === null || v === undefined ||
      (Array.isArray(v) && v.length === 0) ||
      (v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(isEmptyValue));

    // requiredCoverage: fraction of required fields that are non-empty
    let requiredCoverage = 0;
    if (required.length > 0) {
      const satisfied = required.filter(key => !isEmptyValue(result[key])).length;
      requiredCoverage = satisfied / required.length;
    }

    // Find first array-of-objects field for list metrics
    let arrayKey = null;
    for (const key of Object.keys(result)) {
      const prop = props[key];
      if (Array.isArray(result[key]) && prop && prop.type === 'array') {
        arrayKey = key;
        break;
      }
    }

    let listItemCount = 0;
    let avgFieldsPerItem = 0;
    if (arrayKey) {
      const arr = result[arrayKey];
      listItemCount = arr.length;
      const itemProp = props[arrayKey] && props[arrayKey].items;
      const innerKeys = (itemProp && itemProp.properties && typeof itemProp.properties === 'object')
        ? Object.keys(itemProp.properties)
        : [];
      if (arr.length > 0 && innerKeys.length > 0) {
        const ratios = arr
          .filter(item => item && typeof item === 'object' && !Array.isArray(item))
          .map(item => innerKeys.filter(k => !isEmptyValue(item[k])).length / innerKeys.length);
        avgFieldsPerItem = ratios.length > 0
          ? ratios.reduce((a, b) => a + b, 0) / ratios.length
          : 0;
      }
    }

    // Seventy-eighth log: single-object output contracts. A Q&A/deep-thinking
    // service whose schema is {type:object, required:[...], properties:{...}}
    // with NO top-level array property scored 0/listItemCount 0/isData-flagged
    // weirdly on a fully populated result — the list machinery found no array
    // and every list metric died. Score the OBJECT itself: listItemCount=1
    // when any property carries data, avgFieldsPerItem = fraction of declared
    // property keys non-empty (same semantics as per-item field coverage).
    if (!arrayKey && outputSchema.type === 'object' && Object.keys(props).length > 0) {
      const propKeys = Object.keys(props);
      const nonEmptyKeys = propKeys.filter(k => !isEmptyValue(result[k]));
      listItemCount = nonEmptyKeys.length > 0 ? 1 : 0;
      avgFieldsPerItem = nonEmptyKeys.length / propKeys.length;
    }

    const score = requiredCoverage * 100 + listItemCount * 10 + avgFieldsPerItem * 5;
    return {
      score,
      isData: true,
      breakdown: { requiredCoverage, listItemCount, avgFieldsPerItem }
    };
  } catch (e) {
    // Circular reference or unexpected shape — degrade silently.
    // debugLogger may not be available in all environments; guard the log.
    try { (typeof debugLogger !== 'undefined' && debugLogger.log('warn', 'wizard-utils', 'scoreAttemptResult failed', { error: e.message })); } catch {}
    return { score: 0, isData: false, breakdown: {} };
  }
}

// Score how brittle a single CSS selector is. Higher score = more brittle.
// Used by the wizard deploy hook to warn the user when an annotation is
// unlikely to generalize across list items. Pure function, no exceptions.
//
// Detection rules:
//   +35 per :nth-of-type occurrence (positional, does not generalize)
//   +25 if chain has >12 segments; +15 if >8 (depends on fixed DOM structure)
//   +20 if selector contains auto-generated className (framework hash)
//   +10 if selector has no stable anchor anywhere ([role], [aria-*], [data-*], id)
//   +5  per bare structural segment (tag>tag with no attributes between)
function scoreAnnotationBrittleness(selector) {
  let score = 0;
  const reasons = [];

  if (!selector || typeof selector !== 'string') {
    return { score: 0, reasons };
  }

  // 1. Positional :nth-of-type
  const nthMatches = selector.match(/:nth-of-type\(\d+\)/g) || [];
  if (nthMatches.length > 0) {
    score += 35 * nthMatches.length;
    reasons.push(`Positional :nth-of-type ×${nthMatches.length} — does not generalize across siblings`);
  }

  // 2. Chain depth
  const segments = selector.split('>').map(s => s.trim()).filter(Boolean);
  if (segments.length > 12) {
    score += 25;
    reasons.push(`Very long chain (${segments.length} segments) — depends on fixed DOM structure`);
  } else if (segments.length > 8) {
    score += 15;
    reasons.push(`Long chain (${segments.length} segments)`);
  }

  // 3. Auto-generated className (framework hash)
  if (/\.x[0-9a-f]+\b/i.test(selector) || /\._[a-z0-9]+\b/i.test(selector)) {
    score += 20;
    reasons.push('Auto-generated className (likely unstable across page loads)');
  }

  // 4. No stable anchor anywhere (skipped when positional :nth-of-type is
  //    present — that IS an anchor, just a brittle one, already penalized above)
  const hasStableAnchor = /(\[role=|\[aria-|\[data-|#\w)/.test(selector);
  if (!hasStableAnchor && segments.length > 1 && nthMatches.length === 0) {
    score += 10;
    reasons.push('No stable anchor attribute ([role], [aria-*], [data-*], id)');
  }

  // 5. Bare structural segments (tag > tag with no attributes in between)
  const bareStructural = (selector.match(/>\s*[a-z]+\s*>/g) || []).length;
  if (bareStructural > 0) {
    score += 5 * bareStructural;
    if (bareStructural >= 2) {
      reasons.push(`Anonymous structural ×${bareStructural}`);
    }
  }

  return { score, reasons };
}

// Score a chain of selectors — the worst link determines the chain's
// brittleness. A chain is only as stable as its weakest segment.
function scoreAnnotationChain(selectors) {
  if (!Array.isArray(selectors) || selectors.length === 0) {
    return { score: 0, reasons: [] };
  }
  let worst = { score: 0, reasons: [] };
  for (const s of selectors) {
    const r = scoreAnnotationBrittleness(s);
    if (r.score > worst.score) worst = r;
  }
  return worst;
}

function validateSteps(steps) {
  if (!Array.isArray(steps)) return { valid: false, error: 'steps must be an array' };
  if (steps.length === 0) return { valid: false, error: 'steps cannot be empty' };

  const ids = new Set();
  const warnings = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step.id) return { valid: false, error: `Step ${i + 1} missing id` };
    const isPendingAnnotation = step.needsAnnotation === true && (!step.script || step.script.trim() === '' || step.script.trim() === '// PENDING_ANNOTATION');
    const hasScript = step.script && step.script.trim() !== '';
    if (!hasScript && !isPendingAnnotation) return { valid: false, error: `Step ${i + 1} (${step.id}) missing script` };
    if (ids.has(step.id)) return { valid: false, error: `Duplicate step id: ${step.id}` };
    ids.add(step.id);
    if (step.onSuccess && typeof step.onSuccess !== 'string') {
      return { valid: false, error: `Step ${step.id} onSuccess must be a string` };
    }
    if (step.onFailure && typeof step.onFailure !== 'string') {
      return { valid: false, error: `Step ${step.id} onFailure must be a string` };
    }
    if (step.maxIterations !== undefined && (!Number.isInteger(step.maxIterations) || step.maxIterations < 1)) {
      return { valid: false, error: `Step ${step.id} maxIterations must be >= 1` };
    }
    // WS3.1: warn if a step's literal delays likely exceed the timeout ceiling.
    const budget = estimateScriptTimeBudget(step.script);
    if (budget > 30000) {
      warnings.push(`Step ${step.id}: estimated single-iteration delay (~${budget}ms) exceeds the 30000ms timeout. Split the wait across retry iterations (set maxIterations>1 and return { done: false }).`);
    }
  }
  return warnings.length ? { valid: true, warnings } : { valid: true };
}

function validateForExecution(steps) {
  const base = validateSteps(steps);
  if (!base.valid) return base;
  const warnings = base.warnings ? base.warnings.slice() : [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const hasRealScript = step.script && step.script.trim() !== '' && step.script.trim() !== '// PENDING_ANNOTATION';
    if (!hasRealScript) {
      return {
        valid: false,
        error: `Step ${i + 1} (${step.id}) has a pending annotation placeholder. Annotate it before deploying.`
      };
    }
    // Ninety-eighth round: update-time SYNTAX gate. The final artifact of a
    // live session shipped a step script contaminated by pasted evidence
    // text — validateForExecution never parsed scripts, so syntax errors
    // surfaced only at verify (or NEVER, when the budget died first) and a
    // broken script became the deployable version behind a prose
    // disclosure. Parse with the same async-body shape the executor uses;
    // reject with the twentieth-log locator teaching.
    try {
      // eslint-disable-next-line no-new-func
      new Function('__input__', '__stepResults__', '__lastResult__', 'return (async function(__input__) { ' + step.script + '\n })(__input__)');
    } catch (e) {
      return {
        valid: false,
        error: `Step ${i + 1} (${step.id}) script is NOT parseable JavaScript (caught at UPDATE time — paste errors and mixed-in prose are rejected before the artifact ever lands): ${(e && e.message) || String(e)}. Rewrite the step script as executable JS; evidence notes belong in think/finish, never inside the script.`
      };
    }
    // WS3.2: a poll/wait step (maxIterations>1) must emit a retry/done signal so
    // it can actually loop and terminate. Without one it runs once and advances
    // (no retry) — the most common silent misconfiguration under Model A.
    if ((step.maxIterations ?? 1) > 1) {
      const s = step.script || '';
      const hasSignal = /(done|ready|complete|finished|responseReady|generating|loading)\s*:/.test(s);
      if (!hasSignal) {
        warnings.push(`Step ${step.id} has maxIterations>1 (a poll/wait step) but its script returns no retry/done signal such as { done: false }. It will run once and advance without retrying — likely a misconfiguration.`);
      }
    }
  }
  const chain = validateChain(steps);
  if (!chain.valid) return chain;
  return warnings.length ? { valid: true, warnings } : { valid: true };
}

// Walks the onSuccess/onFailure pointer graph from the first step and verifies
// every pointer resolves to a real step id (or a valid sentinel). Catches the
// "manually-added step never runs" bug class: a step sitting in the array with
// no predecessor pointing to it is silent dead code in the orchestrator, which
// follows pointers rather than array order. Called from validateForExecution
// (deploy-time) and ServiceRegistry.save() (every persistence path).
function validateChain(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { valid: false, error: 'steps cannot be empty' };
  }
  const first = steps[0];
  if (!first || !first.id) {
    return { valid: false, error: 'first step must have an id' };
  }

  const ids = new Set(steps.map(s => s && s.id).filter(Boolean));

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || !step.id) {
      return { valid: false, error: `Step ${i + 1} must have an id` };
    }
    const checkPointer = (field) => {
      const target = step[field];
      if (!target || target === 'TERMINATE') return null;
      if (target === 'SELF') {
        // SELF was the old self-loop sentinel. Under Model A it is rejected loudly
        // (rather than silently treated as a literal step id → STEP_NOT_FOUND at
        // runtime). Polling is now maxIterations>1 + {done:false}; onSuccess points
        // to the next step. This surfaces any legacy SELF config at save/deploy.
        return `Step "${step.id}" uses ${field}:'SELF', which is no longer supported. For a poll/wait step, set maxIterations>1, return { done: false } to retry, and point ${field} to the next step id (or TERMINATE).`;
      }
      if (!ids.has(target)) {
        return `Step "${step.id}" ${field} points to "${target}", which doesn't exist`;
      }
      return null;
    };
    const err = checkPointer('onSuccess') || checkPointer('onFailure');
    if (err) return { valid: false, error: err };
  }

  const reachable = new Set();
  const queue = [first.id];
  while (queue.length > 0) {
    const id = queue.shift();
    if (reachable.has(id)) continue;
    reachable.add(id);
    const step = steps.find(s => s.id === id);
    if (!step) continue;
    for (const target of [step.onSuccess, step.onFailure]) {
      if (target && target !== 'TERMINATE' && !reachable.has(target)) {
        queue.push(target);
      }
    }
  }

  for (const step of steps) {
    if (!reachable.has(step.id)) {
      return {
        valid: false,
        error: `Step "${step.id}" is unreachable from step "${first.id}". No predecessor's onSuccess/onFailure points to it.`
      };
    }
  }

  return { valid: true };
}

function buildStepIORenderString(steps) {
  if (!steps || steps.length === 0) return 'No steps';
  return steps.map((s, i) => `${i + 1}. ${s.name || s.id} → ${s.onSuccess}`).join('\n');
}

function appendGlobalContextBlock(baseSystemContent, description) {
  const desc = (description || '').trim();
  if (!desc) return baseSystemContent;
  return baseSystemContent + '\n\n[GLOBAL CONTEXT]\nThe user\'s original scraping requirement (apply to all your work):\n"' + desc + '"\n[/GLOBAL CONTEXT]';
}

function buildAutoFixSystemMessage(description) {
  const base = 'You are a web scraping script fixer. Return only JavaScript code. Do not change the step flow logic.';
  const desc = (description || '').trim();
  if (!desc) return base;
  return base + '\n\n[GLOBAL CONTEXT]\nThe user\'s original scraping requirement:\n"' + desc + '"\n[/GLOBAL CONTEXT]';
}

function buildRequirementsBlock(requirements, targetUrl) {
  const r = requirements || {};
  const inputParams = (r.inputParams || '').trim();
  const pageOps = (r.pageOps || '').trim();
  const outputStruct = (r.outputStruct || '').trim();
  const lines = [
    '## User Requirements',
    '- Input parameters: ' + (inputParams || '(none specified)'),
    '- Page operations & data to collect: ' + (pageOps || '(unspecified)'),
    '- Output structure: ' + (outputStruct || '(unspecified — infer)')
  ];
  const url = (targetUrl || '').trim();
  if (url) {
    // First-live-log P-C: without the URL the session starts blind — the LLM
    // cannot know which site to open (it misused annotate.request to ask) or
    // that {{param}} placeholders exist and must become inputSchema properties.
    const params = [];
    const re = /\{\{\s*(\w+)\s*\}\}/g;
    let m;
    while ((m = re.exec(url)) !== null) {
      const tok = '{{' + m[1] + '}}';
      if (params.indexOf(tok) === -1) params.push(tok);
    }
    lines.splice(1, 0, '- Target URL: ' + url + (params.length
      ? ' — ' + params.join(', ') + ' are URL template parameters: each MUST appear as a service input parameter (verify.run input / run-time input substitutes them; the research tab shows the literal placeholder)'
      : ''));
  }
  return lines.join('\n');
}

function suggestServiceName(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') || '';
  } catch {
    // URL constructor throws on strings without a protocol — prepend one and retry
    try {
      const u2 = new URL('http://' + url);
      return u2.hostname.replace(/^www\./, '') || '';
    } catch {
      return '';
    }
  }
}

function fillEntryUrlDefaults(steps, defaultUrl) {
  if (!Array.isArray(steps) || !defaultUrl) return steps || [];
  return steps.map(step => {
    if (!step || step.entryUrl) return step;
    return { ...step, entryUrl: defaultUrl };
  });
}

// Default retry budget injected by normalizeStepTopology when a step clearly
// intends to poll but forgot to set maxIterations. Conservative: enough for most
// waits, low enough that a genuinely stuck loop is still bounded quickly.
const DEFAULT_POLL_MAX_ITERATIONS = 30;

// Deterministic topology heal (no LLM). Runs after generation and at the start
// of each auto-fix iteration. A step whose script emits a reserved poll signal
// (done/ready/complete/finished/responseReady/generating/loading as a returned
// key) but left maxIterations UNSET was intended to poll — generation couldn't
// know the page needed it. Boost it instead of asking the LLM again (it already
// failed to set it once). Detection keys on the reserved KEY (any value form —
// literal, computed like !stillLoading, or a call), because under Model A those
// keys are reserved polling signals. Over-detection is harmless: a higher cap is
// simply unused if the step's result never carries a top-level not-ready signal.
// Explicit maxIterations (including 1) is always respected.
function normalizeStepTopology(steps) {
  const changed = [];
  if (!Array.isArray(steps)) return { changed };
  const pollSignal = /\b(done|ready|complete|finished|responseReady|generating|loading)\s*:/;
  for (const step of steps) {
    if (!step) continue;
    if (step.maxIterations != null) continue;          // respect explicit (null/undefined only)
    if (pollSignal.test(step.script || '')) {
      step.maxIterations = DEFAULT_POLL_MAX_ITERATIONS;
      changed.push({ id: step.id, maxIterations: DEFAULT_POLL_MAX_ITERATIONS });
    }
  }
  return { changed };
}

function appendStepWithChainLink(steps, newStep) {
  if (steps.length > 0) {
    const prevLast = steps[steps.length - 1];
    if (prevLast && prevLast.onSuccess === 'TERMINATE') {
      prevLast.onSuccess = newStep.id;
    }
  }
  steps.push(newStep);
  return steps;
}

// Removes the step with the given id and rewires any inbound pointers to
// skip over it. The deleted step's own onSuccess becomes the new target for
// any predecessor that pointed at it (or its onFailure if it had no forward
// onSuccess). Without this rewiring, splice() leaves dangling onSuccess/
// onFailure pointers — the predecessor tries to follow them, hits
// STEP_NOT_FOUND, and the service dies at runtime. Pair with validateChain
// to verify the post-delete chain is still traversal-valid.
function removeStepWithRelink(steps, id) {
  const idx = steps.findIndex(s => s && s.id === id);
  if (idx < 0) return steps;
  const removed = steps[idx];
  const successor = (removed.onSuccess === 'TERMINATE' || !removed.onSuccess)
    ? (removed.onFailure || 'TERMINATE')
    : removed.onSuccess;  for (const step of steps) {
    if (step === removed) continue;
    if (step.onSuccess === id) step.onSuccess = successor;
    if (step.onFailure === id) step.onFailure = successor;
  }
  steps.splice(idx, 1);
  return steps;
}

// Rewrites onSuccess pointers so the chain topology matches the current
// array order. Used after array-only reorderings (btn-step-up/down) that
// would otherwise desync the chain from the display.
//
// The orchestrator starts at steps[0] and follows onSuccess. If a user
// moves a step into index 0 without relinking, that step's onSuccess
// (often 'TERMINATE' if it was the tail) terminates execution after one
// step — exactly the "only my new step runs" bug.
//
// Rules:
// - Each non-last step gets onSuccess = next array step's id
// - Last step gets onSuccess = 'TERMINATE'
// - onFailure is left alone — branch/error paths are independent of array order
//   (poll/wait steps express retry via maxIterations + {done:false}, not via a
//   self-pointing onSuccess, so there is no self-loop pointer to preserve.)
function relinkChainToArray(steps) {
  if (!Array.isArray(steps)) return steps;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || !step.id) continue;
    step.onSuccess = (i === steps.length - 1) ? 'TERMINATE' : steps[i + 1].id;
  }
  return steps;
}

const STEP_TEMPLATES = [
  {
    id: 'extract-list',
    name: 'Extract List',
    description: 'Extract a list of items from the current page',
    steps: [
      {
        id: 'extract',
        name: 'Extract Items',
        script: `const text = await $extract('.item-list') || await $extract('body');\nreturn { itemsText: text };`,
        condition: 'document.querySelectorAll(".item").length > 0',
        onSuccess: 'TERMINATE',
        onFailure: 'TERMINATE',
        maxIterations: 1
      }
    ]
  },
  {
    id: 'expand-then-extract-list',
    name: 'Expand + Extract List',
    description: 'Click an expander (展开/see-more) inside each list item, then extract structured fields. Use when the full content of each item requires a click to reveal.',
    steps: [
      {
        id: '1',
        name: 'Wait for list',
        script: `return { done: await $exists('li.result-item', 5000) };`,
        onSuccess: '2',
        onFailure: 'TERMINATE',
        maxIterations: 10
      },
      {
        id: '2',
        name: 'Expand each item',
        script: `const r = await $clickInList('li.result-item', 'button:has(> span)', { delayMs: 500 });\nif (r.errors.length) return { done: false };\nreturn { done: true, expanded: r.clicked };`,
        onSuccess: '3',
        onFailure: '3',
        maxIterations: 3
      },
      {
        id: '3',
        name: 'Extract fields',
        script: `const items = await $extractList('li.result-item', { content: '.item-body' });\nif (!items.length) return { done: false };\nreturn { items };`,
        onSuccess: 'TERMINATE',
        onFailure: 'TERMINATE',
        maxIterations: 3
      }
    ]
  },
  {
    id: 'pagination',
    name: 'Pagination Loop',
    description: 'Extract items and click next page until no more pages',
    steps: [
      {
        id: 'extract',
        name: 'Extract Page Items',
        script: `const text = await $extract('.item-list') || '';\nreturn { pageItemsText: text };`,
        condition: 'document.querySelectorAll(".item").length > 0',
        onSuccess: 'next-page',
        onFailure: 'TERMINATE',
        maxIterations: 1
      },
      {
        id: 'next-page',
        name: 'Click Next Page',
        script: `await $click('.next-page');\nawait $wait('.item', 2000);`,
        condition: 'document.querySelector(".next-page") !== null',
        onSuccess: 'extract',
        onFailure: 'TERMINATE',
        maxIterations: 10
      }
    ]
  },
  {
    id: 'form-submit',
    name: 'Form Submit',
    description: 'Fill a form and submit it',
    steps: [
      {
        id: 'fill-form',
        name: 'Fill Form Fields',
        script: `await $type('input[name="q"]', __input__.query || '');`,
        onSuccess: 'submit',
        onFailure: 'TERMINATE',
        maxIterations: 1
      },
      {
        id: 'submit',
        name: 'Submit Form',
        script: `await $click('button[type="submit"]');\nawait $wait('.results', 3000);`,
        onSuccess: 'extract-results',
        onFailure: 'TERMINATE',
        maxIterations: 1
      },
      {
        id: 'extract-results',
        name: 'Extract Results',
        script: `const text = await $extract('.results') || '';\nreturn { resultsText: text };`,
        onSuccess: 'TERMINATE',
        onFailure: 'TERMINATE',
        maxIterations: 1
      }
    ]
  },
  {
    id: 'login-then-scrape',
    name: 'Login Then Scrape',
    description: 'Log in and then perform scraping',
    steps: [
      {
        id: 'login',
        name: 'Perform Login',
        script: `await $type('#username', __input__.username || '');\nawait $type('#password', __input__.password || '');\nawait $click('#login-btn');\nawait $wait('.dashboard', 5000);`,
        condition: 'document.querySelector("#login-btn") !== null',
        onSuccess: 'scrape',
        onFailure: 'TERMINATE',
        maxIterations: 1
      },
      {
        id: 'scrape',
        name: 'Scrape Data',
        script: `return await $extract('.dashboard') || '';`,
        onSuccess: 'TERMINATE',
        onFailure: 'TERMINATE',
        maxIterations: 1
      }
    ]
  }
];

function getStepTemplates() {
  return STEP_TEMPLATES;
}

function applyTemplate(templateId) {
  const tmpl = STEP_TEMPLATES.find(t => t.id === templateId);
  if (!tmpl) return null;
  return tmpl.steps.map(step => ({ ...step }));
}

// RC54: caps for the confirmSelectorsWithFullHtml Elements section. The
// uncapped version embedded the full outerHTML of every candidate selector —
// container candidates (a page's main/feed wrappers) each repeat the entire
// rendered content, reaching a 756,464-token prompt (console.log
// 2026-08-14 13:51-13:5x): attempt 1 timed out at 120s, attempt 2 survived
// at ~78s only by luck. The opening tag + leading children of an oversized
// container carry all the structural signal a confirmation needs.
const RC54_MAX_ELEMENT_HTML_CHARS = 30000;
const RC54_TOTAL_ELEMENTS_BUDGET_CHARS = 200000;

// RC58 Fix B pre-pass: mark candidates whose full outerHTML is a substring of
// another candidate's (child field inside its container, or literal duplicate
// selectors matching the same node) so their HTML is embedded only once.
// Mutates the input array (adds _containedIn) — single-use per prompt build.
const MIN_CONTAINED_HTML_CHARS = 24;
function markContainedElements(elements) {
  const found = [];
  elements.forEach((e, i) => { if (e.found && e.outerHTML) found.push({ e, i }); });
  for (const { e: x, i: xi } of found) {
    const container = found.find(({ e: y, i: yi }) => {
      if (y === x) return false;
      if (y.outerHTML.indexOf(x.outerHTML) === -1) return false;
      // Equal HTML (duplicate selectors matching the same node) → the LATER
      // entry is the duplicate, always deduped. Strictly shorter HTML counts
      // as contained only above a floor: tiny fragments (<br>, <input ...>)
      // are coincidental substrings of many candidates, not real children.
      if (x.outerHTML.length === y.outerHTML.length) return xi > yi;
      return x.outerHTML.length < y.outerHTML.length &&
        x.outerHTML.length >= MIN_CONTAINED_HTML_CHARS;
    });
    if (container) x._containedIn = container.e.selector;
  }
  return elements;
}

// Content-hash for stability keys. Length-only keys false-settle when a feed
// swaps items during pagination (equal-length churn); hashing the actual
// structure/text content makes any content change produce a different key.
function hashString(s) {
  const str = String(s == null ? '' : s);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = ((h1 ^ c) * 0x01000193) >>> 0;
    h2 = ((h2 + c * (i + 1)) * 0x85ebca6b) >>> 0;
  }
  return h1.toString(36) + '-' + h2.toString(36);
}

// --- Requirement restatement gate (user request after the fourteenth log) ---
// The user describes the requirement in their own words; before research
// starts, the LLM restates it in the SAME language, organized and plain,
// with open questions for the underspecified parts. The user confirms or
// revises — users often believe they described it clearly until they read
// the restatement.

function buildRequirementRestatePrompt(requirementText) {
  const system = [
    'You are turning a rough web-scraping requirement into a clear restatement for the human who wrote it.',
    'Reply ONLY with a JSON object of this exact shape: {"language": "<code of the language you wrote in, e.g. zh / en>", "restatement": "<your restatement>", "openQuestions": ["<question>", ...]}',
    'Rules:',
    '- Write EVERYTHING (the restatement AND every open question) in the SAME language the requirement is written in. Chinese in → Chinese out; English in → English out. The "language" field is just the code.',
    '- The restatement must be easy for a non-programmer to read: plain words, short sentences, no code, no CSS selectors, no jargon.',
    '- Organize it with a few labeled lines (labels in that same language) covering: the goal (what this service is for), the inputs it takes, what it will do on the page (step by step, in order), and the data it returns per record.',
    '- Keep EVERY concrete detail the user gave (URLs, quantities, field names, limits, languages). Do NOT invent details they did not state.',
    '- openQuestions: at most 5 short questions about anything ambiguous, missing, or contradictory that would change HOW the service should work. If the requirement is already fully clear, use an empty array.'
  ].join('\n');
  return { system: system, user: String(requirementText == null ? '' : requirementText) };
}

function normalizeRestatement(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const restatement = typeof parsed.restatement === 'string' ? parsed.restatement.trim().slice(0, 4000) : '';
  if (!restatement) return null;
  const rawQs = Array.isArray(parsed.openQuestions) ? parsed.openQuestions : [];
  const openQuestions = rawQs
    .filter(q => typeof q === 'string' && q.trim())
    .map(q => q.trim().slice(0, 300))
    .slice(0, 5);
  const language = typeof parsed.language === 'string' ? parsed.language.trim().slice(0, 8) : '';
  return { language: language, restatement: restatement, openQuestions: openQuestions };
}


// RC58 Fix A: poll an injected async key function until the page settles.
// getKey returns a short stability key (hash of structure + text content —
// see hashString) or null when the probe itself fails (tab navigating),
// which counts as NOT settled and keeps polling. Returns { settled, polls }.
async function waitForPageSettle(getKey, opts) {
  const maxMs = (opts && opts.maxMs) || 30000;
  const pollMs = (opts && opts.pollMs) || 1000;
  const stableCount = (opts && opts.stableCount) || 2;
  const sleep = (opts && opts.sleep) || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastKey = null;
  let stableRun = 0;
  let polls = 0;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    let key = null;
    try { key = await getKey(); } catch (e) { key = null; }
    polls++;
    if (key !== null && key === lastKey) stableRun++; else stableRun = 1;
    lastKey = key;
    if (key !== null && stableRun >= stableCount) return { settled: true, polls };
  }
  return { settled: false, polls };
}

function formatElementsForPrompt(elements, opts) {
  const perElementCapChars = (opts && opts.perElementCapChars) || RC54_MAX_ELEMENT_HTML_CHARS;
  const totalBudgetChars = (opts && opts.totalBudgetChars) || RC54_TOTAL_ELEMENTS_BUDGET_CHARS;
  markContainedElements(elements);
  const lines = [];
  let used = 0;
  let budgetExhausted = false;
  for (const e of elements) {
    const header = '--- ' + e.selector + ' ---';
    if (!e.found) {
      lines.push(header + '\nNOT FOUND');
      continue;
    }
    if (e._containedIn) {
      lines.push(header + "\n[CONTAINED: this element's HTML appears inside '" + e._containedIn + "']");
      continue;
    }
    if (budgetExhausted) {
      lines.push(header + '\n[SKIPPED: element HTML budget exhausted — confirm from structure context]');
      continue;
    }
    const html = e.outerHTML || '';
    let block;
    if (html.length > perElementCapChars) {
      block = html.slice(0, perElementCapChars) + '\n[TRUNCATED: first ' + perElementCapChars + ' of ' + html.length + ' chars]';
    } else {
      block = html;
    }
    if (used + header.length + block.length >= totalBudgetChars) {
      budgetExhausted = true;
      lines.push(header + '\n[SKIPPED: element HTML budget exhausted — confirm from structure context]');
      continue;
    }
    used += header.length + block.length;
    lines.push(header + '\n' + block);
  }
  return lines.join('\n');
}


// Twenty-ninth log: previews of large step results were head-only slices, so
// summary keys a script placed at the END of its return value (counts,
// instrumented diagnostics — e.g. a timeMapSize probe distinguishing "spans
// absent" from "lookup failed") were cut exactly where they were needed to
// tell which pipeline stage lost the value. Keep BOTH ends: opening shape at
// the head, trailing summary keys at the tail (same tail-retention reasoning
// as the parse-error tail rider and the verify-report mirror clip). Applying
// it twice composes — re-slicing a head+tail slice still keeps both ends.
function headTailSlice(s, cap) {
  if (typeof s !== 'string' || s.length <= cap) return s;
  const sep = '…';
  const headLen = Math.max(1, Math.floor(cap * 0.7));
  const tailLen = cap - headLen - sep.length;
  if (tailLen <= 0) return s.slice(0, cap - sep.length) + sep;
  return s.slice(0, headLen) + sep + s.slice(-tailLen);
}

// Length-preserving blanker for the static lint below: comment bodies and
// string/template CONTENTS become spaces (delimiters and newlines stay), so
// character indices keep aligning with the original script.
function blankStringsAndCommentsForLint(src) {
  let out = '';
  let mode = null; // "'" | '"' | '`' | '//' | '/*'
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const d = i + 1 < src.length ? src[i + 1] : '';
    if (mode) {
      if (c === '\\') { out += '  '; i += 1; continue; }
      if (mode === '//' && c === '\n') { out += '\n'; mode = null; continue; }
      if (mode === '/*' && c === '*' && d === '/') { out += '  '; i += 1; mode = null; continue; }
      if ((mode === "'" || mode === '"' || mode === '`') && c === mode) { out += c; mode = null; continue; }
      out += (c === '\n') ? '\n' : ' ';
      continue;
    }
    if (c === '/' && d === '/') { mode = '//'; out += '  '; i += 1; continue; }
    if (c === '/' && d === '*') { mode = '/*'; out += '  '; i += 1; continue; }
    if (c === "'" || c === '"' || c === '`') { mode = c; out += c; continue; }
    out += c;
  }
  return out;
}

// Thirtieth log: ten turns burned on `const n = $count(sel)` without
// `await` — n held a Promise, `n > 0` was always false, and the resulting
// POLL_EXHAUSTED was misdiagnosed twice (slow cold-load, transient
// hydration) before a downstream clone error exposed it. Static lint for
// authoring-time (service.update receipt) and failure-time (POLL_EXHAUSTED
// augmentation): name the bug in one read. Skips: awaited calls, member
// calls (`obj.$x(`), `.then/.catch/.finally` chains, occurrences inside
// strings/comments, `Promise.all(...)` arguments, and assign-then-await
// deferral (`const p = $call(x)` with a later `await p`). The skip analysis
// lives in a helper so the scan loop stays flat — deep control-flow nests
// reading loop-external locals misresolve on some runtimes.
function detectUnawaitedDollarCalls(script) {
  if (typeof script !== 'string' || !script) return [];
  const blanked = blankStringsAndCommentsForLint(script);
  const hits = [];
  const callRe = /\$[A-Za-z_]*\s*\(/g;
  let m;
  while ((m = callRe.exec(blanked)) !== null) {
    if (unawaitedCallSkipped(blanked, m.index, m[0])) continue;
    hits.push({
      api: m[0].replace(/\s*\($/, ''),
      near: script.slice(Math.max(0, m.index - 48), Math.min(script.length, m.index + 64)).replace(/\s+/g, ' ').trim()
    });
  }
  return hits;
}

// Returns true when the $-call at `index` (matched text `matchText`) is an
// intentional un-awaited usage; false means record it as a hit. Kept FLAT
// (single-level guards, early returns): deep control-flow nests reading
// outer bindings misresolve as global loads on some runtimes — see the
// thirtieth-log notes.
function unawaitedCallSkipped(blanked, index, matchText) {
  const isIdChar = (ch) => /[A-Za-z0-9_$]/.test(ch);
  // Preceding token: member calls (`.` before the api) and `await` are fine.
  let j = index - 1;
  while (j >= 0 && /\s/.test(blanked[j])) j -= 1;
  if (j >= 0 && blanked[j] === '.') return true;
  let k = j;
  while (k >= 0 && isIdChar(blanked[k])) k -= 1;
  if (j >= 0 && blanked.slice(k + 1, j + 1) === 'await') return true;
  // `return $call(...)` — step scripts are async-function bodies, so returning
  // the promise is the canonical extraction idiom (executor awaits the fn).
  if (j >= 0 && blanked.slice(k + 1, j + 1) === 'return') return true;
  // Enclosing-call check: a hit whose nearest unmatched '(' belongs to
  // `Promise.all(...)` is intentional parallelism, not a bug. Scan
  // backwards with a depth counter so sibling calls earlier in the
  // argument list don't shadow the real enclosing paren.
  let enclosing = -1;
  let depth = 0;
  for (let p = index - 1; p >= 0; p--) {
    if (blanked[p] === ')') depth += 1;
    else if (blanked[p] === '(' && depth === 0) { enclosing = p; break; }
    else if (blanked[p] === '(') depth -= 1;
  }
  if (enclosing !== -1 && /Promise\.all\s*$/.test(blanked.slice(0, enclosing))) return true;
  // Matching close paren, then `.then/.catch/.finally` chain check.
  const openParen = index + matchText.length - 1;
  let closeDepth = 0;
  let close = -1;
  for (let p = openParen; p < blanked.length; p++) {
    if (blanked[p] === '(') closeDepth += 1;
    else if (blanked[p] === ')') {
      closeDepth -= 1;
      if (closeDepth === 0) { close = p; break; }
    }
  }
  const after = close !== -1 ? blanked.slice(close + 1).replace(/^\s+/, '') : '';
  if (/^\.(then|catch|finally)\b/.test(after)) return true;
  // Assignment-then-await deferral: `const p = $call(x)` followed later by
  // `await p` / `p.then(...)` is intentional, not a bug.
  const isAssign = j >= 1 && blanked[j] === '=' && blanked[j - 1] !== '=' &&
    blanked[j - 1] !== '!' && blanked[j - 1] !== '<' && blanked[j - 1] !== '>' && blanked[j - 1] !== '+';
  if (!isAssign) return false;
  let e = j - 1;
  while (e >= 0 && /\s/.test(blanked[e])) e -= 1;
  let k2 = e;
  while (k2 >= 0 && isIdChar(blanked[k2])) k2 -= 1;
  const name = blanked.slice(k2 + 1, e + 1);
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return false;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const laterRe = new RegExp('(?:await\\s+' + esc + '\\b|' + esc + '\\s*\\.\\s*then\\b)');
  return laterRe.test(blanked.slice(index));
}


// emptyFieldDiagnostics(partialEmpty, steps, events) → array of
// { field, path, emptyCount, totalCount, crumbs: [{stepId, stepName, api, selector, note}] }
//
// Thirty-first log: the time field was 5/5 empty across fifteen turns while
// the evidence ALREADY existed — the extract step's $labelledby calls were
// emitting falsification diagnostics (missingIds, "references id(s) that
// resolve to nothing") that STEP_ITERATION events carried in full, but green
// verify reports never surfaced them, so the model never learned WHY the
// lookup failed and concluded "state-dependent, not extractable".
//
// For each partial-empty field (from detectEmptyOutputFieldsByRatio), find
// the steps that own it and lift the falsification signals from the step's
// LAST STEP_ITERATION diagnostics into the verify report:
//   - perField entries (extractList family) whose field name matches with
//     matchCount === 0 — the sub-selector never matched;
//   - api-level diagnostics with a falsification note — labelledby's
//     missingIds/notes, attrAbsent, refCount === 0, matchCount === 0.
//
// Step association is a word-boundary scan over the RAW script (NOT the
// blanked lint form): quoted fieldMap keys ({'time': {...}}) live inside
// string literals, which blankStringsAndCommentsForLint erases. A
// coincidental selector hit only widens which steps' diagnostics get
// checked; the falsification filter restores precision. perField name
// matches associate independently of script text.
//
// Only the LAST iteration's diagnostics are read — earlier iterations are
// stale retries whose failures the final run may have outgrown.
function emptyFieldDiagnostics(partialEmpty, steps, events) {
  if (!Array.isArray(partialEmpty) || !partialEmpty.length) return [];
  if (!Array.isArray(steps) || !steps.length) return [];
  if (!Array.isArray(events) || !events.length) return [];
  const out = [];
  for (const pe of partialEmpty) {
    if (!pe || typeof pe !== 'object') continue;
    const field = typeof pe.field === 'string' ? pe.field : '';
    if (!field) continue;
    const isIdent = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(field);
    const esc = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let mentionRe = null;
    if (isIdent) {
      try { mentionRe = new RegExp('(?<![A-Za-z0-9_$])' + esc + '(?![A-Za-z0-9_$])'); }
      catch (e) { mentionRe = new RegExp('(^|[^A-Za-z0-9_$])' + esc + '($|[^A-Za-z0-9_$])'); }
    }
    const crumbs = [];
    const seen = [];
    for (const st of steps) {
      if (!st) continue;
      const script = String(st.script || '');
      const mentioned = !!(mentionRe && mentionRe.test(script));
      let lastDiags = null;
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (ev && ev.type === 'STEP_ITERATION' && String(ev.stepId) === String(st.id) && Array.isArray(ev.selectorDiagnostics)) {
          lastDiags = ev.selectorDiagnostics;
          break;
        }
      }
      if (!lastDiags) continue;
      // Association: script mention, or the step's own fieldMap names the
      // field (perField entries carry the fieldMap key verbatim).
      const namedInDiags = lastDiags.some((d) => d && Array.isArray(d.perField) &&
        d.perField.some((f) => f && String(f.field) === field));
      if (!mentioned && !namedInDiags) continue;
      for (const d of lastDiags) {
        const crumb = falsificationCrumb(d, field);
        if (!crumb) continue;
        const key = String(st.id) + '|' + crumb.api + '|' + String(crumb.selector);
        if (seen.indexOf(key) !== -1) continue;
        seen.push(key);
        crumbs.push(Object.assign({ stepId: st.id, stepName: st.name || null }, crumb));
        if (crumbs.length >= 2) break;
      }
      // Forty-third log: assembly renames (fieldMap key `timeLbl` renamed to
      // output `postTime` in the step's later .map) left renamed fields
      // crumb-less — the script names the OUTPUT field so the mention gate
      // passed, but falsificationCrumb's perField lookup keys on the output
      // name and found nothing, so every verify reported
      // emptyFieldDiagnostics:null while the failing crumb sat one key over.
      // When the exact-name pass came up empty, lift this step's FAILING
      // perField entries under their own names, marked asField. Healthy
      // entries are never lifted — no speculation about fields that resolve.
      if (!crumbs.length && mentioned) {
        let renameDone = false;
        for (const d of lastDiags) {
          if (!d || !Array.isArray(d.perField) || renameDone) continue;
          for (const f of d.perField) {
            if (!f || String(f.field) === field) continue;
            const failing = (f.subSelector && f.matchCount === 0) ||
              (f.labelledby && f.matchCount > 0 && f.refResolved === 0);
            if (!failing) continue;
            const crumb = falsificationCrumb(d, String(f.field));
            if (!crumb) continue;
            const key = String(st.id) + '|renamed|' + crumb.api + '|' + String(crumb.selector);
            if (seen.indexOf(key) !== -1) continue;
            seen.push(key);
            crumbs.push(Object.assign(
              { stepId: st.id, stepName: st.name || null, asField: field },
              crumb,
              {
                note: crumb.note + ' — extracted under fieldMap key "' + String(f.field) +
                  '", renamed to "' + field + '" at assembly'
              }
            ));
            if (crumbs.length >= 2) { renameDone = true; break; }
          }
        }
      }
      if (crumbs.length >= 2) break;
    }
    if (crumbs.length) {
      out.push({
        field: field,
        path: pe.path || field,
        emptyCount: pe.emptyCount,
        totalCount: pe.totalCount,
        crumbs: crumbs
      });
    }
  }
  return out;
}

// One falsification signal from a diagnostics entry, for the given field —
// null when the entry shows no evidence of WHY a value comes back empty.
function falsificationCrumb(d, field) {
  if (!d || typeof d !== 'object') return null;
  const api = typeof d.api === 'string' ? d.api : null;
  if (Array.isArray(d.perField)) {
    const f = d.perField.find((x) => x && String(x.field) === field);
    if (!f) return null;
    if (f.subSelector && f.matchCount === 0) {
      const total = typeof d.containerMatches === 'number' ? d.containerMatches : null;
      return {
        api: api || 'extractList',
        selector: String(f.subSelector),
        note: 'sub-selector for field "' + field + '" matched 0' + (total !== null ? ' of ' + total : '') + ' containers' +
          (d.containerSelector ? ' (container ' + d.containerSelector + ')' : '')
      };
    }
    // Thirty-third log D1: a labelledby field can MATCH every container yet
    // resolve no text (stale/dynamic referenced ids, or referenced elements
    // empty). That is a distinct falsification from a 0-match sub-selector —
    // the selector is right, the reference resolution died.
    if (f.labelledby && f.matchCount > 0 && f.refResolved === 0) {
      const ids = Array.isArray(f.missingIds) && f.missingIds.length
        ? ' (unresolved ids: ' + f.missingIds.slice(0, 3).map(String).join(', ') + ')'
        : '';
      return {
        api: api || 'extractList',
        selector: String(f.subSelector || ''),
        note: 'sub-selector for field "' + field + '" matched ' + f.matchCount + ' container(s) but the ' +
          String(f.labelledby) + ' resolution produced no text' + ids + ' — the anchor is right, the ARIA reference resolution died'
      };
    }
    return null;
  }
  const bits = [];
  if (typeof d.note === 'string' && d.note) bits.push(d.note);
  if (Array.isArray(d.missingIds) && d.missingIds.length) {
    bits.push('unresolved aria reference ids: ' + d.missingIds.slice(0, 4).map(String).join(', '));
  }
  if (d.refCount === 0) bits.push('aria reference resolved 0 elements');
  if (d.attrAbsent) bits.push(typeof d.attrAbsentNote === 'string' && d.attrAbsentNote ? d.attrAbsentNote : 'attribute "' + String(d.attrAbsent) + '" absent on the matched element');
  if (d.matchCount === 0 && typeof d.selector === 'string' && d.selector) bits.push('selector matched 0 elements');
  if (!bits.length) return null;
  let note = bits.join('; ');
  if (note.length > 240) note = note.slice(0, 237) + '…';
  return {
    api: api,
    selector: typeof d.selector === 'string' ? d.selector : null,
    note: note
  };
}


// detectNeverExtractedFields(steps, outputSchema) → array of
// { field, path, literalCount }
//
// Thirty-first log: comments/shares shipped as `comments: "", shares: ""`
// hardcoded literals inside the record-assembly return — schema-declared
// record fields no step ever extracts. Verify stayed green (a hardcoded ""
// satisfies shape checks) and only the user noticed. Statically detectable:
// scan the BLANKED scripts (strings/comments neutralized) for each schema
// record-field name; when EVERY mention is the `field: "..."` literal form
// (empty OR non-empty — a hardcoded "n/a" is the same failure), no fieldMap
// entry and no computed assignment exists anywhere — the field is never
// extracted. Any other mention-form (fieldMap `field: {selector}`) breaks
// the flag. Advisory-only: quoted fieldMap keys ('field': {...}) are blanked
// with their string content and produce ZERO mentions — never flagged (the
// verify-time emptyFieldDiagnostics digest is the runtime backstop).
function detectNeverExtractedFields(steps, outputSchema) {
  if (!Array.isArray(steps) || !steps.length) return [];
  const props = (outputSchema && outputSchema.properties && typeof outputSchema.properties === 'object' && !Array.isArray(outputSchema.properties))
    ? outputSchema.properties : {};
  let blanked = null;
  const out = [];
  const lintField = (f, path) => {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(f)) return;
    if (blanked === null) {
      blanked = steps.map((s) => blankStringsAndCommentsForLint(String((s && s.script) || ''))).join('\n');
    }
    const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let mentionRe, literalRe;
    try {
      mentionRe = new RegExp('(?<![A-Za-z0-9_$])' + esc + '(?![A-Za-z0-9_$])', 'g');
      literalRe = new RegExp('(?<![A-Za-z0-9_$])' + esc + '\\s*:\\s*([\'"`])[^\'"`\n]*\\1', 'g');
    } catch (e) {
      mentionRe = new RegExp('(^|[^A-Za-z0-9_$])' + esc + '($|[^A-Za-z0-9_$])', 'g');
      literalRe = new RegExp('(^|[^A-Za-z0-9_$])' + esc + '\\s*:\\s*([\'"`])[^\'"`\n]*\\2', 'g');
    }
    const mentions = (blanked.match(mentionRe) || []).length;
    const literals = (blanked.match(literalRe) || []).length;
    if (mentions > 0 && mentions === literals) {
      out.push({ field: f, path: path, literalCount: literals });
    }
  };
  // Forty-seventh log: recurse one schema level into nested record-array
  // fields — hoverCards[].type was declared (and hardcoded '') while this
  // lint never enumerated past depth 1, so the literal sat through three
  // deployed versions with no receipt naming it.
  const expand = (items, prefix) => {
    const req = Array.isArray(items.required) ? items.required.map(String) : [];
    const ipo = (items.properties && typeof items.properties === 'object' && !Array.isArray(items.properties)) ? items.properties : null;
    const ip = ipo ? Object.keys(ipo) : [];
    const fields = [];
    for (const f of req.concat(ip)) if (fields.indexOf(f) === -1) fields.push(f);
    if (!fields.length) return;
    for (const f of fields) lintField(f, prefix + '.' + f);
    if (!ipo) return;
    for (const f of fields) {
      const np = ipo[f];
      if (!np || np.type !== 'array' || !np.items || typeof np.items !== 'object' || Array.isArray(np.items)) continue;
      const nReq = Array.isArray(np.items.required) ? np.items.required.map(String) : [];
      const nProps = (np.items.properties && typeof np.items.properties === 'object' && !Array.isArray(np.items.properties)) ? Object.keys(np.items.properties) : [];
      const nFields = [];
      for (const nf of nReq.concat(nProps)) if (nFields.indexOf(nf) === -1) nFields.push(nf);
      for (const nf of nFields) lintField(nf, prefix + '.' + f + '[].' + nf);
    }
  };
  for (const key of Object.keys(props)) {
    const prop = props[key];
    const items = (prop && prop.items && typeof prop.items === 'object') ? prop.items : null;
    if (!items) continue;
    expand(items, key);
  }
  return out;
}



// Forty-sixth log F5: ONE literal bag feeds every resolution surface. In
// the wizard PAGE the two service.update static lints (detectUnawaitedDollar-
// Calls, detectNeverExtractedFields) were structurally dead for the whole
// campaign: session-tools' page-context resolveWU falls back to a literal
// 3-key bag when window.__wizardUtilsModuleMarker__ is absent — and nothing
// ever set the marker. Top-level function declarations hoist onto window in
// a classic script, which healed some callers by accident while resolveWU's
// fallback discarded everything outside its 3 keys (and const exports never
// reached window at all). Assign the full bag to the marker session-tools
// and verify-runner already resolve, and Object.assign it onto the global so
// direct property access keeps working. test/forty-sixth-log-followups.test.js
// pins marker-bag keys === module.exports keys so a future export cannot
// land on one surface only (the inline-fallback drift class, RC8/RC35).
var WU_EXPORT_BAG = { unverifiedArtifactState, parseSchemaFields, schemaArrayItemFieldKeys, buildTimeoutGuidance, hoverAwareTimeoutMs, detectClickInListTotalFailure, detectClickInListEmptyContainers, corroborateContainerZero, detectCountSelectorBlind, detectHoverAnchorsBlind, detectFieldMatchZero, detectContainerMatchZero, detectFrozenZeroCounter, parseCounterFields, isFrozenZeroNotReady, FROZEN_ZERO_STREAK_THRESHOLD, FROZEN_ZERO_MIN_ELAPSED_MS, detectFrozenScrollCount, FROZEN_NONZERO_STREAK_THRESHOLD, detectSiblingCountContrast, detectDuplicateIdValues, detectStrayFieldDeclarations, detectImplausibleTimeFields, detectPositionLikeIds, looksLikeDate, hasYearToken, extractDateSubstrings, detectNonStandardPseudoSelectors, detectLabelPrefixedCounts, detectJunkShapeRecords, seedLedgerFromSameSite, detectSchemaPlaceholderFields, estimateScriptTimeBudget, validateInputAgainstSchema, validateOutputAgainstSchema, findEmptyExtractionFields, findUpstreamExtractionStepId, findUpstreamProducingStepId, detectEmptyOutputFieldsByRatio, formatEmptyOutputFieldsSignal, detectDuplicateRecords, detectDuplicateEntities, detectOversizedFields, detectCountShortfall, detectRelativeTimestamps, formatDuplicateRecordsSignal, getOutputFieldOptions, truncateSnapshotForLLM, summarizeStepsGeneration, summarizeGeneratedSteps, stripSnapshotsFromTestResult, stripPagesFromLLMContext, dedupeStepIterations, elideDuplicateFinalResults, isPredecessorValue, sampleRecordsForLLMContext, formatDomActivitySummary, summarizeExecutionDiagnostics, summarizeAllStepDiagnostics, formatSelectorDiagnosticsForPrompt, scoreAttemptResult, scoreAnnotationBrittleness, scoreAnnotationChain, buildIORenderString, validateTestInput, cleanLLMResponse, parseJsonLenient, stripJSComments, validateSteps, validateForExecution, validateChain, buildStepIORenderString, getStepTemplates, applyTemplate, STEP_TEMPLATES, SCRIPT_DSL_GUIDE, appendGlobalContextBlock, buildAutoFixSystemMessage, fillEntryUrlDefaults, normalizeStepTopology, DEFAULT_POLL_MAX_ITERATIONS, appendStepWithChainLink, removeStepWithRelink, relinkChainToArray, ANNOTATION_PURPOSES, WAIT_CONDITIONS, buildAnnotationsText, checkSelectorFidelity, buildRequirementsBlock, suggestServiceName, getFirstRecordHtmlFromExecution, getFirstRecordHtmlFromAnyStep, formatElementsForPrompt, waitForPageSettle, hashString, buildRequirementRestatePrompt, normalizeRestatement, headTailSlice, detectUnawaitedDollarCalls, emptyFieldDiagnostics, detectNeverExtractedFields, detectHtmlFieldsWithoutTags, schemaItemRequiredForPath, RC54_MAX_ELEMENT_HTML_CHARS, RC54_TOTAL_ELEMENTS_BUDGET_CHARS };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = WU_EXPORT_BAG;
} else if (typeof window !== 'undefined') {
  window.__wizardUtilsModuleMarker__ = WU_EXPORT_BAG;
  Object.assign(window, WU_EXPORT_BAG);
} else if (typeof self !== 'undefined') {
  self.__wizardUtilsModuleMarker__ = WU_EXPORT_BAG;
  Object.assign(self, WU_EXPORT_BAG);
}
