#!/bin/zsh
# Double-clickable launcher: starts the bridge and leaves it running.
cd "$(dirname "$0")"
exec python3 xpbridge.py "$@"
