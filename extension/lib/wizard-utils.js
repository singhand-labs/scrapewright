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
- $exists(selector, timeoutMs?): Check if a VISIBLE element exists (skips display:none / visibility:hidden / zero-size elements). Returns true immediately if found, false if not found within timeoutMs (default 5000ms). Use this for polling loops instead of $().
- $click(selector): Find element, click it. Returns true.
- $type(selector, text): Find element, set value, dispatch input/change events. Works on INPUT, TEXTAREA, and contenteditable elements. If selector matches a container, searches inside for an inputtable child. Returns true.
- $extract(selector, attribute?, timeoutMs?): Get textContent (or attribute if specified). Returns string. IMPORTANT: $extract waits only up to timeoutMs (default 5000ms, NOT 30s) for the element — if the selector is wrong it fails fast instead of burning the step's whole timeout. Prefer this over $() for reading known content; pass a longer timeoutMs only when you genuinely need to wait for content to render.
- $wait(selector, delayMs?): Wait for element (up to 30s via MutationObserver), then optional extra delay. Returns true. The selector is REQUIRED. If you only need a delay without waiting for an element, use 'await new Promise(r => setTimeout(r, ms))' instead.
- $check(selector, property): Read element property (e.g., 'checked', 'disabled'). Returns value.
- $openTab(url, functionBody): Open new tab at the given URL, wait for page load, then execute the function body (a string of JavaScript statements) in the new tab context. Returns whatever the function body returns. Use to scrape detail pages. Example: await $openTab(href, \`const title = await $extract('h1'); return { title };\`)
- $count(selector): Count elements matching selector (main document + same-origin iframes). Returns number. Do NOT use with :nth-child() to iterate — use $list() instead.
- $list(selector): Get ALL matching elements across main document + same-origin iframes. Returns array of { tagName, id, className, textContent, value, href, src, checked, disabled }. Use this for iterating multiple elements. Same data-object limitation as $().
- $extractList(containerSel, fieldMap, opts?): Extract a list of records in ONE call. fieldMap is { subField: subSelector | { selector, attr? } }; each sub-selector is evaluated INSIDE each container element and returns the FIRST match per container. Returns an array of objects in container order. Prefers this over $list-per-field for multi-field lists (avoids field-misalignment when fields are missing on some items). Throws 'empty list' if no container matches; set opts.allowEmpty=true to return [] instead.
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
  * href content: author links usually have href*="/user/" or href*="/profile.php"; timestamp links often have href*="/posts/" or no href at all.
  * ancestor tag: timestamp links are usually NOT inside <h3>; author links are.
  * attribute value pattern: aria-label on a timestamp matches date/time regexes (e.g. /^\\d{1,2}:\\d{2}$|^\\d+\\s+(?:hours?|days?)\\s+ago$|^yesterday$/i); aria-label on an author is a person name.
- Do NOT use bare attribute-presence selectors ([aria-label], [href]) for BOTH fields — that guarantees collision. Pick one field to make specific.
- When unsure, run $list on each candidate selector separately and inspect the returned textContent/href arrays — they should differ field-by-field.

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

CRITICAL: "position did not change" (r.scrolled === false) is the only reliable exhausted-feed signal. Do NOT guess that the feed is exhausted from a post count alone — infinite feeds often stop scrolling mid-page when the user is idle, then resume on the next scroll. Only declare done when BOTH (a) r.scrolled === false for the latest scroll AND (b) you have at least the user-requested number of posts (or a small number of consecutive unchanged scrolls — track via __lastResult__).
  // Stricter variant — require N consecutive no-progress scrolls before done:
  const r = await $scrollToBottom();
  await new Promise(resolve => setTimeout(resolve, 1500));
  const stalled = (__lastResult__ && __lastResult__.stalled || 0) + (r.scrolled ? 0 : 1);
  const postCount = await $count('li.result-item');
  if (stalled >= 3 && postCount > 0) return { done: true, postCount, exhausted: true };
  return { done: false, postCount, stalled };

SCROLL CONTAINER (not the window): some sites scroll an inner element (overflow:auto/scroll), not the document. If $count returns 0 after $scrollToBottom() with no selector, find the scrollable container in the snapshot and pass its selector: await $scrollToBottom('div[data-scrollable-container]'). A quick heuristic: the element with the largest scrollHeight that is NOT document.body is usually the feed's scroll root.

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
  const stalled = (__lastResult__ && __lastResult__.stalled || 0) + (r.scrolled ? 0 : 1);
  if (uniqueCount >= 10) return { done: true, uniqueCount, seenSignatures: [...seen].slice(0, 50) };
  if (stalled >= 5 && uniqueCount > 0) return { done: true, uniqueCount, seenSignatures: [...seen].slice(0, 50), exhausted: true };
  return { done: false, uniqueCount, stalled, seenSignatures: [...seen].slice(0, 50) };
Key insight: $count(DOM) ≠ unique posts seen. The DOM is a sliding window; signatures accumulated across iterations are the truth. Cap seenSignatures at ~50 entries to avoid unbounded growth across long feeds.

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

HOVER ENRICHMENT (hovercard / link-preview fields): some sites surface richer data — group name, member count, account bio, profile image URL — only in a popover that appears when the user hovers a link. The popover is NOT in the list DOM; it's injected into a portal layer on hover. Use \$hover to fire the popover, then parse fields out of htmlSnippet with \$extractListMulti on a temporary DOM root. Signature: \$hover(anchorSelector, popoverSelector?, opts?) → { hovered: bool, htmlSnippet: string|null, popoverSelector: string|null, reason?: 'popover_timeout'|'hover_failed'|<bg reason> }.
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
- \$hover requires Enhanced Mode (it uses CDP Input.dispatchMouseEvent under the hood to produce an isTrusted=true hover — JS-only mouseover is filtered by hover-gated loaders). Without Enhanced Mode, hovered:false with reason:'debugger permission not granted'. Surface this to the user via test-result feedback, not by retrying.
- popoverSelector is the popover container, NOT the field inside it. Inspect the page (DevTools Elements panel) while manually hovering the anchor to find the popover container selector. A weak popoverSelector (e.g. 'div') will match the wrong element; a too-specific one will time out.
- After \$hover returns, the framework auto-dismisses (moves the trusted cursor to (1,1) so the popover closes). Pass { dismiss: false } ONLY if you want the popover to linger (rare — usually you want it gone before the next iteration).
- AUTO-DISCOVERY: if your popoverSelector does not match within timeoutMs, the framework falls back to watching DOM mutations and picks up any new visible element of non-trivial size (>=50x50 px) added during the hover window. The result then carries \`autoDiscovered: true\` and \`popoverSelector: '[auto-discovered popover]'\`. This catches React Portal / Vue Teleport / Popper / Floating UI popovers when you don't know the exact container selector. It is still BETTER to provide the right popoverSelector (explicit beats heuristic) — use auto-discovery as a safety net, not a substitute for inspecting the popover DOM.
- For MULTIPLE records: pass \`{ index: i }\` per call. Do NOT batch-hovers — only one popover is on screen at a time, and most sites close the previous popover on the next hover.
- PREFER \$hover over \$openTab for hovercard data. \$openTab opens a NEW TAB (full navigation lifecycle, network refetch, 5-15s per record). \$hover stays in-page (~250-500ms per record) because the popover content is already loaded or fetched via XHR the page already knows how to make.
- If htmlSnippet is null after hover (popover never appeared), common causes: (a) popoverSelector wrong — inspect the actual popover DOM, (b) anchor offscreen — \$hover calls scrollIntoView first but some popovers only fire for fully-visible anchors, (c) hover handler gated on Enhanced Mode being enabled. Do NOT retry in a tight loop — surface the failure to the framework.

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

7. NEVER RETURN THE SAME SCRIPT (autoFix no-op rule): When you receive a fix request (after ACK), your response MUST actually change the code. Do NOT ACK the hint and then return the same script char-for-char — the framework detects this via isNoOpAutoFixPatch and rejects the response as a no-op. A no-op fix wastes an autoFix attempt and produces the SAME wrong output again. If you genuinely cannot see how to fix the problem after inspecting the script, the snapshot, and the annotations, use NACK with specifics (e.g., "// NACK: cannot determine username field — the page's profile_name area has no element matching 'Mamur Obaid' in the snapshot I was given; need an annotation on the username element") instead of faking a fix. A NACK surfaces a concrete question to the user; a no-op ACK wastes everyone's time.

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
  const commonFixed = repairCommonJsonMistakes(s);
  if (commonFixed !== s) {
    repairs.push('repair-common-mistakes');
    s = commonFixed;
  }
  // Remove commas that directly precede a closing } or ] (with optional whitespace).
  // Safe because no valid JSON has `,}` or `,]` — those are always malformed.
  const trailingFixed = s.replace(/,(\s*[}\]])/g, '$1');
  if (trailingFixed !== s) {
    repairs.push('remove-trailing-commas');
    s = trailingFixed;
  }
  try {
    return { ok: true, value: JSON.parse(s), repairs };
  } catch (e) {
    return { ok: false, error: e.message, repairs, repairedPreview: s.slice(0, 500) };
  }
}

// Decide which step an autoFix patch should apply to. The marked targetStepId
// is a heuristic (the last step on user-feedback path; the failing step on
// error path) — the actual root cause often lives in a different step.
//
// Return contract:
//   {step, redirected: false}                          — apply to targetStepId
//   {step, redirected: true, redirectedFrom}           — apply to LLM-chosen step
//   {step, redirected: false, fallbackReason}          — LLM picked invalid step; fell back
//   {error}                                             — targetStepId itself invalid
//
// bugx.log 2026-07-24 04:47:12 showed the LLM understood user feedback
// ("publishTime missing, only 3 posts") but couldn't act on it because
// RETURN_FORMAT constrained the patch to the marked step (5, finalize)
// while the root cause was in step 4 (extract_posts). Letting the LLM
// redirect unblocks this without forcing a multi-step patch format.
function resolveAutoFixTarget(obj, targetStepId, allSteps) {
  if (!obj || typeof obj !== 'object') {
    return { error: 'invalid LLM response (non-object)' };
  }
  const fallbackStep = allSteps.find(s => s.id === targetStepId);
  if (!fallbackStep) {
    return { error: 'target step not found: ' + targetStepId };
  }
  // Only honor string stepId. Defensive against LLMs that return numbers
  // (e.g. stepId: 4) — those would silently coerce and might match by accident.
  const requestedId = (typeof obj.stepId === 'string' && obj.stepId.trim())
    ? obj.stepId.trim()
    : null;
  if (!requestedId || requestedId === targetStepId) {
    return { step: fallbackStep, redirected: false };
  }
  const redirect = allSteps.find(s => s.id === requestedId);
  if (!redirect) {
    return {
      step: fallbackStep,
      redirected: false,
      fallbackReason: `LLM requested unknown stepId "${requestedId}", falling back to targetStepId "${targetStepId}"`
    };
  }
  return { step: redirect, redirected: true, redirectedFrom: targetStepId };
}

// Multi-step variant. bugx.log 2026-07-24 07:04:16 showed the single-target
// design still failed user-feedback fixes: the LLM kept patching step 5
// ("extract_images_per_post") instead of step 4 (where publishTime's broken
// selector lived) — even with the redirect option, glm-5.1 chose to
// re-extract inside step 5 rather than redirect. The architectural fix is to
// let the LLM return MULTIPLE patches in one iteration so it can fix every
// root-cause step at once.
//
// Input: `patches` is an array of {stepId, script, ...edgeFields}. Each patch
// must reference a real step id. `targetStepId` is the heuristic fallback —
// used when a patch omits stepId (legacy single-target shape) AND when the
// whole `patches` array is empty (caller decides whether that's an error).
//
// `targetStepId` may be `null` (user-feedback path as of 2026-07-24 — the
// previous "default to last step" heuristic was wrong because user-observed
// extraction bugs usually live in an upstream step, not the finalizer). When
// targetStepId is null:
//   - Patches WITHOUT stepId are HARD errors (no implicit target).
//   - Patches WITH a valid stepId resolve normally; `redirected` is `false`
//     and `redirectedFrom` is `null` (there was nothing to redirect from).
//
// Returns: {resolved: [{step, patch, redirected}], errors: [string]}.
// - resolved: patches ready to apply, in the order they should be applied
//   (we apply by stepId, so order doesn't matter, but we preserve LLM order
//   for log readability)
// - errors: hard errors that should abort the whole iteration. Soft issues
//   (unknown stepId → fall back to targetStepId) are recorded per-resolved
//   as `redirected: false, fallbackReason: '...'` and NOT promoted to errors.
function resolveAutoFixTargets(patches, targetStepId, allSteps) {
  if (!Array.isArray(patches)) {
    return { errors: ['patches must be an array'] };
  }
  const fallbackStep = targetStepId ? allSteps.find(s => s.id === targetStepId) : null;
  if (targetStepId && !fallbackStep) {
    return { errors: ['target step not found: ' + targetStepId] };
  }
  const resolved = [];
  const errors = [];
  const seenStepIds = new Set();
  const claim = (step) => {
    if (seenStepIds.has(step.id)) {
      errors.push(`duplicate patch for step "${step.id}"`);
      return false;
    }
    seenStepIds.add(step.id);
    return true;
  };
  for (let i = 0; i < patches.length; i++) {
    const p = patches[i];
    if (!p || typeof p !== 'object') {
      errors.push(`patch[${i}] is not an object`);
      continue;
    }
    if (typeof p.script !== 'string' || !p.script.trim()) {
      errors.push(`patch[${i}].script is missing or empty`);
      continue;
    }
    const requestedId = (typeof p.stepId === 'string' && p.stepId.trim())
      ? p.stepId.trim()
      : null;

    // No stepId on this patch — needs a fallback target.
    if (!requestedId) {
      if (!fallbackStep) {
        errors.push(`patch[${i}] is missing "stepId" — pick a step id from FULL STEP WORKFLOW`);
        continue;
      }
      if (!claim(fallbackStep)) continue;
      resolved.push({ step: fallbackStep, patch: p, redirected: false });
      continue;
    }

    // LLM explicitly picked the heuristic target — no redirect.
    if (targetStepId && requestedId === targetStepId) {
      if (!claim(fallbackStep)) continue;
      resolved.push({ step: fallbackStep, patch: p, redirected: false });
      continue;
    }

    // LLM picked a different step — look it up.
    const redirect = allSteps.find(s => s.id === requestedId);
    if (!redirect) {
      // Unknown stepId — soft-fallback when we have a heuristic target,
      // hard-error when we don't (user-feedback path demands an explicit id).
      if (fallbackStep) {
        if (!claim(fallbackStep)) continue;
        resolved.push({
          step: fallbackStep,
          patch: p,
          redirected: false,
          fallbackReason: `patch[${i}] requested unknown stepId "${requestedId}", falling back to targetStepId "${targetStepId}"`
        });
      } else {
        errors.push(`patch[${i}] requested unknown stepId "${requestedId}"`);
      }
      continue;
    }
    if (!claim(redirect)) continue;
    resolved.push({
      step: redirect,
      patch: p,
      redirected: !!targetStepId,
      redirectedFrom: targetStepId || null
    });
  }
  return { resolved, errors };
}

function buildResearchPrompt(url, description, html, text) {
  // `text` argument kept for backward compatibility but no longer rendered —
  // the cleaned HTML carries both structure and short text content.
  return `I need to create a web scraping script for this page.\n\nURL: ${url}\nRequirements: ${description}\n\nPage HTML (cleaned):\n${html}\n\nPlease analyze the page and return a JSON object with:\n- findings: string describing what you found\n- needsAnnotation: boolean, true if you need user to identify specific elements\n- draftScript: string with JavaScript code using $, $click, $type, $extract, $wait, $check, $openTab APIs\n- inputSchema: JSON Schema object describing the script's input parameters\n- outputSchema: JSON Schema object describing the script's output structure\n- sampleInput: a JSON object with example values matching inputSchema`;
}

function buildFixPrompt(error, url, description, script, html, text, annotations, feedback) {
  // `text` argument kept for backward compatibility but no longer rendered.
  let prompt = `The following scraping script failed with error: ${error}\n\nTarget URL: ${url}\nOriginal requirement: ${description}\n\nCurrent script:\n${script}\n\nPage HTML (cleaned):\n${html}\n\nAnnotations: ${JSON.stringify(annotations)}`;
  if (feedback) prompt += '\n\nUser feedback: ' + feedback;
  prompt += '\n\nPlease fix the script. Return ONLY the fixed JavaScript code, no explanation.';
  return prompt;
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
const ARRAY_EXTRACTION_RE = /\$(extractList|extractListMulti|list)\s*\(/;
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

function findEmptyExtractionFields(data, outputSchema) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  if (!outputSchema || !Array.isArray(outputSchema.required) || outputSchema.required.length === 0) return [];

  const isEmptyValue = (v) =>
    v === '' || v === null || v === undefined || (Array.isArray(v) && v.length === 0);

  // A property is "array-of-objects" if the schema declares type:'array' with
  // object items. For these fields, an empty array means the script ran but
  // extracted zero records — a clear extraction failure (the page has items,
  // the selectors missed them). For scalar-array fields (string[]), an empty
  // array can legitimately mean "the page had no matching items", so we leave
  // those for validateOutputAgainstSchema to surface as a missing-field.
  const isArrayOfObjects = (key) => {
    const prop = outputSchema.properties && outputSchema.properties[key];
    return !!(prop && prop.type === 'array' && prop.items && prop.items.type === 'object');
  };

  const empty = [];
  for (const key of outputSchema.required) {
    const v = data[key];
    if (isArrayOfObjects(key) && Array.isArray(v) && v.length === 0) {
      empty.push(key);
      continue;
    }
    if (!Array.isArray(v) || v.length === 0) continue; // scalar or empty scalar-array: leave to validateOutputAgainstSchema
    // Array of objects where every object has only empty values
    if (v.every(el => el && typeof el === 'object' && !Array.isArray(el) &&
                     Object.values(el).every(isEmptyValue))) {
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
//   minRecords (default 2) — ignore output arrays shorter than this. A single
//     record can't meaningfully establish a "pattern of emptiness".
function detectEmptyOutputFieldsByRatio(data, outputSchema, options) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  if (!outputSchema || typeof outputSchema !== 'object') return [];
  const opts = options || {};
  const threshold = typeof opts.emptyRatioThreshold === 'number' ? opts.emptyRatioThreshold : 0.5;
  const maxSamples = typeof opts.maxSamples === 'number' ? opts.maxSamples : 3;
  const minRecords = typeof opts.minRecords === 'number' ? opts.minRecords : 2;

  const isEmptyValue = (v) =>
    v === '' || v === null || v === undefined ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === 'string' && v.trim() === '');

  const props = outputSchema.properties && typeof outputSchema.properties === 'object'
    ? outputSchema.properties
    : {};

  const result = [];
  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (!prop || prop.type !== 'array' || !prop.items || prop.items.type !== 'object') continue;
    const arr = data[key];
    if (!Array.isArray(arr) || arr.length < minRecords) continue;
    const itemSchema = prop.items.properties && typeof prop.items.properties === 'object'
      ? prop.items.properties
      : {};
    const itemRequired = Array.isArray(prop.items.required) ? prop.items.required : null;
    const fieldKeys = itemRequired && itemRequired.length > 0
      ? itemRequired
      : Object.keys(itemSchema);
    if (fieldKeys.length === 0) continue;
    for (const fk of fieldKeys) {
      let emptyCount = 0;
      const samples = [];
      for (const rec of arr) {
        if (!rec || typeof rec !== 'object') { emptyCount += 1; continue; }
        const v = rec[fk];
        if (isEmptyValue(v)) {
          emptyCount += 1;
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
        sampleNonEmpty: samples
      });
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
    if (!prop || prop.type !== 'array' || !prop.items || prop.items.type !== 'object') continue;
    const arr = data[key];
    if (!Array.isArray(arr) || arr.length < minRecords) continue;
    const itemSchema = prop.items.properties && typeof prop.items.properties === 'object'
      ? prop.items.properties
      : {};
    const itemRequired = Array.isArray(prop.items.required) ? prop.items.required : null;
    const fieldKeys = itemRequired && itemRequired.length > 0
      ? itemRequired
      : Object.keys(itemSchema);
    if (fieldKeys.length === 0) continue;

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

// Returns true when EVERY resolved autoFix patch leaves its step unchanged
// (same script + same flow fields, modulo trailing whitespace). Used by
// runFixIteration to detect the ACK-without-fixing antipattern where the LLM
// says "I'll fix it" but returns char-for-char the same code (console.log
// 2026-08-04 04:50-04:52 username-conflation loop: LLM ACK'd "I'll distinguish group
// from user links", returned identical scriptLength:2640, testScript produced
// identical wrong output, autoFix burned an attempt with zero progress).
//
// Whitespace-tolerant: LLMs routinely append trailing newlines. A real fix
// changes more than whitespace, so trim-compare avoids false negatives (which
// would cause the detector to miss real no-ops and waste a testScript run).
//
// Conservative: empty/malformed inputs return false (NOT a no-op) so the
// caller falls through to normal patch handling rather than misclassifying.
function isNoOpAutoFixPatch(resolved, patchedById) {
  if (!Array.isArray(resolved) || resolved.length === 0) return false;
  if (!patchedById || typeof patchedById.get !== 'function') return false;
  for (const r of resolved) {
    if (!r || !r.step || !r.step.id) return false;
    const entry = patchedById.get(r.step.id);
    if (!entry || !entry.proposed) return false;
    const cur = r.step;
    const next = entry.proposed;
    const scriptSame = (cur.script || '') === (next.script || '')
      || (cur.script || '').trim() === (next.script || '').trim();
    if (!scriptSame) return false;
    if ((cur.onSuccess || '') !== (next.onSuccess || '')) return false;
    if ((cur.onFailure || '') !== (next.onFailure || '')) return false;
    if ((cur.maxIterations || 1) !== (next.maxIterations || 1)) return false;
  }
  return true;
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

function summarizeFixIteration({ stepId, stepName, script, annotations, userFeedback, error, result, htmlContext } = {}) {
  const lines = [];
  const safeStepId = stepId || '(unknown)';
  const safeStepName = stepName || '(unknown)';
  lines.push(`[Attempt — step "${safeStepId}" ("${safeStepName}")]`);

  // htmlContext is the HTML section (full body OR fingerprint reference) from
  // the round this entry describes. Optional — old callers without it still work.
  if (htmlContext && typeof htmlContext === 'string' && htmlContext.trim()) {
    lines.push('Page context:');
    lines.push(htmlContext);
  }

  lines.push('Script tried:');
  lines.push(typeof script === 'string' && script.length ? script : '(none)');

  lines.push('Annotations:');
  if (Array.isArray(annotations) && annotations.length > 0) {
    for (const a of annotations) {
      const sel = a && a.selector ? a.selector : '(no selector)';
      const target = a && a.outputField ? a.outputField : (a && a.inputField ? a.inputField : '');
      const purpose = a && a.purpose ? a.purpose : '';
      const waitCondition = a && a.waitCondition ? a.waitCondition : '';
      const tail = [target, purpose, waitCondition].filter(Boolean).join(' → ');
      lines.push(tail ? `  - ${sel} → ${tail}` : `  - ${sel}`);
    }
  } else {
    lines.push('  (none)');
  }

  lines.push('User feedback: ' + (userFeedback ? userFeedback : '(none)'));
  lines.push('Error: ' + (error ? error : '(none)'));
  if (result === undefined || result === null) {
    lines.push('Result: (none)');
  } else {
    try {
      // Strip snapshots + strip pages[]/sourcePageId + cap field sizes — without
      // this, a 5-step feed-style test result carries ~750K chars of per-step HTML and
      // overflows the LLM context. The failing step's DOM is already supplied
      // separately via the truncated `pageSnapshot` (30K budget). Also drop
      // pages[] (~4MB) and sourcePageId (meaningless provenance). console.log
      // 2026-07-26: testResultSection + summarizeFixIteration were the two bloat
      // sources; the pages[] leak was caught in code review on T7.
      //
      // dedupeStepIterations (console.log 2026-08-05): collapse polling-step
      // iteration entries to the LAST per stepId BEFORE strip/cap. A 9-iteration
      // step-5 with growing updatedPosts bloated the history entry to ~290K
      // even after the 5K-per-field cap; the accumulator arrays bypassed the
      // cap because each individual field was small. The LLM timed out 4× then
      // hit model_context_window_exceeded.
      lines.push('Result: ' + JSON.stringify(stripPagesFromLLMContext(stripSnapshotsFromTestResult(dedupeStepIterations(result)))));
    } catch {
      lines.push('Result: (unserializable)');
    }
  }

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
function stripSnapshotsFromTestResult(testResult) {
  if (!testResult || typeof testResult !== 'object') return testResult;
  const capStr = (s) => {
    if (typeof s !== 'string') return s;
    if (s.length <= TEST_RESULT_FIELD_CHAR_CAP) return s;
    return `[TRUNCATED ${s.length} chars] ` + s.substring(0, TEST_RESULT_FIELD_CHAR_CAP - 30);
  };
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

// summarizeAllStepDiagnostics(events, steps) → string
//
// Like summarizeExecutionDiagnostics, but iterates over EVERY step in `steps`
// that has at least one STEP_ITERATION event. Used by the user-feedback autoFix
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
// Returns '' if no step has iterations.
function summarizeAllStepDiagnostics(events, steps) {
  if (!Array.isArray(events) || events.length === 0) return '';
  if (!Array.isArray(steps) || steps.length === 0) return '';

  const byStep = new Map();
  for (const evt of events) {
    if (!evt || evt.type !== 'STEP_ITERATION') continue;
    if (!byStep.has(evt.stepId)) byStep.set(evt.stepId, []);
    byStep.get(evt.stepId).push(evt);
  }

  const lines = [];
  for (const step of steps) {
    if (!step || !step.id) continue;
    const iterEvents = byStep.get(step.id);
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
        if (d.api === 'extractList') {
          let header = '    $extractList(\'' + d.containerSelector + '\') — container matched ' + d.containerMatches + ' element(s)';
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
            // Cap at 1800 chars per call so N extractList calls in one step
            // can't blow up the prompt. The source-side cap is 2000; this
            // trims a bit more to leave room for the surrounding markers.
            const html = d.firstContainerHtml.length > 1800
              ? d.firstContainerHtml.slice(0, 1800) + '…[truncated]'
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

// Pure classifier: given autoFix state, decide if the loop should break with a
// human-intervention message. Returns { type, severity, message, uiAction } or null.
// Every type requires MULTIPLE signals (false-positive defense). Never throws.
function classifyIntervention(ctx) {
  try {
    if (!ctx || typeof ctx !== 'object') return null;
    const error = (typeof ctx.error === 'string' ? ctx.error : '') || '';
    const lastError = (typeof ctx.lastError === 'string' ? ctx.lastError : '') || '';
    const annotations = Array.isArray(ctx.annotations) ? ctx.annotations : [];
    const attemptCount = Number.isFinite(ctx.attemptCount) ? ctx.attemptCount : 0;
    const dismissed = ctx.dismissed instanceof Set ? ctx.dismissed : new Set();
    const snapshotAgeMs = Number.isFinite(ctx.snapshotAgeMs) ? ctx.snapshotAgeMs : 0;
    const outputSchema = ctx.outputSchema && typeof ctx.outputSchema === 'object' ? ctx.outputSchema : null;
    const result = ctx.result && typeof ctx.result === 'object' ? ctx.result : null;

    const scoreResult = outputSchema ? scoreAttemptResult(result, outputSchema) : { score: 0, isData: false };
    const candidates = [];

    // needs_annotation: extraction empty + step has no annotations
    if (scoreResult.score === 0 && annotations.length === 0 && /EXTRACTION|EMPTY/i.test(error)) {
      candidates.push({
        type: 'needs_annotation',
        severity: 'warn',
        uiAction: 'annotate_step',
        _priority: 20,
        message: "Extraction returns empty. Click 'Start Annotating' on the failing step to manually select elements."
      });
    }

    // needs_annotation_relax: annotations exist but selectors are brittle.
    // Two triggers, different timing:
    //  - hasPositional (:nth-of-type/:nth-child) is a static brittleness signal; fire immediately.
    //  - listEmpty alone is weak (could be LLM's first attempt); defer until attempt 2.
    if (scoreResult.score === 0 && annotations.length > 0) {
      const hasPositional = annotations.some(a => typeof a?.selector === 'string' && /:nth-of-type|:nth-child/.test(a.selector));
      const listEmpty = (scoreResult.breakdown?.listItemCount ?? 0) === 0;
      if (hasPositional || (listEmpty && attemptCount >= 2)) {
        candidates.push({
          type: 'needs_annotation_relax',
          severity: 'warn',
          uiAction: 'annotate_step',
          _priority: 30,
          message: "Your annotation selectors don't match any element on the live page. Re-annotate or broaden the selector."
        });
      }
    }

    // needs_login: explicit LOGIN_REQUIRED marker
    if (/LOGIN_REQUIRED/i.test(error) || /LOGIN_REQUIRED/i.test(lastError)) {
      candidates.push({
        type: 'needs_login',
        severity: 'error',
        uiAction: 'open_tab',
        _priority: 100,
        message: 'This page requires login. Log in manually in the target tab, then retry.'
      });
    }

    // rate_limited: 429 in either error or lastError
    if (/429/.test(error) || /429/.test(lastError)) {
      candidates.push({
        type: 'rate_limited',
        severity: 'error',
        uiAction: 'open_settings',
        _priority: 90,
        message: 'LLM provider rate-limited. Wait, switch API key, or try later.'
      });
    }

    // page_state_stale: attempt>=2 + repeated same error + snapshot older than 60s
    if (attemptCount >= 2 && error && error === lastError && snapshotAgeMs > 60000) {
      candidates.push({
        type: 'page_state_stale',
        severity: 'warn',
        uiAction: 'refresh_tab',
        _priority: 50,
        message: 'Page state may have changed since the test started. Refresh the target tab manually, then retry.'
      });
    }

    // Filter dismissed, pick highest severity (error > warn > info), ties by priority rank
    // (higher rank = more fundamental root cause; page_state_stale beats annotation issues).
    const severityRank = { error: 3, warn: 2, info: 1 };
    const surviving = candidates.filter(c => !dismissed.has(c.type));
    if (surviving.length === 0) return null;
    surviving.sort((a, b) => {
      const sevDiff = (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0);
      if (sevDiff !== 0) return sevDiff;
      return (b._priority ?? 0) - (a._priority ?? 0);
    });
    const winner = surviving[0];
    delete winner._priority;
    return winner;
  } catch (e) {
    try { (typeof debugLogger !== 'undefined' && debugLogger.log('warn', 'wizard-utils', 'classifyIntervention failed', { error: e.message })); } catch {}
    return null;
  }
}

// Build the Section 1 prompt block for user feedback. Empty when no feedback.
// Includes ACK/NACK protocol requiring the LLM to acknowledge or refuse the hint
// before writing script. When llmHistory shows 2+ prior NACKs of the same hint,
// appends a "you may be wrong" note.
function buildFeedbackSection(feedback, attemptNum, totalAttempts, llmHistory) {
  if (typeof feedback !== 'string' || !feedback.trim()) return '';
  const safe = (attemptNum && totalAttempts)
    ? `(attempt ${attemptNum}/${totalAttempts} — ACK REQUIRED)`
    : '(ACK REQUIRED)';
  // Escape ${} and backticks so the verbatim hint doesn't break the surrounding template literal
  const escaped = feedback.replace(/[`]/g, "'").replace(/\$\{/g, '\\${');
  const lines = [
    `=== USER FEEDBACK ${safe} ===`,
    escaped,
    '',
    'Before writing the script, output ONE of these lines:',
    '  // ACK: <paraphrase the hint in your own words>',
    '  // NACK: <why you cannot apply it, with specifics>',
    '',
    'If you NACK a hint that the user explicitly gave, you are probably wrong.',
    '=== END USER FEEDBACK ==='
  ];

  // Count prior NACKs of this same feedback in llmHistory
  if (Array.isArray(llmHistory) && llmHistory.length >= 2) {
    const feedbackHash = escaped.slice(0, 40);
    let nackCount = 0;
    for (let i = 1; i < llmHistory.length; i += 2) {
      const prevAssistant = llmHistory[i] && typeof llmHistory[i].content === 'string' ? llmHistory[i].content : '';
      const prevUser = llmHistory[i - 1] && typeof llmHistory[i - 1].content === 'string' ? llmHistory[i - 1].content : '';
      if (prevUser.includes(feedbackHash) && /^\s*\/\/\s*NACK:/i.test(prevAssistant)) {
        nackCount++;
      }
    }
    if (nackCount >= 2) {
      lines.push('');
      lines.push(`Note: you have NACKed this hint ${nackCount} times. Consider that the hint may be correct and your model of the page may be wrong.`);
    }
  }
  return lines.join('\n');
}

