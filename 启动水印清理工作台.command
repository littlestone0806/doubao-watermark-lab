#!/bin/zsh

set -u

PROJECT_DIR="${0:A:h}"

cd "$PROJECT_DIR" || exit 1

# 始终从源码启动，确保后续修改无需重新打包即可生效。
if ! command -v npm >/dev/null 2>&1; then
  echo "未找到 npm，请先安装 Node.js。"
  echo
  read -k 1 "?按任意键关闭窗口..."
  exit 1
fi

if [[ ! -d "$PROJECT_DIR/node_modules/electron" ]]; then
  echo "首次运行，正在安装项目依赖..."
  npm install
  if [[ $? -ne 0 ]]; then
    echo
    echo "依赖安装失败，请检查网络后重试。"
    read -k 1 "?按任意键关闭窗口..."
    exit 1
  fi
fi

exec npm start
