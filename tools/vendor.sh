#!/usr/bin/env bash
# vendor.sh <project-dir> — vendor pristine upstream Throughliner plugin content
# into <project-dir>/vendor/throughliner/ and write a sha256 identity manifest.
# Re-run any time; exits non-zero on any drift from the pinned upstream SHA.
set -euo pipefail

PROJ="${1:?usage: vendor.sh <project-dir>}"
UPSTREAM="${2:-/tmp/throughliner-upstream}"
PIN="743aa63166ce4875305c7d97041a1b462b0fdc2c"

head=$(git -C "$UPSTREAM" rev-parse HEAD)
if [[ "$head" != "$PIN" ]]; then
  echo "ERROR: upstream HEAD is $head, pinned $PIN" >&2
  exit 1
fi

SRC="$UPSTREAM/plugin/throughliner"
DEST="$PROJ/vendor/throughliner"

mkdir -p "$DEST"
# copy the pristine plugin tree, nothing else. __pycache__ is excluded: a
# bytecode file generated on the vendoring machine would be an unmanifested
# extra inside the "byte-identical" tree, and the manifest below must match
# the copy exactly.
(cd "$SRC" && find . -type f ! -path '*/__pycache__/*' ! -name '*.pyc' | sed 's|^\./||' | while IFS= read -r f; do
  mkdir -p "$DEST/$(dirname "$f")"
  cp -- "$SRC/$f" "$DEST/$f"
done)

# manifest: relative path + sha256, sorted
( cd "$DEST" && find . -type f ! -path '*/__pycache__/*' ! -name '*.pyc' | sed 's|^\./||' | sort | xargs sha256sum ) > "$PROJ/vendor/MANIFEST.sha256"

# verify
( cd "$DEST" && sha256sum -c "$PROJ/vendor/MANIFEST.sha256" --quiet )
n=$(wc -l < "$PROJ/vendor/MANIFEST.sha256")
echo "vendored $n files, identity verified against $PIN"
