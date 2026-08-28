#!/usr/bin/env bash
# 生产发布入口：从任意本地分支发起，但内容只取远程 origin/main 的确定提交。
# 远端使用 releases/<sha> + current 原子切换；生产目录不是 Git 工作树。
set -euo pipefail

# 发布发起机专用的回连 key；可用 DEPLOY_KEY 覆盖，避免依赖已弃用的个人 PEM 文件。
DEPLOY_KEY="${DEPLOY_KEY:-$HOME/.ssh/kow_release_ed25519}"
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
# 配置中心与运维文档提交不应被针对出厂默认值的完整行为测试阻断；
# 只要本次 main 提交没有触及 packages/ 业务代码，就走配置结构校验。
# 一旦提交包含业务代码，仍执行完整 verify:quick。用提交实际 diff 判断，
# 不依赖 squash merge 后可能变化的 commit subject。
RELEASE_PATHS="$(git -C "$ROOT" diff-tree --no-commit-id --name-only -r "$MAIN_SHA")"
CONFIG_SYNC_RELEASE=1
if printf '%s\n' "$RELEASE_PATHS" | grep -q '^packages/'; then
  CONFIG_SYNC_RELEASE=0
fi
if [[ "$CONFIG_SYNC_RELEASE" == 1 ]]; then
  echo "    release kind: configuration/operations (config-specific validation)"
else
  echo "    release kind: code (full validation)"
fi

DEPLOY_TMP="$(mktemp -d)"
WORKTREE="$DEPLOY_TMP/main"
ARCHIVE="$DEPLOY_TMP/deploy.tgz"
REMOTE_ARCHIVE="/tmp/kow-deploy-$$.tgz"
REMOTE_STATE="/tmp/kow-deploy-$$.state"
# 明确使用吞吐型 QoS；部分公网链路会将交互式 SSH QoS 限速到几 KB/s，导致发布包上传长时间停滞。
# Keep long archive uploads alive across brief idle/packet-loss periods on the
# production link.  Without explicit keepalives sshd/NAT may close an active
# legacy-SCP stream before the release can be atomically installed.
SSH_OPTS=(-i "$DEPLOY_KEY" -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=no -o IPQoS=throughput -o ServerAliveInterval=15 -o ServerAliveCountMax=20)
DEPLOY_PENDING=0

# 在耗时的隔离验证前确认发布通道。失败时绝不切换生产 current。
if ! ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" true; then
  echo "无法通过部署密钥连接目标服务器：$DEPLOY_HOST（可用 DEPLOY_KEY 覆盖）" >&2
  exit 1
fi

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
  if [[ "$CONFIG_SYNC_RELEASE" == 1 ]]; then
    npm run build:shared
    npm run lint:all
    npm run typecheck
    npm run verify:config-sync
    npm run test:ops
  else
    npm run verify:quick
  fi
  KOW_RELEASE_BRANCH=main KOW_RELEASE_COMMIT="$MAIN_SHA" npm run verify:deploy
)

echo "==> 打包已验证的 origin/main@$MAIN_SHA"
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$ARCHIVE" -C "$WORKTREE" \
  --exclude=node_modules --exclude=.git --exclude=data --exclude=logs \
  --exclude='packages/*/dist' \
  packages config tools scripts docs .githooks .github \
  package.json package-lock.json ecosystem.config.cjs PROJECT.md README.md CLAUDE.md AGENTS.md CHANGELOG.md

echo "==> 上传并构建不可变 release"
# OpenSSH 新版默认走 SFTP；该服务器链路在 SFTP 大包传输时会在 255KB 窗口后停滞，
# 使用兼容的 legacy SCP 数据通道可保持发布包连续上传。
scp -O "${SSH_OPTS[@]}" "$ARCHIVE" "$DEPLOY_HOST:$REMOTE_ARCHIVE"
remote_release deploy "$DEPLOY_REMOTE" "$REMOTE_STATE" "$REMOTE_ARCHIVE" "$MAIN_SHA"
DEPLOY_PENDING=1

echo "==> 验证公网正在运行 origin/main@$MAIN_SHA"
node "$WORKTREE/scripts/deploy-smoke.mjs" --url "$DEPLOY_URL" --expect-commit "$MAIN_SHA"

echo "==> 固化发布并归档旧生产 Git 元数据"
remote_release finalize "$DEPLOY_REMOTE" "$REMOTE_STATE"
DEPLOY_PENDING=0

echo "✔ 生产部署通过：origin/main@$MAIN_SHA → $DEPLOY_URL"
