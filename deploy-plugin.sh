#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_TARGET="$HOME/.openclaw/extensions"

PLUGIN_INPUT=""
TARGET_ROOT="$DEFAULT_TARGET"
RESTART_OPENCLAW=1
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage:
  ./deploy-plugin.sh --plugin <plugin> [--target <dir>] [--no-restart] [--dry-run]

Options:
  --plugin       Plugin selector. Supports folder name, package name, or plugin id.
  --target       Deployment root directory. Final path will be <target>/<plugin-id>.
                 Default: ~/.openclaw/extensions
  --restart      Restart OpenClaw daemon after deployment. Default: enabled.
  --no-restart   Skip OpenClaw daemon restart.
  --dry-run      Print actions without changing files.
  -h, --help     Show this help.

Examples:
  ./deploy-plugin.sh --plugin wecom-kf
  ./deploy-plugin.sh --plugin @openclaw-china/wecom-kf --target ~/.openclaw/extensions
  ./deploy-plugin.sh --plugin wecom-app --target /tmp/openclaw-extensions --no-restart
EOF
}

log() {
  printf '[deploy-plugin] %s\n' "$*"
}

run_cmd() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[dry-run] '
    printf '%q ' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plugin)
      PLUGIN_INPUT="${2:-}"
      shift 2
      ;;
    --target)
      TARGET_ROOT="${2:-}"
      shift 2
      ;;
    --restart)
      RESTART_OPENCLAW=1
      shift
      ;;
    --no-restart)
      RESTART_OPENCLAW=0
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$PLUGIN_INPUT" ]]; then
  echo "--plugin is required" >&2
  usage >&2
  exit 1
fi

RESOLVED_JSON="$(
  ROOT_DIR="$ROOT_DIR" PLUGIN_INPUT="$PLUGIN_INPUT" node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const rootDir = process.env.ROOT_DIR;
const pluginInput = process.env.PLUGIN_INPUT;
const searchRoots = ['extensions', 'packages'];

const candidates = [];

for (const base of searchRoots) {
  const baseDir = path.join(rootDir, base);
  if (!fs.existsSync(baseDir)) continue;
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(baseDir, entry.name);
    const packageJsonPath = path.join(dir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const pluginJsonPath = path.join(dir, 'openclaw.plugin.json');
    let pluginId = null;
    if (fs.existsSync(pluginJsonPath)) {
      const pluginMeta = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
      pluginId = pluginMeta.id ?? null;
    }
    candidates.push({
      dir,
      dirName: entry.name,
      packageName: pkg.name ?? null,
      pluginId,
    });
  }
}

const normalizedInput = pluginInput.trim();
const match = candidates.find((candidate) =>
  candidate.dirName === normalizedInput ||
  candidate.packageName === normalizedInput ||
  candidate.pluginId === normalizedInput
);

if (!match) {
  console.error(`Unable to resolve plugin: ${normalizedInput}`);
  console.error('Available plugins:');
  for (const candidate of candidates) {
    console.error(`- ${candidate.dirName}${candidate.packageName ? ` (${candidate.packageName})` : ''}${candidate.pluginId ? ` [${candidate.pluginId}]` : ''}`);
  }
  process.exit(1);
}

const packageJsonPath = path.join(match.dir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const pluginJsonPath = path.join(match.dir, 'openclaw.plugin.json');
let pluginId = match.pluginId;
if (!pluginId && fs.existsSync(pluginJsonPath)) {
  const pluginMeta = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
  pluginId = pluginMeta.id ?? null;
}
if (!pluginId) {
  pluginId = match.dirName;
}

process.stdout.write(JSON.stringify({
  dir: match.dir,
  dirName: match.dirName,
  packageName: pkg.name ?? match.dirName,
  pluginId,
  hasOpenClawPluginJson: fs.existsSync(pluginJsonPath),
  hasDistDir: fs.existsSync(path.join(match.dir, 'dist')),
}));
NODE
)"

PLUGIN_DIR="$(printf '%s' "$RESOLVED_JSON" | node -p "const data = JSON.parse(require('fs').readFileSync(0, 'utf8')); data.dir")"
PLUGIN_NAME="$(printf '%s' "$RESOLVED_JSON" | node -p "const data = JSON.parse(require('fs').readFileSync(0, 'utf8')); data.packageName")"
PLUGIN_ID="$(printf '%s' "$RESOLVED_JSON" | node -p "const data = JSON.parse(require('fs').readFileSync(0, 'utf8')); data.pluginId")"
HAS_PLUGIN_JSON="$(printf '%s' "$RESOLVED_JSON" | node -p "const data = JSON.parse(require('fs').readFileSync(0, 'utf8')); data.hasOpenClawPluginJson ? '1' : '0'")"

TARGET_ROOT="${TARGET_ROOT/#\~/$HOME}"
TARGET_DIR="$TARGET_ROOT/$PLUGIN_ID"

log "plugin: $PLUGIN_NAME"
log "source: $PLUGIN_DIR"
log "target: $TARGET_DIR"

log "building plugin"
run_cmd pnpm -F "$PLUGIN_NAME" build

log "preparing target directory"
run_cmd mkdir -p "$TARGET_DIR/dist"

if [[ ! -d "$PLUGIN_DIR/dist" ]]; then
  echo "Missing build output: $PLUGIN_DIR/dist" >&2
  exit 1
fi

log "syncing dist files"
run_cmd rm -rf "$TARGET_DIR/dist"
run_cmd mkdir -p "$TARGET_DIR/dist"
run_cmd cp -R "$PLUGIN_DIR/dist/." "$TARGET_DIR/dist/"

log "copying package metadata"
run_cmd cp "$PLUGIN_DIR/package.json" "$TARGET_DIR/package.json"

if [[ "$HAS_PLUGIN_JSON" -eq 1 ]]; then
  log "copying openclaw plugin manifest"
  run_cmd cp "$PLUGIN_DIR/openclaw.plugin.json" "$TARGET_DIR/openclaw.plugin.json"
fi

if [[ -f "$PLUGIN_DIR/moltbot.plugin.json" ]]; then
  log "copying moltbot plugin manifest"
  run_cmd cp "$PLUGIN_DIR/moltbot.plugin.json" "$TARGET_DIR/moltbot.plugin.json"
fi

if [[ -f "$PLUGIN_DIR/clawdbot.plugin.json" ]]; then
  log "copying clawdbot plugin manifest"
  run_cmd cp "$PLUGIN_DIR/clawdbot.plugin.json" "$TARGET_DIR/clawdbot.plugin.json"
fi

if [[ "$RESTART_OPENCLAW" -eq 1 ]]; then
  if command -v openclaw >/dev/null 2>&1; then
    log "restarting OpenClaw daemon"
    run_cmd openclaw daemon restart
  else
    echo "openclaw command not found; cannot restart daemon" >&2
    exit 1
  fi
else
  log "skipping OpenClaw daemon restart"
fi

log "done"
