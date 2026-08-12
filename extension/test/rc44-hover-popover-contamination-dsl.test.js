// RC44 audit: HOVER ENRICHMENT teaches popover contamination from prior $click.
//
// TWELFTH hover-family incident. console.log 2026-08-12 (post-RC43) showed
// RC43's three gates (hasContent + differsFromBaseline + stable) didn't
// resolve the symptom in cases where:
//   - Step 3 ($clickInList with bare 'div[role="button"]') opened a post
//     action menu (3-dot button clicked) which stayed open
//   - Step 5 ($hover) ran with the menu visible
//   - popoverSelector 'div[role="dialog"]' didn't match the menu (role=menu)
//     so path (a) explicit-match never fired
//   - Path (b) auto_discover picked the menu because its outerHTML differed
//     from baseline (animation drift between T0 and T1)
//   - The menu had posAbsolute + large area covering the cursor, winning the
//     scoring cascade
//
// User explicit feedback (line 2342 of console.log):
//   "不要点击帖子右上角的三个点的图标，不需要'收藏帖子'那个悬浮窗。
//    注意一个帖子可能有关联小组和多个账号，注意关联对齐。"
//
// Translation: don't click the 3-dot icon at the post's top-right, don't
// need the "Save Post" hovercard. Note a post may have associated groups
// and multiple accounts; align associations correctly.
//
// Decision: don't modify domHover this round. Instead, teach the LLM via
// HOVER ENRICHMENT about (1) the contamination risk from prior $click
// steps that open unrelated popovers, and (2) the importance of specific
// button selectors in $clickInList to avoid opening action menus.
//
// Source-text audit pattern: HOVER ENRICHMENT lives in lib/wizard-utils.js
// inside the SCRIPT_DSL_GUIDE string. Verify the guidance exists by
// grepping the source for the diagnostic markers.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function sliceHoverSection(src) {
  const start = src.indexOf('HOVER ENRICHMENT (hovercard');
  const end = src.indexOf('ROBUSTNESS RULES', start);
  assert.ok(start > -1 && end > start, 'HOVER ENRICHMENT section must exist');
  return src.slice(start, end);
}

describe('RC44: HOVER ENRICHMENT teaches popover contamination from prior $click', () => {
  it('documents that auto_discovery picks ANY visible popover when popoverSelector misses', () => {
    // Without this warning, the LLM may assume auto_discovery only picks
    // hover-related popovers. In reality it picks whatever scores best
    // among visible posAbsolute elements — including unrelated open menus.
    const section = sliceHoverSection(readSrc('lib/wizard-utils.js'));
    assert.ok(/auto-discover|auto_discover/i.test(section),
      'HOVER ENRICHMENT must mention auto-discovery picking visible popovers when popoverSelector misses.');
  });

  it('warns that open popovers from prior $click steps contaminate hover results', () => {
    // The key insight: popovers don't auto-close between steps. A menu
    // opened in step N stays open in step N+1, where it gets picked by
    // step N+1's hover auto-discovery. The LLM must learn this.
    const section = sliceHoverSection(readSrc('lib/wizard-utils.js'));
    // Look for the contamination warning markers.
    assert.ok(/contamination|contaminat/i.test(section) ||
      (/prior/i.test(section) && /click/i.test(section) && /popover/i.test(section)),
      'HOVER ENRICHMENT must warn that popovers opened by prior $click steps contaminate subsequent hover results.');
  });

  it('teaches specific $clickInList button selectors over bare div[role="button"]', () => {
    // The direct prevention: be specific about which buttons to click.
    // Bare 'div[role="button"]' matches every button — including 3-dot
    // action menus that open context menus. Specific selectors targeting
    // aria-label (e.g., "see more", "expand") avoid this.
    const section = sliceHoverSection(readSrc('lib/wizard-utils.js'));
    // Must mention $clickInList or $click by name in the contamination context.
    assert.ok(/\$clickInList|\$click\b/.test(section),
      'HOVER ENRICHMENT must mention $clickInList / $click in the contamination rule context.');
    // Must explicitly call out bare 'div[role="button"]' as risky.
    assert.ok(/div\[role=.?button/i.test(section),
      'HOVER ENRICHMENT must explicitly warn about bare div[role="button"] selectors in click operations.');
  });
});
