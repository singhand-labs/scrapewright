'use strict';

// Flags that lift Chrome's renderer / timer / occlusion throttling. Applied
// to the user's Chrome launch config (B-1: native launcher modification).
//
// Detection-risk trade-off (user-stated priority):
//   Lowest detection risk of the three Plan B variants — no CDP traces, no
//   fingerprint/cookie inconsistency, no separate browser instance. Just
//   process-level flags that affect how Chrome schedules work.
//
// Operational trade-off:
//   These flags affect ALL Chrome windows/tabs while Chrome is running. CPU
//   and battery cost on every tab (background timers keep running at full
//   priority, occluded windows keep rendering). Intended for scraping-heavy
//   workflows; turn off when not needed via `scrapewright throttle off`.

const FLAGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion'
];

const MARKER = '# scrapewright-throttle-flags';

function flagsString() {
  return FLAGS.join(' ');
}

function hasFlagsInExec(line) {
  return FLAGS.every(f => line.includes(f));
}

function addFlagsToExec(line) {
  const m = line.match(/^(\s*Exec=\S+)(.*)$/);
  if (!m) return line;
  const tail = m[2];
  const missing = FLAGS.filter(f => !tail.includes(f));
  if (missing.length === 0) return line;
  return m[1] + ' ' + missing.join(' ') + tail;
}

function stripFlagsFromExec(line) {
  let out = line;
  for (const f of FLAGS) {
    out = out.replace(new RegExp('\\s+' + f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '');
  }
  return out;
}

module.exports = {
  FLAGS,
  MARKER,
  flagsString,
  hasFlagsInExec,
  addFlagsToExec,
  stripFlagsFromExec
};
