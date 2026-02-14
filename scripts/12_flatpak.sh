#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Files (either can be missing; script handles that)
LIST_FLATHUB="$REPO_DIR/flatpak/packages.txt"

ensure_flatpak() {
  if ! command -v flatpak >/dev/null 2>&1; then
    echo "Flatpak not found. Installing..."
    sudo apt-get update
    sudo apt-get install -y flatpak
  fi
}

ensure_flathub_remote() {
  if ! flatpak remote-list --columns=name 2>/dev/null | awk '{print $1}' | grep -qx flathub; then
    echo "Adding Flathub remote..."
    flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
  fi
}

install_list() {
  local file="$1"
  [[ -f "$file" ]] || return 0

  echo "Installing Flatpaks from: $file"
  # Remove comments/blank lines, install one-by-one (idempotent)
  while IFS= read -r app; do
    app="${app%%#*}"
    app="$(echo "$app" | xargs)"
    [[ -z "$app" ]] && continue

    # If already installed, skip
    if flatpak info "$app" >/dev/null 2>&1; then
      echo "  ✅ already installed: $app"
    else
      echo "  ➕ installing: $app"
      flatpak install -y flathub "$app"
    fi
  done <"$file"
}

ensure_flatpak
ensure_flathub_remote

install_list "$LIST_FLATHUB"

echo "✅ Flatpak install complete"
