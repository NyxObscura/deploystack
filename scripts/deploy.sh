#!/usr/bin/env bash
# deploystack deploy.sh
#
# Receives configuration via environment variables (see src/deployer.js::buildEnv).
# All stdout/stderr is captured to a per-release log file by the Node runner.
#
# Steps:
#   1. Create a fresh release directory
#   2. git clone/fetch and checkout the target SHA (or branch HEAD)
#   3. Link shared files/dirs into the release
#   4. Install dependencies
#   5. Build the app
#   6. Atomically swap the "current" symlink
#   7. Reload PM2 (zero-downtime cluster reload)
#   8. Health-check (if configured); roll back the symlink on failure
#   9. Prune old releases

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

require_env \
  DS_APP_NAME DS_APP_ROOT DS_RELEASES_DIR DS_SHARED_DIR DS_CURRENT_LINK \
  DS_RELEASE_ID DS_REPO_URL DS_BRANCH DS_INSTALL_CMD DS_BUILD_CMD \
  DS_PM2_NAME DS_KEEP_RELEASES

RELEASE_DIR="${DS_RELEASES_DIR}/${DS_RELEASE_ID}"
PREV_TARGET=""
if [[ -L "${DS_CURRENT_LINK}" ]]; then
  PREV_TARGET="$(readlink -f "${DS_CURRENT_LINK}" || true)"
fi

# Always clean up a half-built release if we fail BEFORE we swap the symlink.
SWAPPED=0
cleanup_on_error() {
  local code=$?
  if (( SWAPPED == 0 )); then
    log "deploy failed (exit=$code); removing partial release ${RELEASE_DIR}"
    rm -rf -- "${RELEASE_DIR}" || true
  else
    log "deploy failed after symlink swap; attempting rollback"
    if [[ -n "${PREV_TARGET}" && -d "${PREV_TARGET}" ]]; then
      atomic_symlink "${PREV_TARGET}" "${DS_CURRENT_LINK}"
      pm2 reload "${DS_PM2_NAME}" --update-env || pm2 restart "${DS_PM2_NAME}" || true
      log "rolled symlink back to ${PREV_TARGET}"
    else
      log "no previous release to roll back to"
    fi
  fi
  exit "$code"
}
trap cleanup_on_error ERR

mkdir -p "${DS_RELEASES_DIR}" "${DS_SHARED_DIR}"

log "== deploystack deploy: app=${DS_APP_NAME} release=${DS_RELEASE_ID} =="
log "repo=${DS_REPO_URL} branch=${DS_BRANCH} sha=${DS_SHA:-(HEAD)}"

# ---------------------------------------------------------------------------
# 1. Fetch source.
#
# We use a bare "reference" cache in shared/repo.git to avoid re-downloading
# history on every deploy. Each release gets its own working tree via
# `git worktree add` when possible; fallback to full shallow clone if worktree
# unsupported (e.g. non-bare clones, older git).
# ---------------------------------------------------------------------------
CACHE_REPO="${DS_SHARED_DIR}/repo.git"
if [[ ! -d "${CACHE_REPO}" ]]; then
  log "initializing repo cache: ${CACHE_REPO}"
  git clone --bare --filter=blob:none "${DS_REPO_URL}" "${CACHE_REPO}"
else
  log "updating repo cache"
  git --git-dir="${CACHE_REPO}" remote set-url origin "${DS_REPO_URL}"
  git --git-dir="${CACHE_REPO}" fetch --prune --tags --force origin "+refs/heads/*:refs/heads/*"
fi

# Resolve target SHA if not provided
TARGET_SHA="${DS_SHA:-}"
if [[ -z "${TARGET_SHA}" ]]; then
  TARGET_SHA="$(git --git-dir="${CACHE_REPO}" rev-parse "${DS_BRANCH}")"
  log "resolved branch ${DS_BRANCH} to sha ${TARGET_SHA}"
fi

# Validate sha actually exists in the cache
if ! git --git-dir="${CACHE_REPO}" cat-file -e "${TARGET_SHA}^{commit}" 2>/dev/null; then
  die "sha ${TARGET_SHA} not found in repo cache"
fi

log "creating release directory ${RELEASE_DIR}"
mkdir -p "${RELEASE_DIR}"

# Use archive for a clean working tree (no .git, no filter oddities).
# This mirrors what Vercel/Netlify do and keeps releases small + immutable.
log "extracting source tree at ${TARGET_SHA}"
git --git-dir="${CACHE_REPO}" archive --format=tar "${TARGET_SHA}" | tar -x -C "${RELEASE_DIR}"

# Record the deployed sha for debugging & observability.
printf '%s\n' "${TARGET_SHA}" > "${RELEASE_DIR}/.deploystack-sha"
printf '%s\n' "${DS_RELEASE_ID}" > "${RELEASE_DIR}/.deploystack-release"