// ============================================================================
// No-op escalation (console.log 2026-08-05 07:13–07:22)
//
// When the user submits the same feedback twice and autoFix rejects both
// responses as no-ops, the LLM has shown it cannot produce a different fix
// without an explicit signal. The [NO-OP DETECTED] message pushed into
// llmHistory alone was insufficient — the LLM returned byte-identical
// responses across iterations (3785 bytes × 3 iterations, identical ACK text),
// proving it either ignored history or hit an upstream proxy cache.
//
// These helpers add a CURRENT-prompt warning with a unique iteration counter.
// The counter both (a) tells the LLM this is a retry and (b) busts any
// upstream cache that keys on identical request bodies.
//
// Universality: no site-specific terms. The strategies listed are generic
// (record comparison, selector anchoring, NACK escape hatch).
// ============================================================================

// Returns the escalation block to inject into the current autoFix prompt when
// the same user feedback has been rejected as a no-op one or more times.
// Returns empty string when consecutiveNoOpCount is 0 (first-time feedback).
function buildNoOpEscalationSection(consecutiveNoOpCount) {
  if (!Number.isFinite(consecutiveNoOpCount) || consecutiveNoOpCount <= 0) return '';
  const n = Math.floor(consecutiveNoOpCount);
  return [
    `=== PREVIOUS FIX REJECTED (NO-OP) — ITERATION ${n} ===`,
    `Your previous response for this exact user feedback was rejected because the proposed script was byte-identical to the current script — no change was applied, and the user is submitting the same feedback again. This is iteration ${n} of the same complaint.`,
    '',
    'You MUST produce a DIFFERENT script this time. Strategies that may help break out of the anchor:',
    '- Read the Current output block carefully. Find the specific record(s) the user is complaining about by matching their description (e.g. position, value, content snippet).',
    '- Compare a WORKING record vs a BROKEN record in the same output — what field value differs, and what DOM difference would cause it?',
    '- Try a different selector anchor: if your current selector uses one attribute (href, class, role, aria-label), try a different attribute or a different ancestor container.',
    '- If the field name in the output is ambiguous (e.g. the same DOM element is being read for two different output fields), distinguish them by reading from DIFFERENT sub-elements rather than the same one.',
    '- If you genuinely cannot fix this after reading the script + output + diagnostics, respond with "// NACK: <specific reason>" — DO NOT return the same script.',
    '',
    'DO NOT return the same script. The framework will detect it and reject again.',
    '=== END PREVIOUS FIX REJECTED ===',
    ''
  ].join('\n');
}

