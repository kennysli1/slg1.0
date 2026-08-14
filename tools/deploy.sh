#!/usr/bin/env bash
# 生产发布：可从任意本地分支发起，但发布内容永远来自远程 origin/main 的确定提交。
# 当前工作区、未提交内容和功能分支绝不会进入生产包。
set -euo pipefail

DEPLOY_KEY="${DEPLOY_KEY:-$HOME/.ssh/kennysgame.pem}"
DEPLOY_HOST="${DEPLOY_HOST:-ubuntu@101.43.64.22}"
DEPLOY_REMOTE="${DEPLOY_REMOTE:-~/kow}"
DEPLOY_URL="${DEPLOY_URL:-http://101.43.64.22:8080}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ $# -gt 0 ]]; then
  echo "用法：npm run deploy:prod" >&2
  exit 2
fi

for cmd in git ssh scp npm tar; do
  command -v "$cmd" >/dev/null || { echo "缺少命令：$cmd" >&2; exit 1; }
done
[[ -f "$DEPLOY_KEY" ]] || { echo "部署密钥不存在：$DEPLOY_KEY" >&2; exit 1; }

echo "==> 获取远程生产分支 origin/main"
REMOTE_LINE="$(git -C "$ROOT" ls-remote origin refs/heads/main)"
MAIN_SHA="${REMOTE_LINE%%[[:space:]]*}"
[[ "$MAIN_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "无法解析 origin/main 提交：$REMOTE_LINE" >&2; exit 1; }
git -C "$ROOT" fetch --quiet origin main
git -C "$ROOT" cat-file -e "$MAIN_SHA^{commit}"
echo "    production source: origin/main@$MAIN_SHA"

DEPLOY_TMP="$(mktemp -d)"
WORKTREE="$DEPLOY_TMP/main"
ARCHIVE="$DEPLOY_TMP/deploy.tgz"
REMOTE_ARCHIVE="/tmp/kow-deploy-$$.tgz"
REMOTE_BACKUP="/tmp/kow-rollback-$$.tgz"
SSH_OPTS=(-i "$DEPLOY_KEY" -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=no)

cleanup() {
  git -C "$ROOT" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  rm -rf "$DEPLOY_TMP"
  ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "rm -f '$REMOTE_ARCHIVE' '$REMOTE_BACKUP'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> 在隔离 worktree 验证 origin/main"
git -C "$ROOT" worktree add --detach --quiet "$WORKTREE" "$MAIN_SHA"
(
  cd "$WORKTREE"
  npm ci
  npm run guard
  npm run verify:quick
  KOW_RELEASE_BRANCH=main KOW_RELEASE_COMMIT="$MAIN_SHA" npm run verify:deploy
)

echo "==> 打包已验证的 origin/main@$MAIN_SHA"
tar czf "$ARCHIVE" -C "$WORKTREE" \
  --exclude=node_modules --exclude=.git --exclude=data --exclude=logs \
  --exclude='packages/*/dist' \
  packages config tools scripts docs .githooks .github \
  package.json package-lock.json ecosystem.config.cjs PROJECT.md README.md CLAUDE.md AGENTS.md CHANGELOG.md

echo "==> 上传生产包"
scp "${SSH_OPTS[@]}" "$ARCHIVE" "$DEPLOY_HOST:$REMOTE_ARCHIVE"

echo "==> 备份线上代码、构建并重载"
ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" bash -s -- "$DEPLOY_REMOTE" "$REMOTE_ARCHIVE" "$REMOTE_BACKUP" "$MAIN_SHA" <<'REMOTE_SCRIPT'
set -euo pipefail
REMOTE="$1"
ARCHIVE="$2"
BACKUP="$3"
MAIN_SHA="$4"
cd "$REMOTE"

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
KOW_RELEASE_BRANCH=main KOW_RELEASE_COMMIT="$MAIN_SHA" npm run build
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

echo "==> 验证公网正在运行 origin/main@$MAIN_SHA"
if ! node "$WORKTREE/scripts/deploy-smoke.mjs" --url "$DEPLOY_URL" --expect-commit "$MAIN_SHA"; then
  rollback_remote
  exit 1
fi

echo "✔ 生产部署通过：origin/main@$MAIN_SHA → $DEPLOY_URL"
