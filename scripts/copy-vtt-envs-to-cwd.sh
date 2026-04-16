#!/usr/bin/env bash
set -euo pipefail

src_repo="${1:-$HOME/Documents/Work/voice-to-text}"
dest_dir="${2:-$PWD}"

if [ ! -d "$src_repo" ]; then
  echo "source repo not found: $src_repo" >&2
  exit 1
fi

if [ ! -d "$dest_dir" ]; then
  echo "destination directory not found: $dest_dir" >&2
  exit 1
fi

if ! command -v rsync >/dev/null 2>&1; then
  echo "rsync is required but not installed" >&2
  exit 1
fi

# Copy only files named exactly '.env' recursively, preserving relative paths.
rsync -a --prune-empty-dirs \
  --include='*/' \
  --include='.env' \
  --exclude='*' \
  "$src_repo"/ "$dest_dir"/

echo "Copied .env files from '$src_repo' to '$dest_dir'"
