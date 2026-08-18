# Makefile for cross-platform bootstrap + dotfiles (Ubuntu + macOS)
# Usage:
#   make            # same as make help
#   make all        # full setup (link -> packages -> mise -> rest)
#   make doctor     # verify prerequisites + symlinks + key paths

SHELL := /bin/bash
.ONESHELL:
.SHELLFLAGS := -euo pipefail -c

.DEFAULT_GOAL := help

.PHONY: all help doctor link packages apt mise starship zsh ssh-github tmux nvim fonts flatpak mise-launchd macos-animations macos-animations-revert skills-update skills-shared

REPO_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
UNAME_S  := $(shell uname -s)

# macOS-only steps appended to `make all` (empty on Linux).
MAC_ONLY_STEPS :=
ifeq ($(UNAME_S),Darwin)
MAC_ONLY_STEPS += mise-launchd macos-animations
endif

help:
	@echo "Targets:"
	@echo "  make all         - link -> packages -> flatpak (Linux) -> fonts -> mise -> starship -> zsh -> tmux -> nvim"
	@echo "  make doctor      - sanity checks (recommended before all)"
	@echo "  make link        - symlink dotfiles into place"
	@echo "  make packages    - install OS packages (apt on Linux, brew bundle on macOS)"
	@echo "  make flatpak     - install flatpaks (Linux only; no-op on macOS)"
	@echo "  make fonts       - install JetBrainsMono Nerd Font (user-local)"
	@echo "  make mise        - install mise + tools (reads ~/.config/mise/config.toml)"
	@echo "  make starship    - install starship prompt"
	@echo "  make zsh         - install oh-my-zsh + plugins"
	@echo "  make ssh-github  - generate/add ssh keys via gh (interactive)"
	@echo "  make tmux        - install TPM + tmux plugins"
	@echo "  make nvim        - headless nvim plugin install/update"
	@echo "  make skills-update - update vendored agent skills in-place (.agents/) to latest upstream"
	@echo "  make skills-shared - sync the shared reviewer-registry block into the workflow scripts (claude/skills/)"
	@echo "  make mise-launchd - install LaunchAgent so GUI apps see mise shims in PATH (macOS only; no-op elsewhere)"
	@echo "  make macos-animations - disable macOS UI animations (Reduce Motion, Dock, Finder; macOS only)"
	@echo "  make macos-animations-revert - restore macOS animation defaults"
	@echo ""
	@echo "Tip: run 'make doctor' first. Detected OS: $(UNAME_S)"

# Full bootstrap
all: doctor link packages flatpak fonts mise starship zsh tmux nvim $(MAC_ONLY_STEPS)
	@echo "✅ All done. Consider rebooting if shell/fonts/drivers changed."

# ---------- Core tasks ----------
link:
	./scripts/90_link.sh

packages:
	./scripts/10_packages.sh

# Back-compat alias (old name)
apt: packages

flatpak:
	./scripts/12_flatpak.sh

fonts:
	./scripts/25_fonts.sh

mise:
	./scripts/20_mise.sh

starship:
	./scripts/30_starship.sh

zsh:
	./scripts/40_zsh.sh

ssh-github:
	./scripts/50_ssh_github.sh

tmux:
	./scripts/60_tmux.sh

nvim:
	./scripts/70_nvim.sh

mise-launchd:
	./scripts/96_mise_launchd.sh

macos-animations:
	./scripts/97_macos_animations.sh

macos-animations-revert:
	./scripts/97_macos_animations.sh --revert

# Update vendored agent skills to latest upstream. ~/.agents -> dotfiles/.agents,
# so `skills update -g` rewrites files in-place inside the repo; commit the diff.
skills-update:
	@command -v npx >/dev/null || { echo "npx not found (run: make mise)"; exit 1; }
	npx --yes skills update -g -y
	@echo "==> Updated. Review & commit changes under .agents/:"
	@git -C "$(REPO_DIR)" status --short .agents

# Copy the shared reviewer-registry block from claude/skills/_shared/ into each
# workflow script (they must be self-contained). --check mode fails on drift.
skills-shared:
	./scripts/95_skills_shared.sh

# ---------- Checks ----------
doctor:
	@echo "==> Doctor: detected OS = $(UNAME_S)"
	@echo "==> Doctor: repo layout"
	@test -d "$(REPO_DIR)/scripts" || (echo "Missing ./scripts"; exit 1)
	@test -d "$(REPO_DIR)/config"  || (echo "Missing ./config (for ~/.config symlinks)"; exit 1)
	@test -f "$(REPO_DIR)/zsh/zshrc" || (echo "Missing ./zsh/zshrc"; exit 1)
	@test -f "$(REPO_DIR)/zsh/zsh_aliases" || (echo "Missing ./zsh/zsh_aliases"; exit 1)
	@test -f "$(REPO_DIR)/zsh/plugins.txt" || (echo "Missing ./zsh/plugins.txt"; exit 1)

	@if [ "$(UNAME_S)" = "Linux" ]; then \
	  test -f "$(REPO_DIR)/apt/packages.txt" || (echo "Missing ./apt/packages.txt"; exit 1); \
	elif [ "$(UNAME_S)" = "Darwin" ]; then \
	  test -f "$(REPO_DIR)/brew/Brewfile" || (echo "Missing ./brew/Brewfile"; exit 1); \
	fi

	@echo "==> Doctor: required executables (some installed by packages/mise later)"
	@command -v bash >/dev/null
	@command -v curl >/dev/null || echo "WARN: curl not found yet (installed by make packages)"
	@command -v git  >/dev/null || echo "WARN: git not found yet (installed by make packages)"

	@echo "==> Doctor: mise config presence in repo"
	@test -f "$(REPO_DIR)/config/mise/config.toml" || (echo "Missing ./config/mise/config.toml"; exit 1)

	@echo "==> Doctor: symlink plan"
	@echo "  Will link: $(REPO_DIR)/config/* -> ~/.config/*"
	@echo "  Will link: $(REPO_DIR)/zsh/zshrc -> ~/.zshrc"
	@echo "  Will link: $(REPO_DIR)/zsh/zsh_aliases -> ~/.zsh_aliases"
	@echo "  Will link: $(REPO_DIR)/zsh/helpers.zsh -> ~/helpers.zsh"
	@echo "  Will link: $(REPO_DIR)/git/gitconfig -> ~/.gitconfig"
	@echo "  Will link: $(REPO_DIR)/git/gitconfig-work -> ~/.gitconfig-work"

	@echo "==> Doctor: after-link checks (only if you've already run make link)"
	@if [ -L "$$HOME/.config/mise" ]; then \
	  echo "  OK: ~/.config/mise is a symlink"; \
	elif [ -f "$$HOME/.config/mise/config.toml" ]; then \
	  echo "  OK: ~/.config/mise/config.toml exists (maybe not symlinked)"; \
	else \
	  echo "  NOTE: ~/.config/mise/config.toml not present yet (run: make link)"; \
	fi

	@echo "==> Doctor: SSH key paths (informational)"
	@if [ -f "$$HOME/.ssh/id_ed25519" ]; then \
	  echo "  Found: ~/.ssh/id_ed25519 (private key)"; \
	else \
	  echo "  NOTE: No ~/.ssh/id_ed25519 yet (created by make ssh-github)"; \
	fi

	@echo "✅ Doctor complete."
