'use strict';
// Shared production-shaped verify fixtures — the regression lock for the
// shape-mismatch class that struck THREE times (RC30 lib-load, 87th-round
// script order, 89th-round dossier feed: session-tools passes the
// {events, report, raw, at} WRAPPER while evidence-dossier read
// report-shaped keys and rendered "(no verify run yet)" in every production
// session while tests fed report shapes directly and stayed green).
// Every test that needs a verify report MUST build it from here — never
// hand-roll the shape again.

function buildVerifyReport(overrides) {
  const report = {
    ok: false,
    executedArtifactVersion: 7,
    aborted: false,
    error: {
      message: 'TIME_SOURCE_UNEXERCISED: posts.postTime carries page-visible labels (relative/partial; sample "August 23 at 8:11 PM") but the contract source is the hover tooltip, and no tooltip evidence exists in this run or the session record: call probe.timestamp({containerSel}) once',
      stepId: null
    },
    score: { score: 154.45, isData: true, breakdown: { requiredCoverage: 1, listItemCount: 5, avgFieldsPerItem: 0.72 } },
    scoreNote: 'step selector(s) reference ad/sponsored markers. Check the POLARITY against the requirement — long prose that consumes receipt budget without changing decisions.',
    schemaOk: true,
    schemaMissing: [],
    detectors: {
      emptyFields: [],
      duplicateFields: [],
      duplicateEntities: null,
      countShortfall: null,
      relativeTimestamps: [
        { field: 'postTime', path: 'posts.postTime', sampleValue: 'August 23 at 8:11 PM', relativeCount: 1, partialAbsoluteCount: 4, partialSample: 'August 2', totalRecords: 5, note: 'rebind to the datetime attribute / labelledby reference / hovercard' }
      ],
      shapeDistribution: 'Record collection with two signatures: 3 records carry mediaUrls + hoverCards, 2 are text-only… (prose, elide-first)',
      partialEmptyFields: [
        { field: 'location', path: 'posts.location', emptyCount: 5, totalCount: 5, emptyRatio: 1, sampleNonEmpty: '', emptyRecordSamples: [{ index: 1, hint: '香織さん#街角ダンス' }, { index: 2, hint: '關曉彤黑色系造型' }] }
      ],
      timeSourceUnexercised: [
        { field: 'postTime', path: 'posts.postTime', sampleValue: 'August 23 at 8:11 PM', relativeCount: 1, partialAbsoluteCount: 4, tier: 'captured-no-date' }
      ],
      duplicateIdValues: [
        { path: 'posts.postId', field: 'postId', value: 'UzpfSVNDOjI1NTM1NjM1MTg0NzkyMjM=', count: 2, totalRecords: 5, indices: [2, 5] }
      ],
      unusedCaptures: { totalCaptured: 6, popoverReadFields: 0, samples: ['G-Girls Page · 7.1K Followers'], note: 'hover popovers captured but no field consumes them' }
    },
    events: ['RELATIVE_TIMESTAMP', 'TIME_SOURCE_UNEXERCISED', 'DUPLICATE_ID_VALUES', 'CARD_POLICY', 'PARTIAL_EMPTY_FIELDS'],
    wallCostMs: 112389,
    wallBudgetRemainingMs: 542629,
    medianVerifyCostMs: 109796,
    finalResult: { posts: [
      { index: 1, postId: '61583044052486', postTime: 'August 23 at 8:11 PM', content: '香織さん#街角ダンス', mediaUrls: [], likes: '1598' },
      { index: 2, postId: '', postTime: '', content: '關曉彤黑色系造型真的太有氣場了', mediaUrls: ['https://cdn.example/x.jpg'], likes: '42' }
    ] }
  };
  if (overrides && typeof overrides === 'object') {
    for (const k of Object.keys(overrides)) report[k] = overrides[k];
  }
  return report;
}

// The PRODUCTION wrapper: what session-tools' verifyRun stores in lastVerify
// and what getLastVerify() returns ({events, report, raw, at}).
function buildVerifyReportEnvelope(overrides, envelopeOverrides) {
  const env = {
    events: ['EXECUTION_START', 'STEP_ITERATION'],
    report: buildVerifyReport(overrides),
    raw: { testResult: { steps: [] } },
    at: 1789806850169
  };
  if (envelopeOverrides && typeof envelopeOverrides === 'object') {
    for (const k of Object.keys(envelopeOverrides)) env[k] = envelopeOverrides[k];
  }
  return env;
}

module.exports = { buildVerifyReport, buildVerifyReportEnvelope };
