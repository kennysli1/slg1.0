#!/usr/bin/env bash
# 远端不可变发布执行器。由 tools/deploy.sh 通过 SSH stdin 调用，也可在临时目录中测试。
set -euo pipefail

ACTION="${1:-}"
BASE_INPUT="${2:-}"
STATE_INPUT="${3:-}"

die() { echo "✖ $*" >&2; exit 1; }

[[ "$ACTION" == deploy || "$ACTION" == rollback || "$ACTION" == finalize ]] || die "未知动作：$ACTION"
[[ -n "$BASE_INPUT" && -n "$STATE_INPUT" ]] || die "缺少生产目录或状态文件"

mkdir -p "$BASE_INPUT"
BASE="$(cd "$BASE_INPUT" && pwd -P)"
[[ "$BASE" != / && "$BASE" != /home && "$BASE" != /root ]] || die "拒绝使用过宽的生产目录：$BASE"
STATE="$STATE_INPUT"
RELEASES="$BASE/releases"
SHARED="$BASE/shared"
CURRENT="$BASE/current"
LOCK="$BASE/.deploy-lock"
NPM_BIN="${KOW_DEPLOY_NPM_BIN:-npm}"
PM2_BIN="${KOW_DEPLOY_PM2_BIN:-pm2}"
CURL_BIN="${KOW_DEPLOY_CURL_BIN:-curl}"

state_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$STATE" | head -n 1
}

has_test_server() {
  local config="$1"
  grep -Fq "name: 'kow-test-01'" "$config"
}

start_servers() {
  local config="$1"
  # PM2 的 startOrReload 不会可靠更新既有进程的 script/cwd（历史进程曾仍指向 src/main.ts）。
  # 每次发布都重建主服与存在于该 release 中的测试服，确保二者均运行构建产物。
  "$PM2_BIN" delete kow >/dev/null 2>&1 || true
  "$PM2_BIN" delete kow-test-01 >/dev/null 2>&1 || true
  "$PM2_BIN" start "$config" --only kow --update-env
  if has_test_server "$config"; then
    "$PM2_BIN" start "$config" --only kow-test-01 --update-env
  fi
  sleep "${KOW_DEPLOY_HEALTH_DELAY:-2}"
  "$CURL_BIN" --fail --silent --show-error http://127.0.0.1:8080/health >/dev/null
  if has_test_server "$config"; then
    "$CURL_BIN" --fail --silent --show-error http://127.0.0.1:8081/health >/dev/null
  fi
}

activate() {
  local target="$1"
  local next="$BASE/.current-$$"
  ln -s "$target" "$next"
  node -e "require('node:fs').renameSync(process.argv[1], process.argv[2])" "$next" "$CURRENT"
  start_servers "$CURRENT/ecosystem.config.cjs"
}

restore_previous() {
  local mode previous
  [[ -f "$STATE" ]] || return 0
  mode="$(state_value PREVIOUS_MODE)"
  previous="$(state_value PREVIOUS_PATH)"
  if [[ "$mode" == release && -d "$previous" ]]; then
    activate "$previous"
  elif [[ "$mode" == legacy && -f "$BASE/ecosystem.config.cjs" ]]; then
    rm -f "$CURRENT"
    start_servers "$BASE/ecosystem.config.cjs"
  fi
}

if [[ "$ACTION" == rollback ]]; then
  echo "==> 切回上一个生产版本" >&2
  trap 'rm -rf "$LOCK"' EXIT
  restore_previous
  exit 0
fi

if [[ "$ACTION" == finalize ]]; then
  [[ -f "$STATE" ]] || die "发布状态不存在：$STATE"
  if [[ -d "$BASE/.git" ]]; then
    mkdir -p "$BASE/backups"
    legacy_git="$BASE/backups/legacy-git-$(date -u +%Y%m%dT%H%M%SZ)"
    mv "$BASE/.git" "$legacy_git"
    echo "    旧 .git 已归档到 $legacy_git"
  fi
  "$PM2_BIN" save >/dev/null
  rm -rf "$LOCK"
  exit 0
fi

ARCHIVE="${4:-}"
MAIN_SHA="${5:-}"
[[ -f "$ARCHIVE" ]] || die "发布包不存在：$ARCHIVE"
[[ "$MAIN_SHA" =~ ^[0-9a-f]{40}$ ]] || die "非法提交 SHA：$MAIN_SHA"

if ! mkdir "$LOCK" 2>/dev/null; then
  die "已有生产发布正在进行；确认没有其他发布后再处理 $LOCK"
