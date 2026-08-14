#!/usr/bin/env bash
# 不启动真实服务，验证不可变 release 的迁移、切换、回滚和 Git 元数据归档。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
BASE="$TEST_ROOT/kow"
FIXTURE="$TEST_ROOT/fixture"
ARCHIVE="$TEST_ROOT/release.tgz"
STATE1="$TEST_ROOT/state1"
STATE2="$TEST_ROOT/state2"
SHA1=1111111111111111111111111111111111111111
SHA2=2222222222222222222222222222222222222222
trap 'rm -rf "$TEST_ROOT"' EXIT

mkdir -p "$BASE/.git" "$BASE/data" "$BASE/logs" "$FIXTURE"
printf 'legacy-save' > "$BASE/data/game.json"
printf 'legacy-log' > "$BASE/logs/out.log"
printf 'legacy-config' > "$BASE/ecosystem.config.cjs"
printf 'fixture-config' > "$FIXTURE/ecosystem.config.cjs"
COPYFILE_DISABLE=1 tar czf "$ARCHIVE" -C "$FIXTURE" ecosystem.config.cjs

run_helper() {
  KOW_DEPLOY_NPM_BIN=true \
  KOW_DEPLOY_PM2_BIN=true \
  KOW_DEPLOY_CURL_BIN=true \
  KOW_DEPLOY_HEALTH_DELAY=0 \
    bash "$ROOT/tools/remote-release.sh" "$@"
}

run_helper deploy "$BASE" "$STATE1" "$ARCHIVE" "$SHA1"
[[ "$(<"$BASE/shared/data/game.json")" == legacy-save ]]
[[ "$(<"$BASE/releases/$SHA1/.release-commit")" == "$SHA1" ]]
[[ "$(readlink "$BASE/current")" == "$BASE/releases/$SHA1" ]]

run_helper finalize "$BASE" "$STATE1"
[[ ! -d "$BASE/.git" ]]
find "$BASE/backups" -maxdepth 1 -type d -name 'legacy-git-*' | grep -q .

run_helper deploy "$BASE" "$STATE2" "$ARCHIVE" "$SHA2"
[[ "$(readlink "$BASE/current")" == "$BASE/releases/$SHA2" ]]
run_helper rollback "$BASE" "$STATE2"
[[ "$(readlink "$BASE/current")" == "$BASE/releases/$SHA1" ]]
[[ ! -e "$BASE/.deploy-lock" ]]

echo '✔ release 布局迁移、原子切换和回滚测试通过'
