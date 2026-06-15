#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p "$HOME/.config"

echo "Linking ~/.config/* from dotfiles/config/ ..."
for path in "$REPO_DIR/config/"*; do
  [ -e "$path" ] || continue
  name="$(basename "$path")"
  rm -rf "$HOME/.config/$name" && ln -sfn "$path" "$HOME/.config/$name"
done

# Per-OS Ghostty overlay: point `config/ghostty/config-os` at the right
# platform-specific file. The main Ghostty config has `config-file = config-os`.
case "$(uname -s)" in
  Darwin) ghostty_overlay="config-darwin" ;;
  Linux)  ghostty_overlay="config-linux"  ;;
  *)      ghostty_overlay="" ;;
esac
if [ -n "$ghostty_overlay" ] \
   && [ -f "$REPO_DIR/config/ghostty/$ghostty_overlay" ]; then
  ln -sfn "$ghostty_overlay" "$REPO_DIR/config/ghostty/config-os"
fi

echo "Linking home dotfiles..."
ln -sf "$REPO_DIR/zsh/zshrc" "$HOME/.zshrc"
ln -sf "$REPO_DIR/zsh/zsh_aliases" "$HOME/.zsh_aliases"
ln -sf "$REPO_DIR/zsh/helpers.zsh" "$HOME/helpers.zsh"
ln -sf "$REPO_DIR/git/gitconfig" "$HOME/.gitconfig"
ln -sf "$REPO_DIR/git/gitconfig-work" "$HOME/.gitconfig-work"

# Link every file under dotfiles/claude/ into ~/.claude/, preserving structure.
# Leaves the rest of ~/.claude (sessions, caches, credentials, plugins) alone.
if [ -d "$REPO_DIR/claude" ]; then
  echo "Linking ~/.claude/* from dotfiles/claude/ ..."
  mkdir -p "$HOME/.claude"
  while IFS= read -r -d '' src; do
    rel="${src#$REPO_DIR/claude/}"
    dst="$HOME/.claude/$rel"
    mkdir -p "$(dirname "$dst")"
    if [ -e "$dst" ] && [ ! -L "$dst" ]; then
      echo "  Backing up existing $dst -> $dst.bak"
      mv "$dst" "$dst.bak"
    fi
    ln -sfn "$src" "$dst"
  done < <(find "$REPO_DIR/claude" -type f -print0)
fi

# Agent skills: the dotfiles repo is the source of truth.
#   ~/.agents            -> dotfiles/.agents        (skills-CLI store + global lock)
#   ~/.claude/skills/<X>  -> ../../.agents/skills/<X> (so Claude Code discovers them)
# Only skills tracked in .agents/.skill-lock.json are exposed to Claude, so
# plugin-managed skills (e.g. caveman) are left untouched.
if [ -d "$REPO_DIR/.agents" ]; then
  echo "Linking ~/.agents -> dotfiles/.agents ..."
  if [ -e "$HOME/.agents" ] && [ ! -L "$HOME/.agents" ]; then
    echo "  Backing up existing $HOME/.agents -> $HOME/.agents.bak"
    rm -rf "$HOME/.agents.bak"
    mv "$HOME/.agents" "$HOME/.agents.bak"
  fi
  ln -sfn "$REPO_DIR/.agents" "$HOME/.agents"

  if command -v node >/dev/null 2>&1 && [ -f "$REPO_DIR/.agents/.skill-lock.json" ]; then
    echo "Linking ~/.claude/skills/* for globally-installed skills ..."
    mkdir -p "$HOME/.claude/skills"
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      ln -sfn "../../.agents/skills/$name" "$HOME/.claude/skills/$name"
    done < <(node -e 'try{console.log(Object.keys(require(process.argv[1]).skills||{}).join("\n"))}catch(e){}' "$REPO_DIR/.agents/.skill-lock.json")
  else
    echo "  (node not available yet; re-run 'make link' after 'make mise' to link ~/.claude/skills/*)"
  fi
fi

echo "Done linking."
