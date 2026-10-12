#!/usr/bin/env bash
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
export PIP_DISABLE_PIP_VERSION_CHECK=1

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
runtime_dir="${XDG_CACHE_HOME:-$HOME/.cache}/mediahub/facebook-session-venv"
if [[ ! -x "$runtime_dir/bin/python" ]]; then
  python3 -m venv "$runtime_dir"
fi
requirements="$script_dir/chrome-session-requirements.txt"
if ! cmp -s "$requirements" "$runtime_dir/mediahub-requirements.txt"; then
  "$runtime_dir/bin/python" -m pip install --quiet -r "$requirements"
  cp "$requirements" "$runtime_dir/mediahub-requirements.txt"
fi
exec "$runtime_dir/bin/python" "$script_dir/import_chrome_session.py" "$@"
