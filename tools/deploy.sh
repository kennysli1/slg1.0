#!/usr/bin/env bash
# 生产发布入口：从任意本地分支发起，但内容只取远程 origin/main 的确定提交。
# 远端使用 releases/<sha> + current 原子切换；生产目录不是 Git 工作树。
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
REMOTE_STATE="/tmp/kow-deploy-$$.state"
SSH_OPTS=(-i "$DEPLOY_KEY" -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=no)
DEPLOY_PENDING=0

remote_release() {
  local action="$1"
  shift
  ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" bash -s -- "$action" "$@" < "$WORKTREE/tools/remote-release.sh"
}

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  if [[ "$DEPLOY_PENDING" == 1 && -f "$WORKTREE/tools/remote-release.sh" ]]; then
    echo "==> 发布未完成，恢复上一个生产版本" >&2
    remote_release rollback "$DEPLOY_REMOTE" "$REMOTE_STATE" || true
  fi
  git -C "$ROOT" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  rm -rf "$DEPLOY_TMP"
  ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "rm -f '$REMOTE_ARCHIVE' '$REMOTE_STATE'" >/dev/null 2>&1 || true
  exit "$code"
}
trap cleanup EXIT INT TERM

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
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$ARCHIVE" -C "$WORKTREE" \
  --exclude=node_modules --exclude=.git --exclude=data --exclude=logs \
  --exclude='packages/*/dist' \
  packages config tools scripts docs .githooks .github \
  package.json package-lock.json ecosystem.config.cjs PROJECT.md README.md CLAUDE.md AGENTS.md CHANGELOG.md

echo "==> 上传并构建不可变 release"
scp "${SSH_OPTS[@]}" "$ARCHIVE" "$DEPLOY_HOST:$REMOTE_ARCHIVE"
remote_release deploy "$DEPLOY_REMOTE" "$REMOTE_STATE" "$REMOTE_ARCHIVE" "$MAIN_SHA"
DEPLOY_PENDING=1

echo "==> 验证公网正在运行 origin/main@$MAIN_SHA"
node "$WORKTREE/scripts/deploy-smoke.mjs" --url "$DEPLOY_URL" --expect-commit "$MAIN_SHA"

echo "==> 固化发布并归档旧生产 Git 元数据"
remote_release finalize "$DEPLOY_REMOTE" "$REMOTE_STATE"
DEPLOY_PENDING=0

echo "✔ 生产部署通过：origin/main@$MAIN_SHA → $DEPLOY_URL"
