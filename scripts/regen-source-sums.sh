#!/usr/bin/env bash
# ============================================================================
# regen-source-sums.sh — 重新生成 SOURCE_SHA256SUMS.txt
# ============================================================================
# 为什么需要这个脚本：
#   仓库里那份 SOURCE_SHA256SUMS.txt 没有生成脚本，是手搓出来的，而且是在一个
#   CRLF 工作区里算的 —— 562 条里有 21 条与 git 内容不符（HOT、VERSION、
#   LICENSES/*.txt、app/res/*.xml 等）。见 docs/AUDIT-2026-10-30.md P1-4。
#
# 怎么算才可移植：
#   直接对 **git 索引里的 blob** 取哈希（`git show :<path>`），不读工作区文件。
#   blob 内容是规范化后的（LF），所以无论检出在 Windows 还是 Linux，结果都一样。
#   前提是 .gitattributes 已把文本类型固定为 text eol=lf（本仓库已改）。
#
# 用法：
#   sh scripts/regen-source-sums.sh            # 重新生成并覆盖
#   sh scripts/regen-source-sums.sh --check    # 只校验，不写文件（CI 用）
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT="SOURCE_SHA256SUMS.txt"
MODE="${1:-write}"

work="$(mktemp)"
trap 'rm -f "$work"' EXIT

# git ls-files 输出已按路径排序；-z 避免中文/空格路径被拆词
git ls-files -z | while IFS= read -r -d '' path; do
  # 清单自己不进清单，否则无法自洽
  [ "$path" = "$OUT" ] && continue
  hash="$(git show ":$path" | sha256sum | cut -d' ' -f1)"
  printf '%s  %s\n' "$hash" "$path"
done > "$work"

n="$(wc -l < "$work" | tr -d ' ')"

if [ "$MODE" = "--check" ]; then
  if [ ! -f "$OUT" ]; then
    echo "缺少 $OUT"
    exit 1
  fi
  if diff -q "$work" "$OUT" >/dev/null; then
    echo "OK：$n 条，与 $OUT 一致"
  else
    echo "不一致的条目："
    # 只打印差异路径，避免刷屏
    diff <(awk '{print $2}' "$OUT" | sort) <(awk '{print $2}' "$work" | sort) || true
    echo "内容不符的条目数目：$(diff "$work" "$OUT" | grep -c '^<' || true)"
    echo "跑 sh scripts/regen-source-sums.sh 重新生成"
    exit 1
  fi
  exit 0
fi

mv "$work" "$OUT"
trap - EXIT
echo "写了 $OUT：$n 条"
