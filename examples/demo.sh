#!/usr/bin/env bash
set -e

# demo.sh — end-to-end walkthrough of the grasp CLI against fixtures/sample.
# Run from anywhere; paths below are resolved relative to this script's location.
#
# `grasp ask` / `grasp pack` / `grasp outline` operate on `process.cwd()` (only
# `grasp index` takes an explicit repo path), so this script cd's into the
# fixture repo before running those commands.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GRASP="node $ROOT_DIR/bin/grasp.js"
SAMPLE="$ROOT_DIR/fixtures/sample"

echo "== Indexing $SAMPLE =="
$GRASP index "$SAMPLE"

cd "$SAMPLE"

echo
echo "== grasp ask \"login\" =="
$GRASP ask "login"

echo
echo "== grasp pack \"user database\" --budget 400 =="
$GRASP pack "user database" --budget 400

echo
echo "== grasp outline =="
$GRASP outline