// Mutates `state` (wizardState or test fixture) to register a no-op for the
// given feedback. Increments consecutiveNoOpCount when the feedback matches
// the prior registration; resets to 1 when it differs. Trims feedback before
// comparison so whitespace-only differences don't reset the counter.
function registerNoOpForFeedback(state, feedback) {
  if (!state || typeof state !== 'object') return;
  const safe = typeof feedback === 'string' ? feedback.trim() : '';
  const prev = typeof state.lastNoOpFeedback === 'string' ? state.lastNoOpFeedback.trim() : '';
  if (safe && safe === prev) {
    state.consecutiveNoOpCount = (state.consecutiveNoOpCount || 0) + 1;
  } else {
    state.consecutiveNoOpCount = 1;
    state.lastNoOpFeedback = safe;
  }
}

// Mutates `state` to clear the no-op escalation signal. Called on successful
// fix application (any patch that passes isNoOpAutoFixPatch).
function resetNoOpEscalation(state) {
  if (!state || typeof state !== 'object') return;
  state.consecutiveNoOpCount = 0;
  state.lastNoOpFeedback = null;
}

// Pure planning helper: decide what to patch + how to truncate llmHistory when
// restoring the best attempt. Returns null if no patches apply.
// wizard.js applies the returned plan (mutates wizardState + syncs DOM).
//
// Two shapes are accepted (bestAttempt is in-memory only — no persistence
// migration, but tests + callers may construct either):
//
//   NEW (RC11) — multi-step snapshot, used after the lastErrorStepId gate was
//   dropped from wizard.js scoring. The user-feedback path uses
//   RETURN_FORMAT_FEEDBACK which patches MULTIPLE steps in one iteration; a
//   single-step snapshot would only revert one of N patches and leave the
//   workflow in a half-reverted state.
//     { stepsSnapshot: [{id, script, onSuccess, onFailure, maxIterations}, ...],
//       historyMarker: '[Attempt — step "4"',  // matches summarizeFixIteration
//       score, attemptNum, breakdown }
//
//   LEGACY — single-step shape (pre-RC11). Still emitted by older call sites
//   and tests; kept supported to avoid breaking anything that constructs
//   bestAttempt manually.
//     { stepId, script, onSuccess, onFailure, maxIterations, score, attemptNum }
//
// Returns { stepPatches: [{id, stepPatch}], truncatedHistory, logMessage }.
// stepPatches has length >= 1 on success (null return otherwise).
function planRestoreBestAttempt(bestAttempt, currentSteps, currentLlmHistory) {
  try {
    if (!bestAttempt || typeof bestAttempt !== 'object') return null;
    if (!Array.isArray(currentSteps)) return null;

    const snapshots = Array.isArray(bestAttempt.stepsSnapshot) ? bestAttempt.stepsSnapshot : null;
    let stepPatches = [];
    let markerStepId = bestAttempt.stepId || null;

    if (snapshots) {
      // Multi-step: match each snapshot to a current step by id. Skip
      // snapshots whose step was removed (don't re-add — topology changes
      // need explicit relink via removeStepWithRelink / appendStepWithChainLink).
      for (const snap of snapshots) {
        if (!snap || typeof snap !== 'object' || !snap.id) continue;
        const cur = currentSteps.find(s => s && s.id === snap.id);
        if (!cur) continue;
        stepPatches.push({
          id: snap.id,
          stepPatch: {
            script: snap.script,
            onSuccess: snap.onSuccess,
            onFailure: snap.onFailure,
            maxIterations: snap.maxIterations
          }
        });
      }
      if (stepPatches.length === 0) return null;
      // Prefer the first surviving snapshot's id as the marker source — but
      // only when the caller didn't supply historyMarker explicitly (the
      // user-feedback path emits `[Attempt — step "null"]` because
      // summarizeFixIteration is called with stepId=null when targetStep is
      // null, so we MUST honor bestAttempt.historyMarker when present).
      if (bestAttempt.historyMarker) {
        markerStepId = null; // signal to use historyMarker directly below
      } else if (!markerStepId && snapshots[0]) {
        markerStepId = snapshots[0].id;
      }
    } else if (bestAttempt.stepId) {
      // Legacy single-step shape.
      const step = currentSteps.find(s => s && s.id === bestAttempt.stepId);
      if (!step) return null;
      stepPatches.push({
        id: bestAttempt.stepId,
        stepPatch: {
          script: bestAttempt.script,
          onSuccess: bestAttempt.onSuccess,
          onFailure: bestAttempt.onFailure,
          maxIterations: bestAttempt.maxIterations
        }
      });
    } else {
      return null;
    }

    // Truncate llmHistory at the boundary of the best attempt's user-message
    // marker. summarizeFixIteration emits "[Attempt — step \"<id>\" (\"<name>\")]".
    // The user-feedback path emits `[Attempt — step "null"]` because stepId
    // is null when no target step exists — bestAttempt.historyMarker captures
    // the exact string to match.
    const marker = bestAttempt.historyMarker
      || `[Attempt — step "${markerStepId || 'null'}"`;
    const history = Array.isArray(currentLlmHistory) ? currentLlmHistory : [];

    // Find the attemptNum-th user message whose content includes the marker (1-indexed).
    // We keep that user message + the assistant reply that follows it.
    let seen = 0;
    let boundaryIdx = -1;
    for (let i = 0; i < history.length; i++) {
      const m = history[i];
      if (m && m.role === 'user' && typeof m.content === 'string' && m.content.includes(marker)) {
        seen++;
        if (seen === bestAttempt.attemptNum) {
          boundaryIdx = i;
          break;
        }
      }
    }
    let truncatedHistory = history;
    if (boundaryIdx >= 0) {
      // Keep user msg at boundaryIdx + the following assistant reply (if any)
      truncatedHistory = history.slice(0, Math.min(boundaryIdx + 2, history.length));
    }

    return {
      stepPatches,
      truncatedHistory,
      logMessage: `Restored attempt #${bestAttempt.attemptNum} (scored ${bestAttempt.score}) — higher than last attempt.`
    };
  } catch (e) {
    try { (typeof debugLogger !== 'undefined' && debugLogger.log('warn', 'wizard-utils', 'planRestoreBestAttempt failed', { error: e.message })); } catch {}
    return null;
  }
}

