# =========================
# Package helpers (colored)
# =========================

# ---- Paths ----
: "${DOTFILES_DIR:=${HOME}/dotfiles}"
FLATPAK_LIST="${DOTFILES_DIR}/flatpak/packages.txt"
APT_LIST="${DOTFILES_DIR}/apt/packages.txt"
BREWFILE="${DOTFILES_DIR}/brew/Brewfile"

# Ensure parent dirs exist
mkdir -p "${FLATPAK_LIST:h}" "${APT_LIST:h}" "${BREWFILE:h}"

# ---- OS family ----
case "$(uname -s)" in
  Darwin*) _OS_FAMILY=macos ;;
  Linux*)  _OS_FAMILY=linux ;;
  *)       _OS_FAMILY=unknown ;;
esac

_require_os() {
  # _require_os <expected> <cmd-name>
  if [[ "$_OS_FAMILY" != "$1" ]]; then
    _err "$2 is only available on $1 (running on $_OS_FAMILY)"
    return 1
  fi
}

# ---- Colors (zsh) ----
autoload -U colors && colors
# Use print -P so %F/%f etc. are expanded
_log()   { print -P "%F{244}==>%f $*"; }
_ok()    { print -P "%F{green}✔%f $*"; }
_warn()  { print -P "%F{yellow}⚠%f $*"; }
_err()   { print -P "%F{red}✘%f $*"; }

# ---- Dry Run Support ----
_DRYRUN="${DOTFILES_DRYRUN:-0}"

_is_dryrun() {
  [[ "$_DRYRUN" = "1" ]]
}

_run() {
  if _is_dryrun; then
    print -P "%F{blue}[dry-run]%f $*"
  else
    "$@"
  fi
}

_need_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || { _err "Missing command: $cmd"; return 127; }
}

# Append a line to a file if it doesn't already exist (exact match)
_append_if_missing() {
  local line="$1"
  local file="$2"

  if _is_dryrun; then
    print -P "%F{blue}[dry-run]%f Would track: $line -> ${file/#$HOME/~}"
    return 0
  fi

  touch "$file"
  if grep -Fxq -- "$line" "$file"; then
    _warn "Already tracked: $line"
  else
    print -r -- "$line" >> "$file"
    _ok "Tracked: $line"
  fi
}

# Remove exact matching line safely
_remove_if_present() {
  local line="$1"
  local file="$2"

  if _is_dryrun; then
    print -P "%F{blue}[dry-run]%f Would untrack: $line <- ${file/#$HOME/~}"
    return 0
  fi

  [[ -f "$file" ]] || return 0

  if grep -Fxq -- "$line" "$file"; then
    grep -Fxv -- "$line" "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
    _ok "Untracked: $line"
  else
    _warn "Not tracked: $line"
  fi
}

_usage() {
  local name="$1"
  shift
  _err "Usage: $name $*"
  return 2
}

# Generic runner over args:
# _for_each "<cmd_name>" "<list_file>" "<install/remove>" <items...>
_for_each() {
  local cmd_name="$1"
  local list_file="$2"
  local mode="$3"
  shift 3

  [[ $# -ge 1 ]] || _usage "$cmd_name" "<item> [item ...]"

  local item
  for item in "$@"; do
    case "$cmd_name:$mode" in
      fp-i:install)
        _log "Flatpak install: $item"
        _run flatpak install --user -y flathub "$item" || return $?
        _append_if_missing "$item" "$list_file"
        ;;

      fp-rm:remove)
        _log "Flatpak uninstall: $item"
        if _run flatpak uninstall --user -y "$item"; then
          _remove_if_present "$item" "$list_file"
        else
          _warn "Uninstall failed (leaving list unchanged): $item"
        fi
        ;;

      apt-i:install)
        # apt-i supports multiple pkgs, but we still track per pkg below.
        # This case will not be used; apt-i has its own implementation.
        ;;

      apt-rm:remove)
        # apt-rm supports multiple pkgs, but we still untrack per pkg below.
        ;;

      mise-i:install)
        _log "mise use -g: $item"
        _run mise use -g "$item" || return $?
        _ok "Enabled globally: $item"
        ;;

      mise-rm:remove)
        _log "mise unuse -g: $item"
        _run mise unuse -g "$item" 2>/dev/null || true
        _ok "Disabled globally (if present): $item"
        ;;

      *)
        _err "Internal: unknown action $cmd_name $mode"
        return 2
        ;;
    esac
  done
}

# =========================
# Flatpak
# =========================
fp-i() {
  if [[ "$1" == "--dry-run" || "$1" == "-n" ]]; then
    _DRYRUN=1
    shift
  fi
  _require_os linux fp-i || return $?
  _need_cmd flatpak || return $?
  _for_each fp-i "$FLATPAK_LIST" install "$@"
}

fp-rm() {
  if [[ "$1" == "--dry-run" || "$1" == "-n" ]]; then
    _DRYRUN=1
    shift
  fi
  _require_os linux fp-rm || return $?
  _need_cmd flatpak || return $?
  _for_each fp-rm "$FLATPAK_LIST" remove "$@"
}

fp-up() {
  if [[ "$1" == "--dry-run" || "$1" == "-n" ]]; then
    _DRYRUN=1
    shift
  fi
  _require_os linux fp-up || return $?
  _need_cmd flatpak || return $?
  _log "Flatpak update (user)"
  _run flatpak update --user -y
  _ok "Flatpak updated"
}