fi
trap 'rm -rf "$LOCK"' ERR

mkdir -p "$RELEASES" "$SHARED/data" "$SHARED/logs" "$SHARED/config"
if [[ ! -e "$SHARED/data/game.json" && -d "$BASE/data" ]]; then
  cp -a "$BASE/data/." "$SHARED/data/"
fi
# 平衡调参覆盖与 game.json 是两份独立的持久数据。旧版生产目录可能已经有
# shared/data/game.json，但 balance_overrides.json 仍只在 BASE/data；不能因为
# 存档已迁移就漏掉 GM 覆盖。已有 shared 覆盖时保持它为当前权威值，不覆盖。
if [[ -f "$BASE/data/balance_overrides.json" && ! -e "$SHARED/data/balance_overrides.json" ]]; then
  cp -p "$BASE/data/balance_overrides.json" "$SHARED/data/balance_overrides.json"
fi
if [[ -d "$BASE/logs" && -z "$(find "$SHARED/logs" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  cp -a "$BASE/logs/." "$SHARED/logs/"
fi

# GM 面板保存的配置 CSV 位于 shared/config，并由 manifest 精确列出。每次发布
# 在构建/启动前覆盖回 release，既让 GM 修改跨部署保留，又不会冻结未被 GM
# 编辑过的其它新配置。文件名只允许单层 CSV，防止 manifest 误写出配置目录。
apply_persisted_config() {
  local target="$1"
  local manifest="$SHARED/data/balance_csv_files.list"
  [[ -f "$manifest" ]] || return 0
  while IFS= read -r file || [[ -n "$file" ]]; do
    [[ "$file" =~ ^[A-Za-z0-9_.-]+\.csv$ ]] || continue
    [[ -f "$SHARED/config/$file" && -d "$target/config" ]] || continue
    cp -p "$SHARED/config/$file" "$target/config/$file"
  done < "$manifest"
}

PREVIOUS_MODE=legacy
PREVIOUS_PATH="$BASE"
if [[ -L "$CURRENT" ]]; then
  current_link="$(readlink "$CURRENT")"
  if [[ "$current_link" == /* ]]; then
    candidate="$current_link"
  else
    candidate="$(cd "$BASE/$(dirname "$current_link")" 2>/dev/null && pwd -P)/$(basename "$current_link")"
  fi
  if [[ -d "$candidate" ]]; then
    PREVIOUS_MODE=release
    PREVIOUS_PATH="$candidate"
  fi
fi
printf 'PREVIOUS_MODE=%s\nPREVIOUS_PATH=%s\nTARGET_SHA=%s\n' \
  "$PREVIOUS_MODE" "$PREVIOUS_PATH" "$MAIN_SHA" > "$STATE"

TARGET="$RELEASES/$MAIN_SHA"
STAGING="$RELEASES/.staging-$MAIN_SHA-$$"
CREATED_TARGET=0

rollback_on_error() {
  local code=$?
  trap - ERR
  echo "远端发布失败，正在恢复上一个版本……" >&2
  rm -rf "$STAGING"
  restore_previous || true
  [[ "$CREATED_TARGET" == 1 ]] && rm -rf "$TARGET"
  rm -rf "$LOCK"
  exit "$code"
}
trap rollback_on_error ERR

if [[ -d "$TARGET" ]]; then
  if [[ ! -f "$TARGET/.release-commit" ]]; then
    echo "已有 release 缺少提交标记：$TARGET" >&2
    false
  fi
  if [[ "$(<"$TARGET/.release-commit")" != "$MAIN_SHA" ]]; then
    echo "已有 release 提交标记不一致：$TARGET" >&2
    false
  fi
else
  mkdir "$STAGING"
  tar xzf "$ARCHIVE" -C "$STAGING"
  apply_persisted_config "$STAGING"
  ln -s ../../shared/data "$STAGING/data"
  ln -s ../../shared/logs "$STAGING/logs"
  printf '%s\n' "$MAIN_SHA" > "$STAGING/.release-commit"
  (
    cd "$STAGING"
    "$NPM_BIN" ci
    KOW_RELEASE_BRANCH=main KOW_RELEASE_COMMIT="$MAIN_SHA" "$NPM_BIN" run build
  )
  mv "$STAGING" "$TARGET"
  CREATED_TARGET=1
fi

# 目标 release 已存在时也要重新套用最新 GM CSV（例如同一 SHA 重试发布）。
apply_persisted_config "$TARGET"

activate "$TARGET"
trap - ERR
