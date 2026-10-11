#!/usr/bin/env bash
# Codespace 首次创建时执行。两样东西容器基础镜像里没有，但本项目必须有：
#   chromium       —— 生成 PDF 用（puppeteer-core 不自带浏览器）
#   fonts-noto-cjk —— 中文字体。不装的话 PDF 里的中文全是豆腐块 □□□
set -euo pipefail

echo "==> 安装 chromium 与中文字体…"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
  chromium \
  fonts-noto-cjk

echo "==> 安装依赖…"
npm ci

echo "==> 自检…"
"${CHROME_PATH:-/usr/bin/chromium}" --version
fc-list :lang=zh family | head -3
npm test

cat <<'TIP'

────────────────────────────────────────────────
环境就绪。启动：

  npm start

端口 3000 会自动转发，在 PORTS 面板点地球图标打开。
没配 ANTHROPIC_API_KEY 的话先用空跑模式看界面：

  SOLVER_DRY_RUN=1 npm start
────────────────────────────────────────────────
TIP
