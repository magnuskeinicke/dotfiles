# =========================
# Package helpers (colored)
# =========================

# ---- Paths ----
: "${DOTFILES_DIR:=${HOME}/.dotfiles}"
FLATPAK_LIST="${DOTFILES_DIR}/flatpak/packages.txt"
APT_LIST="${DOTFILES_DIR}/apt/packages.txt"

# Ensure parent dirs exist
mkdir -p "${FLATPAK_LIST:h}" "${APT_LIST:h}"

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
  _need_cmd flatpak || return $?
  _for_each fp-i "$FLATPAK_LIST" install "$@"
}

fp-rm() {
  if [[ "$1" == "--dry-run" || "$1" == "-n" ]]; then
    _DRYRUN=1
    shift
  fi
  _need_cmd flatpak || return $?
  _for_each fp-rm "$FLATPAK_LIST" remove "$@"
}

fp-up() {
  if [[ "$1" == "--dry-run" || "$1" == "-n" ]]; then
    _DRYRUN=1
    shift
  fi
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
  _need_cmd apt || return $?
  _log "apt update"
  _run sudo apt update || return $?
  _log "apt upgrade"
  _run sudo apt upgrade -y || return $?
  _ok "Apt upgraded"
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
  fp-up
  apt-up
  mise-up
  _ok "All updates done"
}