# =========================
# Apt
# =========================
apt-i() {
  if [[ "$1" == "--dry-run" || "$1" == "-n" ]]; then
    _DRYRUN=1
    shift
  fi
  [[ $# -ge 1 ]] || _usage apt-i "<pkg> [pkg ...]"
  _require_os linux apt-i || return $?
  _need_cmd apt || return $?

  _log "apt update"
  _run sudo apt update || return $?

  _log "apt install: $*"
  _run sudo apt install -y "$@" || return $?

  local pkg
  for pkg in "$@"; do
    _append_if_missing "$pkg" "$APT_LIST"
  done
  _ok "Apt install complete"
}

apt-rm() {
  if [[ "$1" == "--dry-run" || "$1" == "-n" ]]; then
    _DRYRUN=1
    shift
  fi
  [[ $# -ge 1 ]] || _usage apt-rm "<pkg> [pkg ...]"
  _require_os linux apt-rm || return $?
  _need_cmd apt || return $?

  _log "apt purge: $*"
  _run sudo apt purge -y "$@" || return $?

  local pkg
  for pkg in "$@"; do
    _remove_if_present "$pkg" "$APT_LIST"
  done
  _ok "Apt purge complete"
}

apt-up() {
  if [[ "$1" == "--dry-run" || "$1" == "-n" ]]; then
    _DRYRUN=1
    shift
  fi
  _require_os linux apt-up || return $?
  _need_cmd apt || return $?
  _log "apt update"
  _run sudo apt update || return $?
  _log "apt upgrade"
  _run sudo apt upgrade -y || return $?
  _ok "Apt upgraded"
}

# =========================
# Homebrew (macOS)
# =========================
# Tracks installs in brew/Brewfile so the bootstrap stays declarative.

_brew_append() {
  # _brew_append <kind:brew|cask> <name>
  local kind="$1" name="$2"
  local line
  if [[ "$kind" == "cask" ]]; then
    line="cask \"$name\""
  else
    line="brew \"$name\""
  fi
  _append_if_missing "$line" "$BREWFILE"
}

_brew_remove() {
  local kind="$1" name="$2"
  local line
  if [[ "$kind" == "cask" ]]; then
    line="cask \"$name\""
  else
    line="brew \"$name\""
  fi
  _remove_if_present "$line" "$BREWFILE"
}

brew-i() {
  if [[ "$1" == "--dry-run" || "$1" == "-n" ]]; then
    _DRYRUN=1
    shift
  fi
  local kind="brew"
  if [[ "$1" == "--cask" ]]; then
    kind="cask"
    shift
  fi
  [[ $# -ge 1 ]] || _usage brew-i "[--cask] <pkg> [pkg ...]"
  _require_os macos brew-i || return $?
  _need_cmd brew || return $?

  local args=(install)
  [[ "$kind" == "cask" ]] && args+=(--cask)

  _log "brew ${args[*]}: $*"
  _run brew "${args[@]}" "$@" || return $?

  local pkg
  for pkg in "$@"; do
    _brew_append "$kind" "$pkg"
  done
  _ok "Brew install complete"
}

brew-rm() {
  if [[ "$1" == "--dry-run" || "$1" == "-n" ]]; then
    _DRYRUN=1
    shift
  fi
  local kind="brew"
  if [[ "$1" == "--cask" ]]; then
    kind="cask"
    shift
  fi
  [[ $# -ge 1 ]] || _usage brew-rm "[--cask] <pkg> [pkg ...]"
  _require_os macos brew-rm || return $?
  _need_cmd brew || return $?

  local args=(uninstall)
  [[ "$kind" == "cask" ]] && args+=(--cask)

  _log "brew ${args[*]}: $*"
  _run brew "${args[@]}" "$@" || return $?

  local pkg
  for pkg in "$@"; do
    _brew_remove "$kind" "$pkg"
  done
  _ok "Brew uninstall complete"
}

brew-up() {
  if [[ "$1" == "--dry-run" || "$1" == "-n" ]]; then
    _DRYRUN=1
    shift
  fi
  _require_os macos brew-up || return $?
  _need_cmd brew || return $?
  _log "brew update"
  _run brew update || return $?

  _log "brew upgrade"
  _run brew upgrade || return $?
  _ok "Brew upgraded"
}

# =========================
# mise
# =========================
mise-i() {
  if [[ "$1" == "--dry-run" || "$1" == "-n" ]]; then
    _DRYRUN=1
    shift
  fi
  _need_cmd mise || return $?
  _for_each mise-i "" install "$@"
}

mise-rm() {
  if [[ "$1" == "--dry-run" || "$1" == "-n" ]]; then
    _DRYRUN=1
    shift
  fi
  _need_cmd mise || return $?
  _for_each mise-rm "" remove "$@"
}

mise-up() {
  if [[ "$1" == "--dry-run" || "$1" == "-n" ]]; then
    _DRYRUN=1
    shift
  fi
  _need_cmd mise || return $?
  _log "mise self-update"
  _run mise self-update -y 2>/dev/null || _warn "mise self-update skipped/failed (continuing)"
  _log "mise upgrade"
  _run mise upgrade
  _ok "mise upgraded"
}

# =========================
# All updates
# =========================
all-up() {
  if [[ "$1" == "--dry-run" || "$1" == "-n" ]]; then
    _DRYRUN=1
    shift
  fi
  if [[ "$_OS_FAMILY" == "linux" ]]; then
    fp-up
    apt-up
  elif [[ "$_OS_FAMILY" == "macos" ]]; then
    brew-up
  fi
  mise-up
  _ok "All updates done"
}
