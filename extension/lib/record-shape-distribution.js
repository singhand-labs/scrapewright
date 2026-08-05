// extension/lib/record-shape-distribution.js
//
// Empirical shape-distribution analysis for extracted records. Pure module
// — no DOM access, no IO. Called by autoFix prompt builders to surface
// ACTUAL shape variance observed in the extracted output (vs. relying on
// user annotation of every shape).
//
// Design intent (per 2026-08-05 architectural pivot): the system should
// detect shape diversity from REAL extraction results — not depend on the
// user having annotated every variant. Records extracted by the LLM's own
// script carry the empirical ground truth of "what shapes actually exist
// in this feed." When the framework observes 2+ distinct field-population
// signatures across the extracted records, that signal is fed back to the
// LLM so it can write genuine shape-switching logic instead of guessing
// from URL patterns.

// Walk a record recursively and emit dotted paths for populated fields.
// Empty string, null, undefined, empty array, empty object → unpopulated.
// false and 0 → populated (they are valid values, distinct from "absent").
// Arrays are treated as a single field value — element structure is not
// part of the signature (different array lengths would otherwise split
// records that have the same shape).
function computeFieldSignature(record, prefix) {
  if (record == null || typeof record !== 'object') return [];
  const prefixStr = prefix ? prefix + '.' : '';
  const out = [];
  for (const key of Object.keys(record)) {
    const v = record[key];
    const path = prefixStr + key;
    if (v == null || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      out.push(path);
      continue;
    }
    if (typeof v === 'object') {
      const nested = computeFieldSignature(v, path);
      if (nested.length === 0) continue;
      out.push(...nested);
      continue;
    }
    out.push(path);
  }
  return out;
}

// Group records by their sorted field-population signature. Returns one
// cluster per distinct signature, sorted by count descending so SHAPE A
// is always the most common.
function clusterRecordsByShape(records, options) {
  const opts = options || {};
  const minRecords = opts.minRecords != null ? opts.minRecords : 2;
  if (!Array.isArray(records) || records.length < minRecords) {
    return { shapes: [], totalRecords: Array.isArray(records) ? records.length : 0 };
  }
  const groups = new Map();
  for (const r of records) {
    const sig = computeFieldSignature(r).sort();
    const key = sig.join(',');
    if (!groups.has(key)) groups.set(key, { signature: sig, records: [] });
    groups.get(key).records.push(r);
  }
  const shapes = Array.from(groups.values())
    .map((g, i) => ({
      id: String.fromCharCode(65 + i),
      count: g.records.length,
      signature: g.signature,
      sample: g.records[0],
    }))
    .sort((a, b) => b.count - a.count);
  // Re-assign IDs A, B, C... after sort so SHAPE A is the most populous.
  shapes.forEach((s, i) => { s.id = String.fromCharCode(65 + i); });
  return { shapes, totalRecords: records.length };
}

// Format the shape distribution block for the LLM. Returns empty string
// when there's nothing useful to say (fewer than minRecords, or all records
// share a single signature). Otherwise emits a RECORD SHAPE DISTRIBUTION
// block with per-shape signatures and an OBSERVATION line classifying
// fields as appearing in ALL shapes vs SOME shapes.
function formatShapeDistribution(records, options) {
  const { shapes, totalRecords } = clusterRecordsByShape(records, options);
  if (shapes.length < 2) return '';

  const lines = [];
  lines.push(`RECORD SHAPE DISTRIBUTION (${totalRecords} records sampled, ${shapes.length} distinct shapes detected):`);
  for (const s of shapes) {
    const noun = s.count === 1 ? 'record' : 'records';
    const sig = s.signature.length > 0 ? s.signature.join(', ') : '(no populated fields)';
    lines.push(`  SHAPE ${s.id} (${s.count} ${noun}): ${sig}`);
  }

  // Cross-shape observation: which fields are universal vs shape-dependent.
  const sigSets = shapes.map(s => new Set(s.signature));
  const universal = sigSets.reduce((acc, set) => {
    const next = new Set();
    for (const x of acc) if (set.has(x)) next.add(x);
    return next;
  });
  const union = new Set();
  for (const set of sigSets) for (const x of set) union.add(x);
  const shapeDependent = [];
  for (const x of union) if (!universal.has(x)) shapeDependent.push(x);

  if (universal.size > 0) {
    const uniList = Array.from(universal).sort().join(', ');
    lines.push(`OBSERVATION: fields appearing in ALL shapes: ${uniList}.`);
  }
  if (shapeDependent.length > 0) {
    const depList = shapeDependent.sort().join(', ');
    lines.push(`OBSERVATION: fields appearing in SOME shapes only: ${depList}.`);
    lines.push(`IMPLICATION: the SOME-shapes fields indicate distinct entity types in the same list. Write shape-switching logic (e.g., conditional population based on which marker field is present) rather than a single flat extractor that conflates them.`);
  }

  return lines.join('\n');
}

// Schema-aware wrapper: locates the FIRST array-of-objects field declared in
// outputSchema and emits its shape-distribution block. Returns empty string
// when no array field exists, the array has too few records, or all records
// share a single shape. Mirrors detectEmptyOutputFieldsByRatio's lookup so
// the two signals stay in sync about which array is "the records."
function formatShapeDistributionFromData(data, outputSchema, options) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '';
  if (!outputSchema || typeof outputSchema !== 'object') return '';
  const props = outputSchema.properties && typeof outputSchema.properties === 'object'
    ? outputSchema.properties
    : {};
  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (!prop || prop.type !== 'array' || !prop.items || prop.items.type !== 'object') continue;
    const arr = data[key];
    if (!Array.isArray(arr) || arr.length < 2) continue;
    const block = formatShapeDistribution(arr, options);
    if (block) {
      return `Record collection: ${key}\n${block}`;
    }
  }
  return '';
}

const api = { computeFieldSignature, clusterRecordsByShape, formatShapeDistribution, formatShapeDistributionFromData };

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.RecordShapeDistribution = api;
if (typeof self !== 'undefined') self.RecordShapeDistribution = api;
if (typeof global !== 'undefined') {
  global.computeFieldSignature = computeFieldSignature;
  global.clusterRecordsByShape = clusterRecordsByShape;
  global.formatShapeDistribution = formatShapeDistribution;
  global.formatShapeDistributionFromData = formatShapeDistributionFromData;
  global.RecordShapeDistribution = api;
}
