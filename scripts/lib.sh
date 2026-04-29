#!/usr/bin/env bash
# Shared helpers for deploystack bash scripts.
# Sourced by deploy.sh and rollback.sh.

set -Eeuo pipefail

log() {
  local ts
  ts="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  printf '[%s] %s\n' "$ts" "$*"
}

die() {
  log "ERROR: $*"
  exit 1
}

# require_env VAR [VAR...]
require_env() {
  local var
  for var in "$@"; do
    if [[ -z "${!var:-}" ]]; then
      die "required env var $var is not set"
    fi
  done
}

# atomic_symlink target link
# Atomically point "link" at "target" using a temp symlink + rename (`mv -Tf`).
# Works within the same directory (mv(2) on a symlink is atomic on POSIX).
atomic_symlink() {
  local target="$1"
  local link="$2"
  local tmp
  tmp="${link}.tmp.$$"
  ln -sfn "$target" "$tmp"
  mv -Tf "$tmp" "$link"
}

# wait_for_http URL TIMEOUT_SECONDS
# Returns 0 if URL responds 2xx within TIMEOUT, else non-zero.
wait_for_http() {
  local url="$1"
  local timeout="${2:-20}"
  local start end code
  start="$(date +%s)"
  end=$(( start + timeout ))
  while : ; do
    if code="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 5 "$url" || true)"; then
      case "$code" in
        2??) return 0 ;;
      esac
    fi
    if (( $(date +%s) >= end )); then
      return 1
    fi
    sleep 1
  done
}

# prune_releases DIR KEEP CURRENT_LINK
# Keep the newest KEEP release directories by mtime, except never remove the one
# currently pointed to by CURRENT_LINK (if it happens to be older).
prune_releases() {
  local dir="$1"
  local keep="$2"
  local cur_link="$3"
  local cur_target=""
  if [[ -L "$cur_link" ]]; then
    cur_target="$(readlink -f "$cur_link" || true)"
  fi
  mapfile -t releases < <(find "$dir" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | awk '{ $1=""; sub(/^ /,""); print }')
  local i=0
  for r in "${releases[@]}"; do
    i=$((i+1))
    if (( i <= keep )); then continue; fi
    if [[ -n "$cur_target" && "$r" == "$cur_target" ]]; then
      log "skip prune: release $r is active"
      continue
    fi
    log "pruning old release: $r"
    rm -rf -- "$r"
  done
}

# escape a ref for use in a filesystem path (unused but handy)
sanitize() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'
}
