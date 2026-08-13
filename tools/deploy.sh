#!/usr/bin/env bash
# 提交前真实部署闸门：本地验收 -> 上传候选快照 -> 远端构建 -> PM2 重载
# -> 公网只读冒烟；任一步失败则恢复服务器部署前快照并重载。
set -euo pipefail

DEPLOY_KEY="${DEPLOY_KEY:-$HOME/.ssh/kennysgame.pem}"
DEPLOY_HOST="${DEPLOY_HOST:-ubuntu@101.43.64.22}"
DEPLOY_REMOTE="${DEPLOY_REMOTE:-~/kow}"
DEPLOY_URL="${DEPLOY_URL:-http://101.43.64.22:8080}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKIP_LOCAL=0

if [[ "${1:-}" == "--skip-local" ]]; then
  SKIP_LOCAL=1
elif [[ $# -gt 0 ]]; then
  echo "用法：bash tools/deploy.sh [--skip-local]" >&2
  exit 2
fi

command -v ssh >/dev/null || { echo "缺少 ssh" >&2; exit 1; }
command -v scp >/dev/null || { echo "缺少 scp" >&2; exit 1; }
[[ -f "$DEPLOY_KEY" ]] || { echo "部署密钥不存在：$DEPLOY_KEY" >&2; exit 1; }

if [[ "$SKIP_LOCAL" -eq 0 ]]; then
  echo "==> 本地完整构建、测试与生产冒烟"
  npm run verify:quick
  npm run verify:deploy
fi

DEPLOY_TMP="$(mktemp -d)"
ARCHIVE="$DEPLOY_TMP/deploy.tgz"
REMOTE_ARCHIVE="/tmp/kow-deploy-$$.tgz"
REMOTE_BACKUP="/tmp/kow-rollback-$$.tgz"
SSH_OPTS=(-i "$DEPLOY_KEY" -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=no)

cleanup() {
  rm -rf "$DEPLOY_TMP"
  ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "rm -f '$REMOTE_ARCHIVE' '$REMOTE_BACKUP'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> 打包当前提交候选快照"
tar czf "$ARCHIVE" -C "$ROOT" \
  --exclude=node_modules --exclude=.git --exclude=data --exclude=logs \
  --exclude='packages/*/dist' \
  packages config tools scripts docs .githooks .github \
  package.json package-lock.json ecosystem.config.cjs PROJECT.md README.md CLAUDE.md AGENTS.md CHANGELOG.md

echo "==> 上传候选快照"
scp "${SSH_OPTS[@]}" "$ARCHIVE" "$DEPLOY_HOST:$REMOTE_ARCHIVE"

echo "==> 备份线上代码、构建并重载"
ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" bash -s -- "$DEPLOY_REMOTE" "$REMOTE_ARCHIVE" "$REMOTE_BACKUP" <<'REMOTE_SCRIPT'
set -euo pipefail
REMOTE="$1"
ARCHIVE="$2"
BACKUP="$3"
cd "$REMOTE"

# 只备份发布会覆盖的代码和配置；data / logs 永不进入归档，避免碰正式存档。
BACKUP_ITEMS=()
for item in packages config tools scripts docs .githooks .github \
  package.json package-lock.json ecosystem.config.cjs PROJECT.md README.md CLAUDE.md AGENTS.md CHANGELOG.md; do
  [[ -e "$item" ]] && BACKUP_ITEMS+=("$item")
done
tar czf "$BACKUP" "${BACKUP_ITEMS[@]}"

clear_release_files() {
  rm -rf packages config tools scripts docs .githooks .github
  rm -f package.json package-lock.json ecosystem.config.cjs PROJECT.md README.md CLAUDE.md AGENTS.md CHANGELOG.md
}

rollback() {
  code=$?
  trap - ERR
  echo "远端发布失败，正在恢复部署前快照……" >&2
  clear_release_files
  tar xzf "$BACKUP" -C "$REMOTE"
  npm ci
  npm run build
  pm2 reload kow --update-env
  exit "$code"
}
trap rollback ERR

clear_release_files
tar xzf "$ARCHIVE" -C "$REMOTE"
npm ci
npm run build
pm2 reload kow --update-env
sleep 2
curl --fail --silent --show-error http://127.0.0.1:8080/health >/dev/null
trap - ERR
REMOTE_SCRIPT

rollback_remote() {
  echo "==> 公网验收失败，恢复线上部署前快照" >&2
  ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" bash -s -- "$DEPLOY_REMOTE" "$REMOTE_BACKUP" <<'ROLLBACK_SCRIPT'
set -euo pipefail
REMOTE="$1"
BACKUP="$2"
cd "$REMOTE"
rm -rf packages config tools scripts docs .githooks .github
rm -f package.json package-lock.json ecosystem.config.cjs PROJECT.md README.md CLAUDE.md AGENTS.md CHANGELOG.md
tar xzf "$BACKUP" -C "$REMOTE"
npm ci
npm run build
pm2 reload kow --update-env
sleep 2
curl --fail --silent --show-error http://127.0.0.1:8080/health >/dev/null
ROLLBACK_SCRIPT
}

echo "==> 从公网验收前端、健康接口与 WebSocket"
if ! node "$ROOT/scripts/deploy-smoke.mjs" --url "$DEPLOY_URL"; then
  rollback_remote
  exit 1
fi

echo "✔ 部署与公网验收通过：$DEPLOY_URL"
