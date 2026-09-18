'use strict';
// Seventy-sixth log follow-ups: the relative-timestamp exit ladder must
// teach the DISCLOSED RELATIVE SHIP, not just hunt-or-renegotiate.
// The 76th session read "never ship relative ages" as the whole lesson,
// ground 36 snippets + 5 reds on a population PROVEN relative-only, and
// shipped postTime 5/5 empty unverified. RELATIVE_TIMESTAMP is REPORT-ONLY:
// a disclosed relative value is a legitimate green ship; an empty required
// field never passes.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const libDir = path.join(__dirname, '..', 'lib');

function readLib(name) {
  return fs.readFileSync(path.join(libDir, name), 'utf8');
}

const FORBIDDEN = /facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i;

const knowledgeUnits = readLib('knowledge-units.js');
const researchSession = readLib('research-session.js');
const probeTools = readLib('probe-tools.js');

function unitBody(id) {
  const idx = knowledgeUnits.indexOf(`id: '${id}'`);
  assert.ok(idx >= 0, `knowledge unit ${id} exists`);
  const end = knowledgeUnits.indexOf('\n    }', idx);
  return knowledgeUnits.slice(idx, end);
}

test('seventy-sixth: relative-timestamp-rebind teaches all three exits', () => {
  const body = unitBody('relative-timestamp-rebind');
  // Exit 1: bounded absolute hunt
  assert.match(body, /BOUNDED absolute-source hunt/i);
  assert.match(body, /probe\.timestamp/);
  // Exit 2: disclosed relative ship — report-only
  assert.match(body, /REPORT-ONLY|report-only/);
  assert.match(body, /disclos/);
  assert.match(body, /SHIP THE RELATIVE AGE WITH DISCLOSURE|empty required field/);
  // Exit 3: renegotiate via io.confirm
  assert.match(body, /io\.confirm/);
  // The empty-required dead-end teaching
  assert.match(body, /empty REQUIRED time field has NO other exit/);
  // Month-day partial sentence kept intact
  assert.match(body, /Month-day values WITHOUT a year/);
});

test('seventy-sixth: research-session finish ladder names the ship exit', () => {
  const first = researchSession.indexOf('[VERIFY RELATIVE-TIMESTAMPS');
  const idx = researchSession.indexOf('[VERIFY RELATIVE-TIMESTAMPS', first + 1);
  assert.ok(idx >= 0, 'ladder entry (finish disclosure, second occurrence) exists');
  const entry = researchSession.slice(idx, researchSession.indexOf(']', idx) + 1);
  assert.match(entry, /SHIP the relative age with disclosure/i);
  assert.match(entry, /report-only/i);
  assert.match(entry, /io\.confirm/);
});

test('seventy-sixth: probe.timestamp only-relative note names the ship exit', () => {
  const idx = probeTools.indexOf('only RELATIVE ages are date-shaped here');
  assert.ok(idx >= 0, 'only-relative note exists');
  const note = probeTools.slice(idx, idx + 900);
  assert.match(note, /bind the relative age itself with a finish disclosure/);
  assert.match(note, /report-only/i);
  assert.match(note, /empty required field is worse than a disclosed relative value/);
});

test('seventy-sixth: no site tokens in the three changed teaching surfaces', () => {
  const body = unitBody('relative-timestamp-rebind');
  const first = researchSession.indexOf('[VERIFY RELATIVE-TIMESTAMPS');
  const idx = researchSession.indexOf('[VERIFY RELATIVE-TIMESTAMPS', first + 1);
  const entry = researchSession.slice(idx, researchSession.indexOf(']', idx) + 1);
  const noteIdx = probeTools.indexOf('only RELATIVE ages are date-shaped here');
  const note = probeTools.slice(noteIdx, probeTools.indexOf('\n', noteIdx));
  for (const [name, text] of [['knowledge unit', body], ['ladder entry', entry], ['probe note', note]]) {
    assert.doesNotMatch(text, FORBIDDEN, `${name} must not carry site tokens`);
  }
});
