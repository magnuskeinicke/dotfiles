#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p "$HOME/.config"

echo "Linking ~/.config/* from dotfiles/config/ ..."
for path in "$REPO_DIR/config/"*; do
  [ -e "$path" ] || continue
  name="$(basename "$path")"
  ln -sfnT "$path" "$HOME/.config/$name"
done

echo "Linking home dotfiles..."
ln -sf "$REPO_DIR/zsh/zshrc" "$HOME/.zshrc"
ln -sf "$REPO_DIR/zsh/zsh_aliases" "$HOME/.zsh_aliases"
ln -sf "$REPO_DIR/zsh/helpers.zsh" "$HOME/helpers.zsh"

echo "Done linking."