# ---------------------------------------------------------------------------
# 2. Link shared files/dirs into the release.
# ---------------------------------------------------------------------------
if [[ -n "${DS_SHARED_FILES:-}" ]]; then
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    src="${DS_SHARED_DIR}/$f"
    dest="${RELEASE_DIR}/$f"
    if [[ ! -e "$src" ]]; then
      log "shared file missing, skipping: $src"
      continue
    fi
    mkdir -p "$(dirname "$dest")"
    ln -sfn "$src" "$dest"
    log "linked shared file $f"
  done <<< "${DS_SHARED_FILES}"
fi

if [[ -n "${DS_SHARED_DIRS:-}" ]]; then
  while IFS= read -r d; do
    [[ -z "$d" ]] && continue
    src="${DS_SHARED_DIR}/$d"
    dest="${RELEASE_DIR}/$d"
    mkdir -p "$src"
    rm -rf -- "$dest"
    mkdir -p "$(dirname "$dest")"
    ln -sfn "$src" "$dest"
    log "linked shared dir $d"
  done <<< "${DS_SHARED_DIRS}"
fi

# ---------------------------------------------------------------------------
# 3. Install dependencies + build.
# ---------------------------------------------------------------------------
export CI=1
export NODE_ENV="${NODE_ENV:-production}"

# Pin node version via nvm / fnm / volta if available and requested.
if [[ -n "${DS_NODE_VERSION:-}" ]]; then
  if command -v fnm >/dev/null 2>&1; then
    log "fnm use ${DS_NODE_VERSION}"
    # shellcheck disable=SC1091
    eval "$(fnm env --use-on-cd)" || true
    fnm use "${DS_NODE_VERSION}" || log "fnm use failed; continuing with system node"
  elif [[ -s "${HOME}/.nvm/nvm.sh" ]]; then
    log "nvm use ${DS_NODE_VERSION}"
    # shellcheck disable=SC1091
    . "${HOME}/.nvm/nvm.sh"
    nvm use "${DS_NODE_VERSION}" || log "nvm use failed; continuing with system node"
  fi
fi

cd "${RELEASE_DIR}"

log "node: $(node --version 2>/dev/null || echo '?')  npm: $(npm --version 2>/dev/null || echo '?')"

log "installing dependencies: ${DS_INSTALL_CMD}"
bash -c "${DS_INSTALL_CMD}"

if [[ -n "${DS_BUILD_CMD}" ]]; then
  log "building: ${DS_BUILD_CMD}"
  bash -c "${DS_BUILD_CMD}"
fi

# ---------------------------------------------------------------------------
# 4. Atomic symlink swap.
# ---------------------------------------------------------------------------
log "swapping symlink: current -> ${RELEASE_DIR}"
atomic_symlink "${RELEASE_DIR}" "${DS_CURRENT_LINK}"
SWAPPED=1

# ---------------------------------------------------------------------------
# 5. Reload PM2 (zero-downtime in cluster mode).
#
# Semantics:
#   - If the process is already registered, `pm2 reload` replaces workers one
#     at a time, waiting for each new worker to send `ready` before killing
#     the old one (requires wait_ready + process.send('ready') in your app,
#     or PM2's internal fallback).
#   - If the process is NOT registered (first deploy), `pm2 reload` fails, so
#     we fall back to `pm2 start` using the app's ecosystem.config.js if it
#     exists in the release, or in the app root.
# ---------------------------------------------------------------------------
if pm2 describe "${DS_PM2_NAME}" >/dev/null 2>&1; then
  log "pm2 reload ${DS_PM2_NAME}"
  pm2 reload "${DS_PM2_NAME}" --update-env
else
  ECOSYSTEM=""
  for candidate in \
    "${DS_APP_ROOT}/ecosystem.config.js" \
    "${DS_CURRENT_LINK}/ecosystem.config.js"; do
    if [[ -f "${candidate}" ]]; then
      ECOSYSTEM="${candidate}"
      break
    fi
  done
  if [[ -z "${ECOSYSTEM}" ]]; then
    die "pm2 process ${DS_PM2_NAME} not registered and no ecosystem.config.js found"
  fi
  log "pm2 start ${ECOSYSTEM} --only ${DS_PM2_NAME}"
  pm2 start "${ECOSYSTEM}" --only "${DS_PM2_NAME}" --update-env
fi

pm2 save >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 6. Health check. If it fails, the ERR trap rolls the symlink back.
# ---------------------------------------------------------------------------
if [[ -n "${DS_HEALTHCHECK_URL:-}" ]]; then
  log "health check: ${DS_HEALTHCHECK_URL} (timeout=${DS_HEALTHCHECK_TIMEOUT}s)"
  if ! wait_for_http "${DS_HEALTHCHECK_URL}" "${DS_HEALTHCHECK_TIMEOUT}"; then
    die "health check failed for ${DS_HEALTHCHECK_URL}"
  fi
  log "health check passed"
fi

# ---------------------------------------------------------------------------
# 7. Prune old releases.
# ---------------------------------------------------------------------------
prune_releases "${DS_RELEASES_DIR}" "${DS_KEEP_RELEASES}" "${DS_CURRENT_LINK}"

log "== deploy OK: ${DS_APP_NAME} -> ${DS_RELEASE_ID} (sha ${TARGET_SHA}) =="
trap - ERR
