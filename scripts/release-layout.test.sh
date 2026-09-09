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
STATE3="$TEST_ROOT/state3"
STATE4="$TEST_ROOT/state4"
STATE5="$TEST_ROOT/state5"
STATE6="$TEST_ROOT/state6"
PM2_LOG="$TEST_ROOT/pm2.log"
FAKE_PM2="$TEST_ROOT/fake-pm2"
VALIDATOR_LOG="$TEST_ROOT/validator.log"
FAKE_VALIDATOR="$TEST_ROOT/fake-validator"
MEMINFO="$TEST_ROOT/meminfo"
LOW_MEMINFO="$TEST_ROOT/low-meminfo"
SHA1=1111111111111111111111111111111111111111
SHA2=2222222222222222222222222222222222222222
SHA3=3333333333333333333333333333333333333333
SHA4=4444444444444444444444444444444444444444
SHA5=5555555555555555555555555555555555555555
trap 'rm -rf "$TEST_ROOT"' EXIT

mkdir -p "$BASE/.git" "$BASE/data" "$BASE/logs" "$BASE/shared/data" "$BASE/shared/config" "$FIXTURE/config" "$FIXTURE/packages/server/dist/infra" "$FIXTURE/scripts"
BASE="$(cd "$BASE" && pwd -P)"
printf 'legacy-save' > "$BASE/data/game.json"
printf 'legacy-balance' > "$BASE/data/balance_overrides.json"
printf 'legacy-log' > "$BASE/logs/out.log"
printf 'legacy-config' > "$BASE/ecosystem.config.cjs"
printf "module.exports = { apps: [{ name: 'kow' }, { name: 'kow-test-01' }] };\n" > "$FIXTURE/ecosystem.config.cjs"
printf 'id,code\n1,main\n2,git-only\n' > "$FIXTURE/config/buildings.csv"
# 发布布局测试不需要重复加载完整游戏配置；这里提供一个最小迁移入口，
# 真实迁移逻辑由 server 的 config-authority 单测覆盖。测试仍会验证发布器
# 在启动前强制要求并调用这个编译产物，避免漏打包导致半套发布。
printf 'process.exit(0);\n' > "$FIXTURE/packages/server/dist/infra/config-authority.js"
cp "$ROOT/scripts/merge-persisted-config.mjs" "$FIXTURE/scripts/merge-persisted-config.mjs"
# 模拟 GM 已保存的共享 CSV：后续 release 必须以它覆盖仓库默认值。
printf 'buildings.csv\n' > "$BASE/shared/data/balance_csv_files.list"
printf 'id,code\n1,gm-main\n3,gm-added\n' > "$BASE/shared/config/buildings.csv"
printf '{"version":1,"tables":{"buildings.csv":[["2"]]}}\n' > "$BASE/shared/config/config_row_tombstones.json"
COPYFILE_DISABLE=1 tar czf "$ARCHIVE" -C "$FIXTURE" ecosystem.config.cjs config packages scripts
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "$KOW_TEST_PM2_LOG"\n' > "$FAKE_PM2"
chmod +x "$FAKE_PM2"
export KOW_TEST_PM2_LOG="$PM2_LOG"
printf '#!/bin/sh\nprintf "%%s\\n" "$1" >> "$KOW_TEST_VALIDATOR_LOG"\ngrep -Fq "1,invalid-final" "$1/buildings.csv" && exit 1\ngrep -Fq "1,gm-main" "$1/buildings.csv"\n' > "$FAKE_VALIDATOR"
chmod +x "$FAKE_VALIDATOR"
export KOW_TEST_VALIDATOR_LOG="$VALIDATOR_LOG"
printf 'MemAvailable:    2097152 kB\nSwapFree:        2097152 kB\n' > "$MEMINFO"
printf 'MemAvailable:       1024 kB\nSwapFree:               0 kB\n' > "$LOW_MEMINFO"

run_helper() {
  KOW_DEPLOY_NPM_BIN=true \
  KOW_DEPLOY_PM2_BIN="$FAKE_PM2" \
  KOW_DEPLOY_CURL_BIN=true \
  KOW_DEPLOY_CONFIG_VALIDATOR="$FAKE_VALIDATOR" \
  KOW_DEPLOY_MEMINFO_PATH="${KOW_DEPLOY_MEMINFO_PATH:-$MEMINFO}" \
  KOW_DEPLOY_HEALTH_DELAY=0 \
    bash "$ROOT/tools/remote-release.sh" "$@"
}

# 不把 run_helper 直接放进 if 条件；Bash 会把该条件上下文传进函数并抑制
# 子脚本的 errexit/ERR trap，无法模拟 deploy.sh 的真实直接调用方式。
expect_deploy_failure() {
  local status
  set +e
  run_helper "$@"
  status=$?
  set -e
  if [[ "$status" == 0 ]]; then
    echo '预期发布失败，实际却成功' >&2
    exit 1
  fi
}

