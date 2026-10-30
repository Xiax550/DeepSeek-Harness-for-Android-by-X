#!/bin/sh
# 发布前冒烟：**加载了插件市场之后，宿主还能不能完成一次真实模型调用**。
#
# 为什么需要它：上游 #861 报告 `dshmarket` 把 `undici@7` 带进宿主进程后，与宿主的
# `undici@8` 争用全局 dispatcher 符号，导致**宿主自己的**模型对话全部失败
# （症状：`TRANSPORT` / `Connection error` / `could not reach .../models`）。
# 那是"加载即破坏宿主"的灾难级回归，且与本发行版预装市场的形态一致。
# 本脚本用一次真实模型调用把它挡住：启用市场前正常、启用后仍必须正常。
#
# 用法（在仓库根目录）：
#     sh scripts/smoke-market-llm.sh
# 可覆盖的变量：
#     DSH_INSTALL   dsh 安装根（默认 /opt/dsh）
#     CRED          凭据文件（默认 /root/.dsh/.credentials.yaml）
#     PAYLOAD_NM    payload 里 profile 的 node_modules（默认 payload/home/.dsh/profiles/web/node_modules）
#     TASK          冒烟用的任务文本（默认「只回答两个字：正常」）
#
# 退出码：0 = 两组都通过；非 0 = 失败（打印原始输出与原因）。
# 注意：本脚本**不联网安装任何东西**，只拷贝 payload 里已 vendor 的包；凭据只放在临时目录里，退出时删除。

set -eu

DSH_INSTALL=${DSH_INSTALL:-/opt/dsh}
CRED=${CRED:-/root/.dsh/.credentials.yaml}
PAYLOAD_NM=${PAYLOAD_NM:-payload/home/.dsh/profiles/web/node_modules}
TASK=${TASK:-只回答两个字：正常}
PROFILE=smoke-market
BIN=$DSH_INSTALL/node_modules/@deepseek-ai/dsh/lib/bin.js

[ -f "$BIN" ] || { echo "找不到 dsh：$BIN" >&2; exit 2; }
[ -f "$CRED" ] || { echo "找不到凭据：$CRED（设 CRED=… 指定）" >&2; exit 2; }
[ -d "$PAYLOAD_NM/dshmarket" ] || { echo "payload 里没有 vendor 的 dshmarket：$PAYLOAD_NM" >&2; exit 2; }

WORK=$(mktemp -d)
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

mkdir -p "$WORK/home/.dsh"
cp "$CRED" "$WORK/home/.dsh/.credentials.yaml"
chmod 600 "$WORK/home/.dsh/.credentials.yaml"

run_task() {
    # $1 = 标签；$2 = 非空时从 shipped headless 模板初始化 profile（仅第一次需要）
    # stdout 存 $WORK/$1.out，stderr 存 $WORK/$1.err
    if [ -n "${2:-}" ]; then
        timeout 240 env DSH_HOME="$WORK/home/.dsh" node "$BIN" --profile "$PROFILE" --from-default-profile headless "$TASK" \
            > "$WORK/$1.out" 2> "$WORK/$1.err" || true
    else
        timeout 240 env DSH_HOME="$WORK/home/.dsh" node "$BIN" --profile "$PROFILE" "$TASK" \
            > "$WORK/$1.out" 2> "$WORK/$1.err" || true
    fi
}

verdict() {
    # $1 = 标签；返回 0 表示"这次调用成功且没有传输类报错"
    if grep -qE 'TRANSPORT|transport failed|Connection error|could not reach' "$WORK/$1.err" "$WORK/$1.out"; then
        echo "  ✗ $1：出现传输类错误" >&2
        sed -n '1,12p' "$WORK/$1.err" >&2
        return 1
    fi
    if [ ! -s "$WORK/$1.out" ]; then
        echo "  ✗ $1：没有输出（模型调用未成功）" >&2
        sed -n '1,12p' "$WORK/$1.err" >&2
        return 1
    fi
    echo "  ✓ $1：$(tr -d '\n' < "$WORK/$1.out" | cut -c1-60)"
    return 0
}

echo "== 1/2 对照组：纯 headless profile（未加载市场）"
run_task control init
verdict control || { echo "冒烟失败：连对照组都不通，先查网络/凭据/模型配置。" >&2; exit 1; }

echo "== 2/2 实验组：同一 profile 加上 dshmarket（payload 的 vendored 副本）"
PDIR=$WORK/home/.dsh/profiles/$PROFILE
mkdir -p "$PDIR/node_modules"
for p in dshmarket undici js-yaml argparse; do
    [ -d "$PAYLOAD_NM/$p" ] || { echo "payload 缺少依赖：$p" >&2; exit 2; }
    cp -a "$PAYLOAD_NM/$p" "$PDIR/node_modules/$p"
done
node -e '
const fs = require("fs");
const path = process.argv[1];
const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
manifest.dependencies = manifest.dependencies ?? {};
manifest.dependencies.dshmarket = "file:./node_modules/dshmarket";
manifest.dsh = manifest.dsh ?? {};
manifest.dsh.profile = manifest.dsh.profile ?? {};
if (!manifest.dsh.profile.bundles.includes("dshmarket")) manifest.dsh.profile.bundles.push("dshmarket");
fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
' "$PDIR/package.json"

run_task market
verdict market || {
    echo "冒烟失败：加载插件市场后宿主模型调用失败 —— 疑似 undici 7/8 dispatcher 冲突（上游 #861）。" >&2
    echo "临时规避：在 profile patch 里把 - id: dsh-market 设为 disabled: true 并重启。" >&2
    exit 1
}

echo "== 冒烟通过：加载市场前后，宿主都能完成一次真实模型调用。"
