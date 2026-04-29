#!/usr/bin/env bash
# deploystack rollback.sh
#
# Swaps the "current" symlink to a previous, known-good release directory and
# reloads PM2. Does NOT touch the release directory contents.
#
# Required env:
#   DS_APP_NAME DS_APP_ROOT DS_RELEASES_DIR DS_CURRENT_LINK DS_ROLLBACK_TARGET DS_PM2_NAME

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

require_env DS_APP_NAME DS_APP_ROOT DS_RELEASES_DIR DS_CURRENT_LINK DS_ROLLBACK_TARGET DS_PM2_NAME

if [[ ! -d "${DS_ROLLBACK_TARGET}" ]]; then
  die "rollback target not found: ${DS_ROLLBACK_TARGET}"
fi

# Refuse to roll back to a target outside the app's releases dir
case "${DS_ROLLBACK_TARGET}" in
  "${DS_RELEASES_DIR}"/*) ;;
  *) die "rollback target is outside releases dir: ${DS_ROLLBACK_TARGET}" ;;
esac

PREV_TARGET=""
if [[ -L "${DS_CURRENT_LINK}" ]]; then
  PREV_TARGET="$(readlink -f "${DS_CURRENT_LINK}" || true)"
fi

log "== deploystack rollback: app=${DS_APP_NAME} target=${DS_ROLLBACK_TARGET} =="

atomic_symlink "${DS_ROLLBACK_TARGET}" "${DS_CURRENT_LINK}"

if pm2 describe "${DS_PM2_NAME}" >/dev/null 2>&1; then
  log "pm2 reload ${DS_PM2_NAME}"
  if ! pm2 reload "${DS_PM2_NAME}" --update-env; then
    log "reload failed; attempting restart"
    pm2 restart "${DS_PM2_NAME}" --update-env || {
      if [[ -n "${PREV_TARGET}" ]]; then
        log "restart failed; reverting symlink to ${PREV_TARGET}"
        atomic_symlink "${PREV_TARGET}" "${DS_CURRENT_LINK}"
      fi
      die "pm2 failed to restart rolled-back release"
    }
  fi
else
  log "pm2 process ${DS_PM2_NAME} not registered; nothing to reload"
fi

pm2 save >/dev/null 2>&1 || true

log "== rollback OK: ${DS_APP_NAME} -> $(basename "${DS_ROLLBACK_TARGET}") =="
