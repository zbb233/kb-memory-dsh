#!/usr/bin/env bash
# 续跑：补上 publish.sh 因网络抖动中断的剩余步骤（可安全重复运行）
set -euo pipefail
cd "$(dirname "$0")"

GH=$(command -v gh || echo "/usr/local/bin/gh")
USER_NAME="zbb233"
REPO_NAME="kb-memory-dsh"
REPO_URL="https://github.com/$USER_NAME/$REPO_NAME"

# 0. 让 git 复用 gh 的登录凭据（否则 push 会交互式索要用户名/密码）
echo "🔑 配置 git 使用 gh 凭据..."
"$GH" auth setup-git

# 1. 推送 v0.1.0 标签：切 HTTP/1.1 规避 HTTP2 framing 错误，失败重试 3 次
echo "🏷️  推送标签 v0.1.0（HTTP/1.1 + 重试）..."
for i in 1 2 3; do
  if git -c http.version=HTTP/1.1 push origin v0.1.0; then
    echo "✅ 标签推送成功"
    break
  fi
  echo "⚠️  第 $i 次推送失败，3 秒后重试..."
  sleep 3
  if [ "$i" -eq 3 ]; then
    echo "❌ 标签推送 3 次均失败，请检查网络后重跑本脚本"
    exit 1
  fi
done

# 2. 添加 dsh-plugin topic（幂等，重复执行不会报错）
echo "🔖 添加 dsh-plugin topic..."
"$GH" repo edit "$USER_NAME/$REPO_NAME" --add-topic dsh-plugin

# 3. 补写 package.json 的 repository 字段（幂等）
if grep -q '"repository"' package.json; then
  echo "📝 repository 字段已存在，跳过"
else
  echo "📝 补写 repository 字段..."
  REPO_URL="$REPO_URL" node <<'NODE'
const fs = require('fs')
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'))
p.repository = { type: 'git', url: process.env.REPO_URL }
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n')
NODE
  git add package.json
  AUTHOR_NAME=$(git config user.name || echo "$USER_NAME")
  AUTHOR_EMAIL=$(git config user.email || echo "$USER_NAME@users.noreply.github.com")
  git -c user.name="$AUTHOR_NAME" -c user.email="$AUTHOR_EMAIL" \
    commit -m "chore: add repository field"
  git -c http.version=HTTP/1.1 push
fi

echo ""
echo "✅ 全部完成！"
echo "   仓库：$REPO_URL"
echo "   标签：v0.1.0"
echo "   topic：dsh-plugin"
