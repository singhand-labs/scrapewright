// Regression for bugx.log 2026-07-24: publishTime annotations all carried
// per-post aria-label selectors (a[role="link"][aria-label="\\34 0分钟"] etc.).
// The existing SELECTOR GENERALIZATION rule correctly told the LLM to drop
// the literal value and use attribute-presence— but on FB, BOTH the author
// avatar link and the timestamp link carry aria-label, so two outputFields
// collapsed onto the same selector and publishTime ended up holding the
// author name. The fix teaches the LLM to check for and resolve collisions.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SCRIPT_DSL_GUIDE } = require('../lib/wizard-utils');

describe('SCRIPT_DSL_GUIDE — FIELD COLLISION ON GENERALIZATION', () => {
  it('contains a FIELD COLLISION section', () => {
    assert.match(SCRIPT_DSL_GUIDE, /FIELD COLLISION ON GENERALIZATION/);
  });

  it('warns that bare attribute-presence selectors cause collision', () => {
    assert.match(SCRIPT_DSL_GUIDE, /Do NOT use bare attribute-presence selectors/);
    assert.match(SCRIPT_DSL_GUIDE, /\[aria-label\]/);
  });

  it('lists href-content as a discriminator', () => {
    assert.match(SCRIPT_DSL_GUIDE, /href\*="\/user\//);
    assert.match(SCRIPT_DSL_GUIDE, /href\*="\/items\//);
  });

  it('lists ancestor-tag as a discriminator', () => {
    assert.match(SCRIPT_DSL_GUIDE, /<h3>/);
  });

  it('suggests $list comparison for verification', () => {
    assert.match(SCRIPT_DSL_GUIDE, /\$list on each candidate selector/);
  });
});
