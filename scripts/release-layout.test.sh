#!/usr/bin/env bash
# 不启动真实服务，验证不可变 release 的迁移、切换、回滚和 Git 元数据归档。
set -euo pipefail

# Windows Git Bash 无权创建原生符号链接时，无法忠实模拟 Linux 发布目录的 current 原子切换。
# 正式 deploy:prod 仍会在 Linux 生产机执行该逻辑并进行公网验收；本地跳过避免把权限缺失误报成代码失败。
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    echo '↷ release 布局测试跳过：当前 Windows 环境不具备创建符号链接的权限'
    exit 0
    ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
BASE="$TEST_ROOT/kow"
FIXTURE="$TEST_ROOT/fixture"
ARCHIVE="$TEST_ROOT/release.tgz"
STATE1="$TEST_ROOT/state1"
STATE2="$TEST_ROOT/state2"
PM2_LOG="$TEST_ROOT/pm2.log"
FAKE_PM2="$TEST_ROOT/fake-pm2"
SHA1=1111111111111111111111111111111111111111
SHA2=2222222222222222222222222222222222222222
trap 'rm -rf "$TEST_ROOT"' EXIT

mkdir -p "$BASE/.git" "$BASE/data" "$BASE/logs" "$FIXTURE"
BASE="$(cd "$BASE" && pwd -P)"
printf 'legacy-save' > "$BASE/data/game.json"
printf 'legacy-log' > "$BASE/logs/out.log"
printf 'legacy-config' > "$BASE/ecosystem.config.cjs"
printf 'fixture-config' > "$FIXTURE/ecosystem.config.cjs"
COPYFILE_DISABLE=1 tar czf "$ARCHIVE" -C "$FIXTURE" ecosystem.config.cjs
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "$KOW_TEST_PM2_LOG"\n' > "$FAKE_PM2"
chmod +x "$FAKE_PM2"
export KOW_TEST_PM2_LOG="$PM2_LOG"

run_helper() {
  KOW_DEPLOY_NPM_BIN=true \
  KOW_DEPLOY_PM2_BIN="$FAKE_PM2" \
  KOW_DEPLOY_CURL_BIN=true \
  KOW_DEPLOY_HEALTH_DELAY=0 \
    bash "$ROOT/tools/remote-release.sh" "$@"
}

run_helper deploy "$BASE" "$STATE1" "$ARCHIVE" "$SHA1"
[[ "$(<"$BASE/shared/data/game.json")" == legacy-save ]]
[[ "$(<"$BASE/releases/$SHA1/.release-commit")" == "$SHA1" ]]
[[ "$(readlink "$BASE/current")" == "$BASE/releases/$SHA1" ]]
grep -Fxq 'delete kow' "$PM2_LOG"
grep -Fq "start $BASE/current/ecosystem.config.cjs --only kow --update-env" "$PM2_LOG"

run_helper finalize "$BASE" "$STATE1"
[[ ! -d "$BASE/.git" ]]
find "$BASE/backups" -maxdepth 1 -type d -name 'legacy-git-*' | grep -q .

run_helper deploy "$BASE" "$STATE2" "$ARCHIVE" "$SHA2"
[[ "$(readlink "$BASE/current")" == "$BASE/releases/$SHA2" ]]
run_helper rollback "$BASE" "$STATE2"
[[ "$(readlink "$BASE/current")" == "$BASE/releases/$SHA1" ]]
[[ ! -e "$BASE/.deploy-lock" ]]

echo '✔ release 布局迁移、原子切换和回滚测试通过'
