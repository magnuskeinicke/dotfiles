#!/usr/bin/env bash
# Kill macOS UI animations that add perceived latency to window-manager
# navigation. Idempotent and reversible (see REVERT section at bottom).
#
# Run:        ./scripts/97_macos_animations.sh
# Revert:     ./scripts/97_macos_animations.sh --revert
#
# Side effects: relaunches Dock and Finder so changes take effect.

set -euo pipefail

[ "$(uname -s)" = "Darwin" ] || { echo "macOS only — skipping."; exit 0; }

if [ "${1:-}" = "--revert" ]; then
  echo "==> Reverting macOS animation tweaks"
  defaults delete com.apple.universalaccess reduceMotion 2>/dev/null || true
  defaults delete -g NSAutomaticWindowAnimationsEnabled 2>/dev/null || true
  defaults delete -g NSWindowResizeTime 2>/dev/null || true
  defaults delete -g NSScrollAnimationEnabled 2>/dev/null || true
  defaults delete -g NSToolbarFullScreenAnimationDuration 2>/dev/null || true
  defaults delete -g QLPanelAnimationDuration 2>/dev/null || true
  defaults delete com.apple.dock launchanim 2>/dev/null || true
  defaults delete com.apple.dock expose-animation-duration 2>/dev/null || true
  defaults delete com.apple.dock workspaces-edge-delay 2>/dev/null || true
  defaults delete com.apple.dock springboard-show-duration 2>/dev/null || true
  defaults delete com.apple.dock springboard-hide-duration 2>/dev/null || true
  defaults delete com.apple.dock springboard-page-duration 2>/dev/null || true
  defaults delete com.apple.dock autohide-time-modifier 2>/dev/null || true
  defaults delete com.apple.dock autohide-delay 2>/dev/null || true
  defaults delete com.apple.finder DisableAllAnimations 2>/dev/null || true
  defaults delete com.apple.WindowManager EnableStandardClickToShowDesktop 2>/dev/null || true
  killall Dock Finder WindowManager 2>/dev/null || true
  echo "✅ Reverted. Some changes only take effect after logout."
  exit 0
fi

echo "==> Disabling macOS animations"

# Master switch — Accessibility "Reduce Motion". Kills space switch
# slide, Mission Control zoom, and most window-server animations.
defaults write com.apple.universalaccess reduceMotion -bool true

# AppKit window open/close, sheets, dialogs.
defaults write -g NSAutomaticWindowAnimationsEnabled -bool false
defaults write -g NSWindowResizeTime -float 0.001

# Scroll animations (smooth-scroll easing).
defaults write -g NSScrollAnimationEnabled -bool false

# Fullscreen toolbar slide-in / Quick Look pop.
defaults write -g NSToolbarFullScreenAnimationDuration -float 0
defaults write -g QLPanelAnimationDuration -float 0

# Dock: app launch bounce, Mission Control / App Exposé, space switch
# edge delay, Launchpad show/hide/page.
defaults write com.apple.dock launchanim -bool false
defaults write com.apple.dock expose-animation-duration -float 0.1
defaults write com.apple.dock workspaces-edge-delay -float 0
defaults write com.apple.dock springboard-show-duration -float 0
defaults write com.apple.dock springboard-hide-duration -float 0
defaults write com.apple.dock springboard-page-duration -float 0
defaults write com.apple.dock autohide-time-modifier -float 0
defaults write com.apple.dock autohide-delay -float 0

# Finder operations.
defaults write com.apple.finder DisableAllAnimations -bool true

# Sequoia: "Click wallpaper to reveal desktop" — clicking an empty area
# triggers a distracting zoom-out-and-show-desktop. Disable so focus stays
# put when interacting with empty workspaces.
defaults write com.apple.WindowManager EnableStandardClickToShowDesktop -bool false

echo "==> Relaunching Dock, Finder, WindowManager"
killall Dock 2>/dev/null || true
killall Finder 2>/dev/null || true
killall WindowManager 2>/dev/null || true

echo "✅ Done. A full logout may be needed for reduceMotion to fully apply."
