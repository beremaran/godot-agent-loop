#!/usr/bin/env bash
# Runs the MCP-to-Godot E2E suite inside a Docker container with xvfb, so
# headed Godot windows and editor windows never appear on the host. The image
# provisions Ubuntu + xvfb + Godot 4.7 + Node exactly like the primary
# godot-integration.yml job, which makes local runs behave like CI (and lets
# CI compare startup counts and wall-clock time from the e2e-metrics summary).
#
# Usage:
#   scripts/run-e2e-docker.sh                        # full suite
#   scripts/run-e2e-docker.sh -- tests/e2e/project-config-tools.test.ts
#   GODOT_MCP_E2E_RENDERER=forward_plus GODOT_MCP_RENDER_TEST=1 scripts/run-e2e-docker.sh
#
# The repository is mounted read-write (build output and coverage land in the
# host tree); node_modules lives in a named volume so the host's install is
# never touched. Passed-through GODOT_MCP_* variables match the CI renderer,
# dotnet, and export jobs.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${E2E_DOCKER_IMAGE:-godot-agent-loop-e2e:4.7}"
VOLUME="${E2E_DOCKER_NODE_MODULES:-godot-agent-loop-e2e-node-modules}"
GODOT_VERSION="${E2E_DOCKER_GODOT_VERSION:-4.7-stable}"

docker build -q -t "$IMAGE" \
  --build-arg "GODOT_VERSION=${GODOT_VERSION}" \
  -f "$REPO_ROOT/tests/e2e/docker/Dockerfile" "$REPO_ROOT" >/dev/null

# The node_modules volume starts root-owned; seed it for the run's user so npm
# ci can write inside the container without touching the host's node_modules.
docker volume create "$VOLUME" >/dev/null 2>&1 || true
docker run --rm --user root -v "$VOLUME:/vol" busybox chown -R "$(id -u):$(id -g)" /vol

if [ -t 0 ]; then TTY="-it"; else TTY="-i"; fi

EXTRA_ENV=""
for var in GODOT_MCP_E2E_RENDERER GODOT_MCP_RENDER_TEST GODOT_MCP_HEADLESS \
  GODOT_MCP_DOTNET_TEST GODOT_MCP_EXPORT_TEMPLATE_TEST GODOT_MCP_PRIVILEGED_GROUPS; do
  if [ -n "${!var:-}" ]; then EXTRA_ENV="$EXTRA_ENV -e $var=${!var}"; fi
done

exec docker run --rm "$TTY" \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp/e2e-home \
  -v "$REPO_ROOT:/work" \
  -v "$VOLUME:/work/node_modules" \
  $EXTRA_ENV \
  -w /work \
  "$IMAGE" \
  bash -ec '
    set -e
    mkdir -p "$HOME"
    npm ci --no-audit --no-fund >/dev/null
    Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
    XVFB_PID=$!
    trap "kill $XVFB_PID 2>/dev/null || true" EXIT
    export DISPLAY=:99
    npm run test:e2e "$@"
  ' bash "$@"
