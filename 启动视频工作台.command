#!/bin/bash
# 双击启动视频工作台。第一次运行会自动构建界面。
cd "$(dirname "$0")/app" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/codexwork/toolchains/node-v24.21.0-darwin-arm64/bin:$PATH"
if [ ! -d node_modules ]; then
  echo "首次运行：安装依赖…"
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install --registry=https://registry.npmmirror.com || exit 1
fi
if [ ! -f dist/index.html ] || [ -n "$(find src shared -newer dist/index.html -type f 2>/dev/null | head -1)" ]; then
  echo "构建界面…"
  npx vite build || exit 1
fi
nohup npx electron . >/dev/null 2>&1 &
