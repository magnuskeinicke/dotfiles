#!/usr/bin/env bash
# Claude Code status line — Catppuccin Mocha palette, mirrors Starship config

# Catppuccin Mocha colors
LAVENDER="\033[38;2;180;190;254m"   # #b4befe — directory
MAUVE="\033[38;2;203;166;247m"      # #cba6f7 — git branch
PEACH="\033[38;2;250;179;135m"      # #fab387 — model
TEAL="\033[38;2;148;226;213m"       # #94e2d5 — context (normal)
YELLOW="\033[38;2;249;226;175m"     # #f9e2af — context warning (>70%)
RED="\033[38;2;243;139;168m"        # #f38ba8 — context critical (>90%)
SUBTEXT1="\033[38;2;186;194;222m"   # #bac2de — dim text
BOLD="\033[1m"
RESET="\033[0m"

input=$(cat)

cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // ""')
model=$(echo "$input" | jq -r '.model.display_name // ""')
used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
remaining_pct=$(echo "$input" | jq -r '.context_window.remaining_percentage // empty')
ctx_size=$(echo "$input" | jq -r '.context_window.context_window_size // empty')
# Sum all input-side token kinds (input + cache reads + cache creation)
input_tokens=$(echo "$input" | jq -r '
  (.context_window.current_usage // {}) as $u
  | ((($u.input_tokens // 0)
      + ($u.cache_read_input_tokens // 0)
      + ($u.cache_creation_input_tokens // 0)) // empty)
  | select(. > 0)
')

# Fallback: derive used tokens from percentage × window size when current_usage is missing/zero
if { [ -z "$input_tokens" ] || [ "$input_tokens" = "0" ]; } && [ -n "$used_pct" ] && [ -n "$ctx_size" ]; then
  input_tokens=$(awk "BEGIN { printf \"%d\", ($used_pct/100) * $ctx_size }")
fi

# Shorten path: show up to 4 components (mirrors starship truncation_length=4)
short_dir=$(echo "$cwd" | awk -F'/' '{
  n=NF
  if (n <= 4) { print $0 }
  else { out=""; for(i=n-3;i<=n;i++) out=out"/"$i; print out }
}' | sed 's|^/home/[^/]*|~|')

# Git branch (skip optional lock to avoid blocking)
git_branch=""
if [ -d "$cwd/.git" ] || git -C "$cwd" rev-parse --git-dir --no-optional-locks > /dev/null 2>&1; then
  git_branch=$(git -C "$cwd" --no-optional-locks symbolic-ref --short HEAD 2>/dev/null \
    || git -C "$cwd" --no-optional-locks rev-parse --short HEAD 2>/dev/null)
fi

# Helper: format token count as e.g. "0.5k", "90k", or "1.2M"
fmt_tokens() {
  local n="$1"
  if [ -z "$n" ] || [ "$n" = "null" ]; then echo "?"; return; fi
  if [ "$n" -ge 1000000 ] 2>/dev/null; then
    awk "BEGIN { printf \"%.1fM\", $n/1000000 }"
  elif [ "$n" -ge 10000 ] 2>/dev/null; then
    awk "BEGIN { printf \"%.0fk\", $n/1000 }"
  else
    awk "BEGIN { printf \"%.1fk\", $n/1000 }"
  fi
}

# Pick context color based on usage percentage
ctx_color="$TEAL"
if [ -n "$used_pct" ]; then
  used_int=$(printf '%.0f' "$used_pct")
  if [ "$used_int" -ge 90 ]; then
    ctx_color="$RED"
  elif [ "$used_int" -ge 70 ]; then
    ctx_color="$YELLOW"
  fi
fi

# Build output
out=""

# Caveman badge — read flag file directly (avoids dep on versioned plugin path)
caveman_flag="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.caveman-active"
if [ -f "$caveman_flag" ] && [ ! -L "$caveman_flag" ]; then
  caveman_mode=$(head -c 64 "$caveman_flag" 2>/dev/null | tr -d '\n\r' | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')
  case "$caveman_mode" in
    off|"") ;;
    lite|full|ultra|wenyan-lite|wenyan|wenyan-full|wenyan-ultra|commit|review|compress)
      if [ "$caveman_mode" = "full" ]; then
        out="$(printf '\033[38;5;172m[CAVEMAN]\033[0m') "
      else
        out="$(printf '\033[38;5;172m[CAVEMAN:%s]\033[0m' "$(printf '%s' "$caveman_mode" | tr '[:lower:]' '[:upper:]')") "
      fi
      ;;
  esac
fi

# Directory with  icon (Nerd Font)
out="${out}$(printf "${BOLD}${LAVENDER} %s${RESET}" "$short_dir")"

# Git branch with  icon (Nerd Font)
if [ -n "$git_branch" ]; then
  out="${out} $(printf "${MAUVE} %s${RESET}" "$git_branch")"
fi

# Second line: model + context — kept off line 1 so a long workspace path
# can't push them off-screen
line2=""

# Model
if [ -n "$model" ]; then
  line2="$(printf "${PEACH}%s${RESET}" "$model")"
fi

# Context usage — show "used% (usedTokens/totalTokens) remaining%"
if [ -n "$used_pct" ]; then
  used_int=$(printf '%.0f' "$used_pct")
  ctx_label="${used_int}%"

  # Append token counts when available
  if [ -n "$input_tokens" ] && [ -n "$ctx_size" ]; then
    used_fmt=$(fmt_tokens "$input_tokens")
    total_fmt=$(fmt_tokens "$ctx_size")
    ctx_label="${ctx_label} (${used_fmt}/${total_fmt})"
  fi

  # Append remaining percentage
  if [ -n "$remaining_pct" ]; then
    rem_int=$(printf '%.0f' "$remaining_pct")
    ctx_label="${ctx_label} ${rem_int}% left"
  fi

  if [ -n "$line2" ]; then
    line2="${line2} $(printf "${SUBTEXT1}|${RESET}") "
  fi
  line2="${line2}$(printf "${ctx_color}%s${RESET}" "$ctx_label")"
fi

if [ -n "$line2" ]; then
  out="${out}\n${line2}"
fi

printf "%b" "$out"
