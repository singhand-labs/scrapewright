// Twenty-third log: seven service.update iterations failed to fix
// postedTime/location ("" in 5/5 records) because the step script guarded
// every read with `if (!(await $exists(sel))) return null`. $exists is the
// ONLY $ primitive gated on visibility; the target (an aria-labelledby
// tooltip span) was hidden-but-readable, so the guard read it as "absent"
// and the model chased a wrong race hypothesis to budget exhaustion. The
// guide's $exists entry described the visibility semantics but never taught
// the trap: reads are NOT visibility-gated, so a $exists guard on a read is
// a silent-empty generator.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SCRIPT_DSL_GUIDE } = require('../lib/wizard-utils');

describe('SCRIPT_DSL_GUIDE — $exists visibility trap (twenty-third log)', () => {
  it('has a dedicated rule naming $exists as visibility-gated and reads as not', () => {
    assert.match(SCRIPT_DSL_GUIDE, /\$EXISTS IS VISIBILITY-GATED, READS ARE NOT/);
  });

  it('the rule names the guard idiom as the failure shape', () => {
    assert.match(SCRIPT_DSL_GUIDE, /if\s*\(!\(await \$exists\(/);
  });

  it('the rule names the diagnostics fingerprints the framework now emits', () => {
    assert.match(SCRIPT_DSL_GUIDE, /matchedButInvisible/);
    assert.match(SCRIPT_DSL_GUIDE, /invisibleCount/);
  });

  it('the rule teaches the cheap immediate check (default poll burns 5s per false)', () => {
    assert.match(SCRIPT_DSL_GUIDE, /timeoutMs=0|timeoutMs: 0/);
  });
});
