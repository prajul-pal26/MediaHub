#!/bin/bash
# Delegates to the root start.sh — kept for backwards compatibility.
# Usage: bash scripts/start.sh [--reset]

cd "$(dirname "$0")/.."
exec bash start.sh "$@"
