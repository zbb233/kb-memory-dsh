#!/usr/bin/env bash
# 一键发布 kb-memory-dsh 到 GitHub（需先安装并登录 gh CLI）
set -euo pipefail
cd "$(dirname "$0")"

REPO_NAME="${1:-kb-memory-dsh}"

# 定位 gh：优先 PATH，其次找手动下载解压的那份
if command -v gh >/dev/null 2>&1; then
  GH=$(command -v gh)
elif [ -x "$HOME/gh-install/gh_2.105.0_macOS_arm64/bin/gh" ]; then
  GH="$HOME/gh-install/gh_2.105.0_macOS_arm64/bin/gh"
elif [ -x "/usr/local/bin/gh" ]; then
  GH="/usr/local/bin/gh"
else
  echo "❌ 未找到 GitHub CLI。请先下载并解压："
  echo '   curl -L -o ~/gh.zip "https://github.com/cli/cli/releases/download/v2.105.0/gh_2.105.0_macOS_arm64.zip"'
  echo '   unzip ~/gh.zip -d ~/gh-install'
  exit 1
fi
echo "ℹ️  使用 gh: $GH"

if ! "$GH" auth status >/dev/null 2>&1; then
  echo "❌ gh 尚未登录。请先运行："
  echo "   \"$GH\" auth login"
  echo "（选择 GitHub.com → HTTPS → 用浏览器登录，一路回车即可）"
  exit 1
fi

USER=$("$GH" api user -q .login)
REPO_URL="https://github.com/$USER/$REPO_NAME"

echo "🚀 创建仓库 $USER/$REPO_NAME 并推送..."
"$GH" repo create "$REPO_NAME" --public --source=. --remote=origin --push

echo "🏷️  打版本标签 v0.1.0..."
git tag v0.1.0
git push origin v0.1.0

echo "🔖 添加 dsh-plugin topic..."
"$GH" repo edit "$REPO_NAME" --add-topic dsh-plugin

echo "📝 补写 package.json 的 repository 字段..."
REPO_URL="$REPO_URL" node <<'NODE'
const fs = require('fs')
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'))
p.repository = { type: 'git', url: process.env.REPO_URL }
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n')
NODE

git add package.json
AUTHOR_NAME=$(git config user.name || echo "$USER")
AUTHOR_EMAIL=$(git config user.email || echo "$USER@users.noreply.github.com")
git -c user.name="$AUTHOR_NAME" -c user.email="$AUTHOR_EMAIL" \
  commit -m "chore: add repository field"
git push

echo ""
echo "✅ 全部完成！"
echo "   仓库地址：$REPO_URL"
echo ""
echo "下一步（生成插件索引，可稍后做）："
echo "   echo '$REPO_URL' > /tmp/kb-plugins.txt"
echo "   cd /Users/bo.zhao4/deepseek-harness-agent/harness-src"
echo "   pnpm --filter @deepseek-ai/dsh-plugin-market-generator start \\"
echo "     --input /tmp/kb-plugins.txt --output /tmp/kb-market/index.json --title \"KB plugins\""
echo "   再把 /tmp/kb-market 放到 GitHub Pages 即可通过「发现 → 添加索引源」安装。"
