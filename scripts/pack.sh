#!/usr/bin/env bash
# Build the extensions.gnome.org upload zip.
#
# Usage: scripts/pack.sh [version-name]
# Writes <uuid>.shell-extension.zip to the repo root. If a version name is
# given (e.g. 1.2.0), it is set as "version-name" in the packed metadata.json.
set -euo pipefail

cd "$(dirname "$0")/.."

uuid=$(jq -r .uuid metadata.json)
out="$PWD/$uuid.shell-extension.zip"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

cp extension.js prefs.js stylesheet.css LICENSE "$stage/"
cp -r lib "$stage/"
mkdir -p "$stage/data" "$stage/schemas"
cp data/co2.svg data/country_intensity.json "$stage/data/"
# GNOME 44+ compiles schemas itself; EGO review asks for the XML only.
cp schemas/*.gschema.xml "$stage/schemas/"

if [[ -n "${1:-}" ]]; then
    jq --arg v "$1" '.["version-name"] = $v' metadata.json > "$stage/metadata.json"
else
    cp metadata.json "$stage/metadata.json"
fi

rm -f "$out"
(cd "$stage" && zip -qr "$out" .)
echo "$out"
