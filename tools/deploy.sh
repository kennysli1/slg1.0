#!/usr/bin/env bash
# 一键部署到腾讯云轻量服务器（绕过服务器连不上 GitHub 的问题）。
# 本地打包源码 -> scp 上传 -> 服务器解压、构建、重启 pm2。
# 用法：bash tools/deploy.sh
set -euo pipefail

KEY=~/.ssh/kennysgame.pem
HOST=ubuntu@101.43.64.22
REMOTE='~/travian2'
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> 打包源码"
tar czf /tmp/deploy.tgz -C "$ROOT" \
  --exclude=node_modules --exclude=.git --exclude=data --exclude=dist \
  packages config tools docs package.json package-lock.json ecosystem.config.cjs PROJECT.md

echo "==> 上传"
scp -i "$KEY" -o StrictHostKeyChecking=no /tmp/deploy.tgz "$HOST:/tmp/deploy.tgz"

echo "==> 解压 + 构建 + 重启"
ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" \
  "cd $REMOTE && tar xzf /tmp/deploy.tgz && npm run build 2>&1 | tail -4 && pm2 restart travian2 2>&1 | tail -2 && echo DEPLOYED"

echo "==> 完成，访问 http://101.43.64.22:8080"