run_helper deploy "$BASE" "$STATE1" "$ARCHIVE" "$SHA1"
[[ "$(<"$BASE/shared/data/game.json")" == legacy-save ]]
[[ "$(<"$BASE/shared/data/balance_overrides.json")" == legacy-balance ]]
[[ "$(<"$BASE/releases/$SHA1/.release-commit")" == "$SHA1" ]]
[[ "$(readlink "$BASE/current")" == "$BASE/releases/$SHA1" ]]
grep -Fxq '1,gm-main' "$BASE/releases/$SHA1/config/buildings.csv"
grep -Fxq '3,gm-added' "$BASE/releases/$SHA1/config/buildings.csv"
! grep -Fq '2,git-only' "$BASE/releases/$SHA1/config/buildings.csv"
grep -Fxq 'delete kow' "$PM2_LOG"
grep -Fxq 'delete kow-test-01' "$PM2_LOG"
grep -Fq "start $BASE/current/ecosystem.config.cjs --only kow --update-env" "$PM2_LOG"
grep -Fq "start $BASE/current/ecosystem.config.cjs --only kow-test-01 --update-env" "$PM2_LOG"

run_helper finalize "$BASE" "$STATE1"
[[ ! -d "$BASE/.git" ]]
find "$BASE/backups" -maxdepth 1 -type d -name 'legacy-git-*' | grep -q .

# 最终共享配置校验失败发生在激活前：current 和 PM2 必须保持不变，坏 release/锁被清理。
pm2_lines_before="$(wc -l < "$PM2_LOG")"
printf 'id,code\n1,invalid-final\n' > "$BASE/shared/config/buildings.csv"
expect_deploy_failure deploy "$BASE" "$STATE4" "$ARCHIVE" "$SHA4"
[[ "$(readlink "$BASE/current")" == "$BASE/releases/$SHA1" ]]
[[ "$(wc -l < "$PM2_LOG")" == "$pm2_lines_before" ]]
[[ ! -d "$BASE/releases/$SHA4" ]]
[[ ! -e "$BASE/.deploy-lock" ]]

# 当前 SHA 重发也必须在隔离候选目录合并/校验，失败不能改写活动 release。
expect_deploy_failure deploy "$BASE" "$STATE6" "$ARCHIVE" "$SHA1"
grep -Fxq '1,gm-main' "$BASE/releases/$SHA1/config/buildings.csv"
[[ "$(readlink "$BASE/current")" == "$BASE/releases/$SHA1" ]]
[[ "$(wc -l < "$PM2_LOG")" == "$pm2_lines_before" ]]
[[ ! -e "$BASE/.deploy-lock" ]]
printf 'id,code\n1,gm-main\n3,gm-added\n' > "$BASE/shared/config/buildings.csv"

# 可用内存和 Swap 同时不足时，必须在创建发布锁和触碰 current/PM2 前拒绝构建。
KOW_DEPLOY_MEMINFO_PATH="$LOW_MEMINFO" expect_deploy_failure deploy "$BASE" "$STATE5" "$ARCHIVE" "$SHA5"
[[ "$(readlink "$BASE/current")" == "$BASE/releases/$SHA1" ]]
[[ "$(wc -l < "$PM2_LOG")" == "$pm2_lines_before" ]]
[[ ! -e "$BASE/.deploy-lock" ]]

# 旧存档已经在 shared/ 时，后续迁移仍须补齐缺失的 GM 覆盖文件。
rm -f "$BASE/shared/data/balance_overrides.json"
printf 'legacy-balance-v2' > "$BASE/data/balance_overrides.json"
run_helper deploy "$BASE" "$STATE2" "$ARCHIVE" "$SHA2"
[[ "$(readlink "$BASE/current")" == "$BASE/releases/$SHA2" ]]
grep -Fxq '1,gm-main' "$BASE/releases/$SHA2/config/buildings.csv"
[[ "$(<"$BASE/shared/data/balance_overrides.json")" == legacy-balance-v2 ]]
run_helper finalize "$BASE" "$STATE2"

# active 覆盖存在时不得被旧目录覆盖，避免回退到历史调参。
printf 'active-balance' > "$BASE/shared/data/balance_overrides.json"
printf 'legacy-balance-v3' > "$BASE/data/balance_overrides.json"
run_helper deploy "$BASE" "$STATE3" "$ARCHIVE" "$SHA3"
[[ "$(<"$BASE/shared/data/balance_overrides.json")" == active-balance ]]
run_helper rollback "$BASE" "$STATE3"
[[ "$(readlink "$BASE/current")" == "$BASE/releases/$SHA2" ]]
run_helper rollback "$BASE" "$STATE2"
[[ "$(readlink "$BASE/current")" == "$BASE/releases/$SHA1" ]]
[[ ! -e "$BASE/.deploy-lock" ]]

echo '✔ release 布局迁移、原子切换和回滚测试通过'