// Pure: returns an HTML string for the intervention banner. Wizard.js injects it
// into #phase5 and attaches event listeners via data-action attributes.
function renderInterventionBanner(classification) {
  if (!classification || typeof classification !== 'object') return '';
  const severity = classification.severity === 'error' ? 'error'
                 : classification.severity === 'warn' ? 'warn' : 'info';
  const msg = String(classification.message || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const action = String(classification.uiAction || '');
  const actionLabel = ({
    annotate_step: 'Go to annotation',
    open_tab: 'Open target tab',
    open_settings: 'Open settings',
    refresh_tab: 'Refresh tab'
  })[action] || 'Take action';
  const actionBtn = action
    ? `<button class="intervention-action btn-primary" data-action="${action}">${actionLabel}</button>`
    : '';
  return `
<div class="intervention-banner intervention-${severity}" role="alert">
  <span class="intervention-icon">${severity === 'error' ? '✕' : '⚠'}</span>
  <span class="intervention-message">${msg}</span>
  <div class="intervention-buttons">
    ${actionBtn}
    <button class="intervention-dismiss btn-secondary" data-action="dismiss">Ignore and continue</button>
  </div>
</div>`.trim();
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

function buildRequirementsBlock(requirements) {
  const r = requirements || {};
  const inputParams = (r.inputParams || '').trim();
  const pageOps = (r.pageOps || '').trim();
  const outputStruct = (r.outputStruct || '').trim();
  return [
    '## User Requirements',
    '- Input parameters: ' + (inputParams || '(none specified)'),
    '- Page operations & data to collect: ' + (pageOps || '(unspecified)'),
    '- Output structure: ' + (outputStruct || '(unspecified — infer)')
  ].join('\n');
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseSchemaFields, buildTimeoutGuidance, estimateScriptTimeBudget, validateInputAgainstSchema, validateOutputAgainstSchema, findEmptyExtractionFields, findUpstreamExtractionStepId, detectEmptyOutputFieldsByRatio, formatEmptyOutputFieldsSignal, detectDuplicateRecords, formatDuplicateRecordsSignal, isNoOpAutoFixPatch, getOutputFieldOptions, truncateSnapshotForLLM, summarizeFixIteration, summarizeStepsGeneration, summarizeGeneratedSteps, stripSnapshotsFromTestResult, stripPagesFromLLMContext, dedupeStepIterations, formatDomActivitySummary, summarizeExecutionDiagnostics, summarizeAllStepDiagnostics, scoreAttemptResult, classifyIntervention, buildFeedbackSection, buildNoOpEscalationSection, registerNoOpForFeedback, resetNoOpEscalation, planRestoreBestAttempt, renderInterventionBanner, scoreAnnotationBrittleness, scoreAnnotationChain, buildIORenderString, validateTestInput, cleanLLMResponse, parseJsonLenient, stripJSComments, resolveAutoFixTarget, resolveAutoFixTargets, buildResearchPrompt, buildFixPrompt, validateSteps, validateForExecution, validateChain, buildStepIORenderString, getStepTemplates, applyTemplate, STEP_TEMPLATES, SCRIPT_DSL_GUIDE, appendGlobalContextBlock, buildAutoFixSystemMessage, fillEntryUrlDefaults, normalizeStepTopology, DEFAULT_POLL_MAX_ITERATIONS, appendStepWithChainLink, removeStepWithRelink, relinkChainToArray, ANNOTATION_PURPOSES, WAIT_CONDITIONS, buildAnnotationsText, checkSelectorFidelity, buildRequirementsBlock, suggestServiceName, getFirstRecordHtmlFromExecution, getFirstRecordHtmlFromAnyStep };
} else if (typeof window !== 'undefined') {
  window.buildTimeoutGuidance = buildTimeoutGuidance;
  window.estimateScriptTimeBudget = estimateScriptTimeBudget;
  window.validateInputAgainstSchema = validateInputAgainstSchema;
  window.validateOutputAgainstSchema = validateOutputAgainstSchema;
  window.findEmptyExtractionFields = findEmptyExtractionFields;
  window.findUpstreamExtractionStepId = findUpstreamExtractionStepId;
  window.getFirstRecordHtmlFromExecution = getFirstRecordHtmlFromExecution;
  window.getFirstRecordHtmlFromAnyStep = getFirstRecordHtmlFromAnyStep;
  window.detectEmptyOutputFieldsByRatio = detectEmptyOutputFieldsByRatio;
  window.formatEmptyOutputFieldsSignal = formatEmptyOutputFieldsSignal;
  window.detectDuplicateRecords = detectDuplicateRecords;
  window.formatDuplicateRecordsSignal = formatDuplicateRecordsSignal;
  window.isNoOpAutoFixPatch = isNoOpAutoFixPatch;
  window.getOutputFieldOptions = getOutputFieldOptions;
  window.truncateSnapshotForLLM = truncateSnapshotForLLM;
  window.summarizeFixIteration = summarizeFixIteration;
  window.summarizeStepsGeneration = summarizeStepsGeneration;
  window.summarizeGeneratedSteps = summarizeGeneratedSteps;
  window.stripSnapshotsFromTestResult = stripSnapshotsFromTestResult;
  window.stripPagesFromLLMContext = stripPagesFromLLMContext;
  window.dedupeStepIterations = dedupeStepIterations;
  window.formatDomActivitySummary = formatDomActivitySummary;
  window.summarizeExecutionDiagnostics = summarizeExecutionDiagnostics;
  window.summarizeAllStepDiagnostics = summarizeAllStepDiagnostics;
  window.scoreAttemptResult = scoreAttemptResult;
  window.classifyIntervention = classifyIntervention;
  window.buildFeedbackSection = buildFeedbackSection;
  window.buildNoOpEscalationSection = buildNoOpEscalationSection;
  window.registerNoOpForFeedback = registerNoOpForFeedback;
  window.resetNoOpEscalation = resetNoOpEscalation;
  window.planRestoreBestAttempt = planRestoreBestAttempt;
  window.renderInterventionBanner = renderInterventionBanner;
  window.getStepTemplates = getStepTemplates;
  window.applyTemplate = applyTemplate;
  window.STEP_TEMPLATES = STEP_TEMPLATES;
  window.SCRIPT_DSL_GUIDE = SCRIPT_DSL_GUIDE;
  window.appendGlobalContextBlock = appendGlobalContextBlock;
  window.buildAutoFixSystemMessage = buildAutoFixSystemMessage;
  window.buildRequirementsBlock = buildRequirementsBlock;
  window.suggestServiceName = suggestServiceName;
  window.fillEntryUrlDefaults = fillEntryUrlDefaults;
  window.normalizeStepTopology = normalizeStepTopology;
  window.DEFAULT_POLL_MAX_ITERATIONS = DEFAULT_POLL_MAX_ITERATIONS;
  window.validateForExecution = validateForExecution;
  window.validateChain = validateChain;
  window.appendStepWithChainLink = appendStepWithChainLink;
  window.removeStepWithRelink = removeStepWithRelink;
  window.relinkChainToArray = relinkChainToArray;
  window.ANNOTATION_PURPOSES = ANNOTATION_PURPOSES;
  window.WAIT_CONDITIONS = WAIT_CONDITIONS;
  window.buildAnnotationsText = buildAnnotationsText;
}

// Service worker has no `window` (global is `self`). Expose the same helpers
// so lib/service-registry.js can resolve validateChain when saving from the
// background context. (Top-level function declarations are already on self,
// but be explicit so this survives a future refactor to arrow-function consts.)
if (typeof self !== 'undefined' && typeof window === 'undefined') {
  self.validateChain = validateChain;
  self.validateForExecution = validateForExecution;
  self.validateInputAgainstSchema = validateInputAgainstSchema;
  self.validateOutputAgainstSchema = validateOutputAgainstSchema;
  self.findEmptyExtractionFields = findEmptyExtractionFields;
  self.findUpstreamExtractionStepId = findUpstreamExtractionStepId;
  self.getFirstRecordHtmlFromExecution = getFirstRecordHtmlFromExecution;
  self.getFirstRecordHtmlFromAnyStep = getFirstRecordHtmlFromAnyStep;
  self.detectEmptyOutputFieldsByRatio = detectEmptyOutputFieldsByRatio;
  self.formatEmptyOutputFieldsSignal = formatEmptyOutputFieldsSignal;
  self.detectDuplicateRecords = detectDuplicateRecords;
  self.formatDuplicateRecordsSignal = formatDuplicateRecordsSignal;
  self.isNoOpAutoFixPatch = isNoOpAutoFixPatch;
  self.getOutputFieldOptions = getOutputFieldOptions;
  self.truncateSnapshotForLLM = truncateSnapshotForLLM;
  self.summarizeFixIteration = summarizeFixIteration;
  self.summarizeStepsGeneration = summarizeStepsGeneration;
  self.summarizeGeneratedSteps = summarizeGeneratedSteps;
  self.stripSnapshotsFromTestResult = stripSnapshotsFromTestResult;
  self.stripPagesFromLLMContext = stripPagesFromLLMContext;
  self.dedupeStepIterations = dedupeStepIterations;
  self.formatDomActivitySummary = formatDomActivitySummary;
  self.summarizeExecutionDiagnostics = summarizeExecutionDiagnostics;
  self.summarizeAllStepDiagnostics = summarizeAllStepDiagnostics;
  self.scoreAttemptResult = scoreAttemptResult;
  self.classifyIntervention = classifyIntervention;
  self.buildFeedbackSection = buildFeedbackSection;
  self.buildNoOpEscalationSection = buildNoOpEscalationSection;
  self.registerNoOpForFeedback = registerNoOpForFeedback;
  self.resetNoOpEscalation = resetNoOpEscalation;
  self.planRestoreBestAttempt = planRestoreBestAttempt;
  self.renderInterventionBanner = renderInterventionBanner;
  self.appendStepWithChainLink = appendStepWithChainLink;
  self.removeStepWithRelink = removeStepWithRelink;
  self.relinkChainToArray = relinkChainToArray;
  self.fillEntryUrlDefaults = fillEntryUrlDefaults;
  self.normalizeStepTopology = normalizeStepTopology;
  self.DEFAULT_POLL_MAX_ITERATIONS = DEFAULT_POLL_MAX_ITERATIONS;
}
