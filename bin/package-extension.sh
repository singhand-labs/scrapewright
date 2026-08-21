#!/usr/bin/env bash
# Package the Chrome extension into a Chrome Web Store-ready zip.
# The zip root must contain manifest.json, so we stage a pruned copy first:
# dev-only files (test/, docs/, *.test.js) never enter the archive.
# Every path the manifest references is validated against the staged copy,
# so a packaging mistake fails here instead of in the CWS upload UI.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$DIR/extension"
BUILD_DIR="$DIR/build"

command -v zip >/dev/null 2>&1 || { echo "error: 'zip' is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "error: node is required" >&2; exit 1; }

VERSION="$(node -p "require('$EXT_DIR/manifest.json').version")"
if [[ ! "$VERSION" =~ ^[0-9]+(\.[0-9]+){0,3}$ ]]; then
  echo "error: invalid manifest version '$VERSION' (CWS wants 1-4 dot-separated integers)" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp -R "$EXT_DIR/." "$STAGE/"
rm -rf "$STAGE/test" "$STAGE/docs"
find "$STAGE" -name '*.test.js' -delete
find "$STAGE" -name '.DS_Store' -delete

node - "$STAGE" <<'EOF'
const [stage] = process.argv.slice(2);
const fs = require('fs'), path = require('path');
const m = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8'));
const refs = [];
if (m.background && m.background.service_worker) refs.push(m.background.service_worker);
if (m.options_page) refs.push(m.options_page);
if (m.action && m.action.default_popup) refs.push(m.action.default_popup);
for (const p of (m.sandbox && m.sandbox.pages) || []) refs.push(p);
for (const cs of m.content_scripts || []) for (const js of cs.js || []) refs.push(js);
const icons = Object.assign({}, m.icons, (m.action && m.action.default_icon) || {});
for (const icon of Object.values(icons)) refs.push(icon);
for (const r of m.web_accessible_resources || []) {
  for (const res of r.resources || [r]) refs.push(res);
}
const missing = refs.filter(r => !fs.existsSync(path.join(stage, r)));
if (missing.length) {
  console.error('error: manifest references files missing from the staged copy:');
  for (const r of missing) console.error('  ' + r);
  process.exit(1);
}
console.log('ok: all ' + refs.length + ' manifest-referenced files present');
EOF

mkdir -p "$BUILD_DIR"
OUT="$BUILD_DIR/scrapewright-$VERSION.zip"
rm -f "$OUT"
(cd "$STAGE" && zip -qr "$OUT" .)

FILES="$(unzip -Z1 "$OUT" | grep -vc '/$')"
echo "packaged: $OUT ($(du -h "$OUT" | cut -f1), $FILES files, version $VERSION)"
echo "reminder: CWS rejects version reuse — bump manifest.json version before re-uploading."
