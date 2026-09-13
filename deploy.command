#!/bin/bash
# 双击运行：把本文件夹里的改动发布到 https://lzjleo99-ux.github.io/drawing-decoder/
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"

if [ -z "$(git status --porcelain)" ]; then
  echo "没有改动，无需发布。"
  read -n 1 -s -r -p "按任意键关闭…"; echo
  exit 0
fi

git add -A
git commit -m "Update $(date '+%Y-%m-%d %H:%M')" || exit 1
if git push; then
  echo
  echo "已推送。GitHub Pages 通常 1 分钟内更新："
  echo "https://lzjleo99-ux.github.io/drawing-decoder/"
else
  echo
  echo "推送失败。若提示未登录，在终端运行： ~/.local/bin/gh auth login"
fi
read -n 1 -s -r -p "按任意键关闭…"; echo
