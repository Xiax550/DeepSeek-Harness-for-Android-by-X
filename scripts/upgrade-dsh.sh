#!/bin/sh
# upgrade-dsh.sh — 在沙箱里升级 dsh（@deepseek-ai/dsh），走恢复模式，失败可回滚。
#
# 为什么不能直接升级：正在跑的 harness 就是这个沙箱里的 node 进程，替换它的
# node_modules 等于把正在工作的东西抽走 —— 当前会话（以及任何正在跑的 agent 轮次）
# 会当场断掉，而且断在一个"升级到一半"的树上。所以升级必须在 harness **不在运行**
# 的时候做，而那个状态就是恢复模式：不加载 harness，只有一个 shell。
#
# 用法（在沙箱里的 shell 里跑：恢复模式的手机内控制台 / SSH / 普通模式的终端都行）：
#
#   sh upgrade-dsh.sh                       # 默认升级到 0.2.0-rc.2
#   sh upgrade-dsh.sh --version=0.2.0-rc.1  # 指定版本
#   sh upgrade-dsh.sh --bundle=DIR|TGZ      # 用预下载好的树，完全不联网（见下）
#   sh upgrade-dsh.sh --tools=DIR           # 从哪儿取 apply-hardlink-patch.py 等附属脚本
#   sh upgrade-dsh.sh --dry-run             # 只做检查，不动任何东西
#   sh upgrade-dsh.sh rec                   # 回滚到最近一次备份
#   sh upgrade-dsh.sh rec -y                # 回滚，不问
#
# 离线升级：$HOME/.dsh-upgrade/bundle-<版本>/（目录，里面有 node_modules）或
# bundle-<版本>.tar.gz（根下就是 node_modules）存在时，脚本跳过 npm，直接把那棵树换上去 ——
# 恢复模式里就不需要网络，手机信号不稳时这是最稳的路子。没有预下载包时退回 `npm i`。
#
# 它自己分两个阶段，靠一个"待办标记"衔接，所以同一条命令可以重复运行：
#
#   阶段 A（harness 在跑）：检查 → 把工具复制到 $HOME/.dsh-upgrade/ → 写下待办标记
#                           → 调用控制桥的 /recovery/start 进入恢复模式。
#                           这个进程会随沙箱重启一起消失，这是预期的。
#   阶段 B（harness 没在跑，也就是恢复模式里）：备份 → npm 安装 → 重新打硬链接补丁
#                           → 校验（版本、入口、CLI 参数、补丁）→ 市场冒烟
#                           → 成功就退出恢复模式；失败就自动回滚。
#
# 三个"必须做对"的点，脚本会逐条检查并在失败时回滚：
#
#   1. 硬链接补丁：Android 不给应用进程 link() 权限（docs/FINDINGS.md §1），
#      上游的 publish 路径因此会留下悬空软链。载荷里的树是打过补丁的，新装的树不是 ——
#      必须对 patches/apply-hardlink-patch.py 重新打一遍，而且它匹配不上时会拒绝。
#   2. Node 版本：市场（dshmarket）带 undici@7、harness 带 undici@8，上游 #861 在
#      Node 24 + DSH 0.2.0-rc.2 上复现了"加载市场后宿主模型调用全挂"。这个发行版停在
#      Node 22.x，所以脚本只校验 Node 主版本、**不动 node 二进制**。
#   3. start-dsh.sh 依赖的 CLI 参数面：`web --no-open --host --port --trusted-host`。
#      新版本少了任何一个，harness 就起不来 —— 与其等下一次启动失败，不如在这里挡下。
#
# 退出码：0 成功；1 失败（已回滚，除非 --keep-broken）；2 用法/环境问题；3 需要在恢复模式里跑。
set -eu

VERSION_DEFAULT="0.2.0-rc.2"
DSH_INSTALL="${DSH_INSTALL:-/opt/dsh}"
STATE_DIR="${DSH_UPGRADE_DIR:-$HOME/.dsh-upgrade}"
BACKUP_DIR="${DSH_BACKUP_DIR:-/opt/dsh-backups}"
LOG="$STATE_DIR/upgrade.log"
PENDING="$STATE_DIR/pending"
NODE_BIN="${NODE_BIN:-/usr/local/bin/node}"
NPM_BIN="${NPM_BIN:-/usr/local/bin/npm}"
REQUIRED_NODE_MAJOR=22
MIN_FREE_MB=900

MODE=upgrade
VERSION=""
DRY=0
ASSUME_YES=0
SKIP_SMOKE=0
KEEP_BROKEN=0
FORCE=0
STAY=0
BUNDLE=""
TOOLS_DIR="${DSH_UPGRADE_TOOLS:-}"

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    rec|--rollback) MODE=rollback ;;
    --version=*) VERSION="${arg#--version=}" ;;
    --dry-run) DRY=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    --skip-smoke) SKIP_SMOKE=1 ;;
    --keep-broken) KEEP_BROKEN=1 ;;
    --force) FORCE=1 ;;
    --stay) STAY=1 ;;
    --bundle=*) BUNDLE="${arg#--bundle=}" ;;
    --tools=*) TOOLS_DIR="${arg#--tools=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "upgrade-dsh: 未知参数 $arg（--help 看用法）" >&2; exit 2 ;;
  esac
done
[ -n "$VERSION" ] || VERSION="$VERSION_DEFAULT"

mkdir -p "$STATE_DIR" "$BACKUP_DIR"
: >> "$LOG"
log() { printf '%s\n' "$*"; printf '%s\n' "$*" >> "$LOG"; }
die() { log "✗ $*"; exit "${2:-1}"; }

# --------------------------------------------------------------------- helpers

harness_live() {
  # 端口能连上就算活着（比扫进程表更贴近"能不能用"）
  if "$NODE_BIN" -e '
      const net = require("net");
      const s = net.connect(Number(process.env.DSH_PORT || 3080), "127.0.0.1");
      s.on("connect", () => { s.destroy(); process.exit(0); });
      s.on("error", () => process.exit(1));
      setTimeout(() => process.exit(1), 1500);
    ' >/dev/null 2>&1; then
    return 0
  fi
  # 端口没应答但进程还在（正在启动/卡住）：也算"在跑"，不能动树
  for dir in /proc/[0-9]*; do
    [ -r "$dir/cmdline" ] || continue
    if tr '\0' ' ' < "$dir/cmdline" 2>/dev/null | grep -q "@deepseek-ai/dsh/lib/bin.js"; then
      return 0
    fi
  done
  return 1
}

installed_version() {
  "$NODE_BIN" -p "require('$DSH_INSTALL/node_modules/@deepseek-ai/dsh/package.json').version" 2>/dev/null || echo "?"
}

free_mb() {
  df -Pm "$DSH_INSTALL" 2>/dev/null | awk 'NR==2 {print $4}' || echo 0
}

# 现在是不是恢复模式？**由应用说的算**。
#
# 端口/进程探针不够用：上一次恢复模式退出时留下过一个孤儿 harness 仍占着 3080，
# 探针因此判定"harness 在跑"，于是用户明明站在恢复模式的终端里，脚本却走了阶段 A
# （那次还顺手把自己卡在工具复制上）。桥的 /recovery/status 是权威信号。
#   0 = 是恢复模式（走阶段 B）  1 = 不是（harness 那条路）  2 = 桥不可用，说不清
recovery_active() {
  out=$(bridge /recovery/status 2>/dev/null || true)
  case "$out" in
    *'"active":true'*|*'"active": true'*) return 0 ;;
    *'"active":false'*|*'"active": false'*) return 1 ;;
  esac
  return 2
}

bridge() {
  # 用应用注入的环境变量调控制桥。恢复模式下这个环境同样存在（ServerBus 每次都注入）。
  url="${DSH_ANDROID_BRIDGE_URL:-}"; token="${DSH_ANDROID_BRIDGE_TOKEN:-}"
  [ -n "$url" ] && [ -n "$token" ] || { echo "no-bridge"; return 1; }
  "$NODE_BIN" -e '
    const [url, token, path] = process.argv.slice(1);
    fetch(url + path, { method: "POST", headers: { "X-Dsh-Token": token } })
      .then(r => r.text()).then(t => { console.log(t); process.exit(0); })
      .catch(e => { console.error(String(e.message)); process.exit(1); });
  ' "$url" "$token" "$1"
}

# ------------------------------------------------------------- 工具自安装
# 恢复模式里手机存储不一定挂着，所以脚本、补丁、冒烟脚本都先复制进 $HOME（bind mount，
# 跨重启存活）。阶段 B 只依赖 $STATE_DIR。
install_tools() {
  here=$(cd "$(dirname "$0")" && pwd)
  state_abs=$(cd "$STATE_DIR" && pwd)

  # 把自己放进状态目录（恢复模式里手机存储不一定挂着）。**从状态目录重跑时**源和目标
  # 是同一个文件，cp 会报 "are the same file" 并返回非 0 —— 第一次就是栽在这里：
  # 用户照说明在恢复模式里跑了 $STATE_DIR 下那份，脚本却因此判定"工具复制失败"。
  if [ "$here" != "$state_abs" ]; then
    cp -f "$0" "$STATE_DIR/upgrade-dsh.sh" || return 1
  fi
  chmod +x "$STATE_DIR/upgrade-dsh.sh" 2>/dev/null || true

  # 两个附属脚本：状态目录里已经有的就直接用；否则从仓库（脚本住在 scripts/ 下）
  # 或 --tools= 指定的目录补齐。
  for rel in "patches/apply-hardlink-patch.py" "scripts/smoke-market-llm.sh"; do
    name=$(basename "$rel")
    [ -f "$STATE_DIR/$name" ] && continue
    for candidate in "$here/../$rel" "$here/$rel" "${TOOLS_DIR:-/nonexistent}/$name"; do
      if [ -f "$candidate" ]; then
        cp -f "$candidate" "$STATE_DIR/$name"
        log "  · 从 $candidate 复制 $name"
        break
      fi
    done
  done

  # 补丁是硬性依赖：没有它，新树会留下悬空软链（FINDINGS §1），所以宁可停下来。
  # 冒烟脚本缺了只是少一道闸，警告即可。
  if [ ! -f "$STATE_DIR/apply-hardlink-patch.py" ]; then
    log "  ✗ 缺 apply-hardlink-patch.py（必须有）。补上再跑："
    log "      cp <仓库>/patches/apply-hardlink-patch.py $STATE_DIR/"
    return 1
  fi
  [ -f "$STATE_DIR/smoke-market-llm.sh" ] || log "  ! 没有 smoke-market-llm.sh —— 冒烟会被跳过"
  return 0
}

# ------------------------------------------------------------------ 校验
verify_tree() {
  # 1) 版本
  got=$(installed_version)
  [ "$got" = "$VERSION" ] || { log "  ✗ 版本不对：期望 $VERSION，实际 $got"; return 1; }
  log "  ✓ 版本 $got"

  # 2) 入口还是 start-dsh.sh exec 的那条
  bin="$DSH_INSTALL/node_modules/@deepseek-ai/dsh/lib/bin.js"
  [ -f "$bin" ] || { log "  ✗ 入口不存在：$bin"; return 1; }
  log "  ✓ 入口 lib/bin.js"

  # 3) CLI 参数面（start-dsh.sh 用的是这四个）
  help_out=$(cd "$DSH_INSTALL" && timeout 90 "$NODE_BIN" "$bin" web --help 2>&1 || true)
  for flag in --host --port --no-open --trusted-host; do
    if printf '%s' "$help_out" | grep -q -- "$flag"; then
      log "  ✓ web 仍支持 $flag"
    else
      log "  ✗ web 不再支持 $flag —— start-dsh.sh 会起不来"
      printf '%s\n' "$help_out" | head -20 >> "$LOG"
      return 1
    fi
  done

  # 4) 硬链接补丁真的落上了（四个发布点都带标志）
  marker="LINK_UNSUPPORTED_CODES"
  for rel in \
      @deepseek-ai/dsh-fs-local/lib/index.js \
      @deepseek-ai/dsh-session-persistence-jsonl/lib/index.js \
      @deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs \
      @deepseek-ai/dsh-attachment-local/lib/index.js; do
    f="$DSH_INSTALL/node_modules/$rel"
    [ -f "$f" ] || { log "  ✗ 缺文件 $rel"; return 1; }
    grep -q "$marker" "$f" || { log "  ✗ $rel 没有硬链接补丁"; return 1; }
  done
  log "  ✓ 四个发布点都带硬链接补丁"
  return 0
}

smoke() {
  [ "$SKIP_SMOKE" = "1" ] && { log "  · 跳过市场冒烟（--skip-smoke）"; return 0; }
  script="$STATE_DIR/smoke-market-llm.sh"
  [ -f "$script" ] || { log "  ! 没有冒烟脚本，跳过"; return 0; }
  cred="${CRED:-$HOME/.dsh/.credentials.yaml}"
  [ -f "$cred" ] || { log "  ! 没有凭据 $cred，跳过冒烟"; return 0; }
  log "  · 跑市场冒烟（一次真实模型调用，约 10 秒）…"
  if DSH_INSTALL="$DSH_INSTALL" CRED="$cred" \
     PAYLOAD_NM="${PAYLOAD_NM:-$HOME/.dsh/profiles/web/node_modules}" \
     sh "$script" >> "$LOG" 2>&1; then
    log "  ✓ 冒烟通过（加载市场后宿主仍能完成模型调用）"
    return 0
  fi
  log "  ✗ 冒烟失败 —— 详见 $LOG"
  tail -25 "$LOG" | sed 's/^/      /'
  return 1
}

# --------------------------------------------------------------- 预下载包

# 可用的预下载包路径（目录或 tar.gz），没有就非 0。
find_bundle() {
  if [ -n "$BUNDLE" ]; then
    if [ -d "$BUNDLE/node_modules" ] || [ -f "$BUNDLE" ]; then
      printf '%s\n' "$BUNDLE"; return 0
    fi
    log "  ! --bundle=$BUNDLE 不存在（要么目录里有 node_modules，要么是 tar.gz）"
    return 1
  fi
  for candidate in "$STATE_DIR/bundle-$VERSION" "$STATE_DIR/bundle-$VERSION.tar.gz"; do
    if [ -e "$candidate" ]; then printf '%s\n' "$candidate"; return 0; fi
  done
  return 1
}

# 换上预下载的树。旧树先挪开而不是删：备份 + 旧树 + 新树都在，任何一步出错都能退回去。
install_from_bundle() {
  src="$1"; work="$src"
  if [ ! -d "$src/node_modules" ]; then
    unpack="$STATE_DIR/unpack-$$"
    rm -rf "$unpack"; mkdir -p "$unpack"
    log "  · 解压预下载包 $src"
    tar xzf "$src" -C "$unpack" >> "$LOG" 2>&1 || { log "  ✗ 解压失败"; return 1; }
    found=$(find "$unpack" -maxdepth 3 -type d -name node_modules | head -1 || true)
    [ -n "$found" ] || { log "  ✗ 包里找不到 node_modules"; return 1; }
    work=$(dirname "$found")
  fi
  log "  · 用预下载的树替换 node_modules（不联网）：$work"
  stamp=$(date +%Y%m%d-%H%M%S)
  mv "$DSH_INSTALL/node_modules" "$DSH_INSTALL/node_modules.replaced-$stamp"
  log "  旧树挪到 node_modules.replaced-$stamp"
  cp -a "$work/node_modules" "$DSH_INSTALL/node_modules" || return 1
  for f in package.json package-lock.json; do
    [ -f "$work/$f" ] && cp -a "$work/$f" "$DSH_INSTALL/$f"
  done
  return 0
}

# ------------------------------------------------------------------ 备份/回滚

new_backup() {
  stamp=$(date +%Y%m%d-%H%M%S)
  dest="$BACKUP_DIR/$stamp-$(installed_version)"
  mkdir -p "$dest"
  log "  · 备份 node_modules → $dest（约 $(du -sh "$DSH_INSTALL/node_modules" 2>/dev/null | cut -f1)）"
  cp -a "$DSH_INSTALL/node_modules" "$dest/node_modules"
  for f in package.json package-lock.json; do
    [ -f "$DSH_INSTALL/$f" ] && cp -a "$DSH_INSTALL/$f" "$dest/$f"
  done
  printf 'version=%s\nbacked_up_at=%s\n' "$(installed_version)" "$(date -Iseconds)" > "$dest/meta.txt"
  echo "$dest" > "$STATE_DIR/last-backup"
  return 0
}

latest_backup() {
  [ -f "$STATE_DIR/last-backup" ] && [ -d "$(cat "$STATE_DIR/last-backup")" ] && {
    cat "$STATE_DIR/last-backup"; return 0; }
  ls -1d "$BACKUP_DIR"/*/ 2>/dev/null | sort | tail -1 | sed 's:/$::'
}

do_rollback() {
  backup=$(latest_backup || true)
  [ -n "${backup:-}" ] && [ -d "$backup/node_modules" ] || die "找不到可用的备份（$BACKUP_DIR）" 2
  log "== 回滚 =="
  log "  从 $backup 恢复（备份时的版本：$(sed -n 's/^version=//p' "$backup/meta.txt" 2>/dev/null))"
  if [ "$DRY" = "1" ]; then
    log "  --dry-run：只报告，不动"
    return 0
  fi
  stamp=$(date +%Y%m%d-%H%M%S)
  broken="$DSH_INSTALL/node_modules.broken-$stamp"
  mv "$DSH_INSTALL/node_modules" "$broken"
  log "  把当前这棵树挪到 $broken（确认没问题后可以删）"
  cp -a "$backup/node_modules" "$DSH_INSTALL/node_modules"
  for f in package.json package-lock.json; do
    [ -f "$backup/$f" ] && cp -a "$backup/$f" "$DSH_INSTALL/$f"
  done
  VERSION=$(sed -n 's/^version=//p' "$backup/meta.txt" 2>/dev/null || true)
  [ -n "$VERSION" ] || VERSION=$(installed_version)
  verify_tree || die "回滚后的树也没通过校验 —— 需要人工介入（$LOG）" 1
  rm -f "$PENDING" "$STATE_DIR/last-backup"
  log "✓ 已回滚到 $VERSION"
  log "  回应用里点「退出恢复模式」就会用这个版本重新启动 harness"
}

# ------------------------------------------------------------------- 阶段 A

phase_a() {
  log "== 阶段 A：harness 正在运行 =="
  log "  当前版本 $(installed_version)，目标 $VERSION"
  log "  检查：Node 主版本必须是 $REQUIRED_NODE_MAJOR（市场 undici@7 与宿主 undici@8 的冲突）"
  major=$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')
  [ "$major" = "$REQUIRED_NODE_MAJOR" ] || die "Node 是 $major.x，本发行版停在 $REQUIRED_NODE_MAJOR.x —— 先别升级" 2
  log "  ✓ Node $(node -v 2>/dev/null || echo v$major)"
  free=$(free_mb)
  log "  ✓ 可用空间 ${free}MB（备份 + 新树需要约 ${MIN_FREE_MB}MB）"
  [ "$free" -ge "$MIN_FREE_MB" ] || die "空间不够：只有 ${free}MB" 2
  log "  · 确认 npm 上有 $VERSION …"
  if "$NPM_BIN" view "@deepseek-ai/dsh@$VERSION" version >> "$LOG" 2>&1; then
    log "  ✓ npm 上有这个版本"
  else
    die "npm 上查不到 @deepseek-ai/dsh@$VERSION（或网络不通）" 2
  fi
  install_tools || die "工具复制失败" 2

  printf 'version=%s\nrequested_at=%s\nfrom=%s\n' \
    "$VERSION" "$(date -Iseconds)" "$(installed_version)" > "$PENDING"
  log "  ✓ 已写下待办标记：$PENDING"

  if [ "$DRY" = "1" ]; then
    log "  --dry-run：不做下面这些，到此为止"
    return 0
  fi

  log ""
  log "  接下来会进入恢复模式（harness 会停，当前会话会断）。恢复模式里再跑一次同一条命令。"
  log "  手机上的路径是：设置 → 安卓沙箱 → 面板 →「进入恢复模式」，或者我来调桥。"
  log "  恢复模式里要跑的命令："
  log "      sh $STATE_DIR/upgrade-dsh.sh"
  log "  失败想回滚："
  log "      sh $STATE_DIR/upgrade-dsh.sh rec"
  log ""
  if [ "$ASSUME_YES" != "1" ]; then
    printf '  现在进入恢复模式？[y/N] '
    read -r answer || answer=""
    case "$answer" in y|Y|yes|YES) ;; *) log "  已取消（树没有动）"; return 0 ;; esac
  fi
  if bridge /recovery/start >/dev/null 2>&1; then
    log "  已请求应用进入恢复模式…（这个 shell 马上会随沙箱重启断开）"
  else
    log "  调不到控制桥（没有 DSH_ANDROID_BRIDGE_URL/TOKEN）—— 请手动进入恢复模式："
    log "      应用右上角 ≡ →「进入恢复模式」，然后在新终端里跑 sh $STATE_DIR/upgrade-dsh.sh"
  fi
  return 0
}

# ------------------------------------------------------------------- 阶段 B

phase_b() {
  log "== 阶段 B：harness 没在运行（恢复模式）=="
  if [ -f "$PENDING" ]; then
    VERSION=$(sed -n 's/^version=//p' "$PENDING" | head -1)
    log "  待办标记：升级到 $VERSION（$(sed -n 's/^requested_at=//p' "$PENDING") 写入）"
  else
    log "  没有待办标记，按参数/默认版本处理：$VERSION"
  fi
  from=$(installed_version)
  log "  当前 $from → 目标 $VERSION"
  [ "$from" = "$VERSION" ] && { log "  已经是目标版本 —— 只做校验"; verify_tree && smoke && finish; return $?; }

  if [ "$DRY" = "1" ]; then
    log "  --dry-run：只报告，不安装"
    return 0
  fi

  free=$(free_mb)
  [ "$free" -ge "$MIN_FREE_MB" ] || die "空间不够：只有 ${free}MB（需要 ${MIN_FREE_MB}MB）" 2

  new_backup

  bundle=$(find_bundle || true)
  if [ -n "${bundle:-}" ]; then
    log "  · 用预下载的包：$bundle（跳过 npm，不需要网络）"
    if install_from_bundle "$bundle"; then
      log "  ✓ 已换上：$(installed_version)"
    else
      log "  ✗ 换预下载的树失败"
      [ "$KEEP_BROKEN" = "1" ] && die "保留现场（--keep-broken），没有回滚" 1
      do_rollback
      exit 1
    fi
  else
    log "  · 没有预下载包，走 npm 安装 @deepseek-ai/dsh@$VERSION（输出写进 $LOG）…"
    log "    想不联网升级：把树放到 $STATE_DIR/bundle-$VERSION/，或用 --bundle=…"
    # 与 prepare_rootfs.sh 同一套平台参数：宿主是 arm64，但要让 npm 按 glibc/arm64 选包
    if ( cd "$DSH_INSTALL" && HOME="$STATE_DIR/npmhome" "$NPM_BIN" i \
          --no-audit --no-fund --os=linux --cpu=arm64 --libc=glibc \
          "@deepseek-ai/dsh@$VERSION" >> "$LOG" 2>&1 ); then
      log "  ✓ 安装完成：$(installed_version)"
    else
      log "  ✗ npm 安装失败，最后 25 行："
      tail -25 "$LOG" | sed 's/^/      /'
      [ "$KEEP_BROKEN" = "1" ] && die "保留现场（--keep-broken），没有回滚" 1
      do_rollback
      exit 1
    fi
  fi

  log "  · 重新打硬链接补丁…"
  if python3 "$STATE_DIR/apply-hardlink-patch.py" "$DSH_INSTALL/node_modules" >> "$LOG" 2>&1; then
    tail -5 "$LOG" | sed 's/^/      /'
  else
    log "  ✗ 补丁失败（上游改了发布路径，脚本拒绝静默放过）—— 最后 10 行："
    tail -10 "$LOG" | sed 's/^/      /'
    [ "$KEEP_BROKEN" = "1" ] && die "保留现场（--keep-broken），没有回滚" 1
    do_rollback
    exit 1
  fi

  if ! verify_tree; then
    [ "$KEEP_BROKEN" = "1" ] && die "校验失败，保留现场（--keep-broken）" 1
    do_rollback
    exit 1
  fi
  if ! smoke; then
    [ "$KEEP_BROKEN" = "1" ] && die "冒烟失败，保留现场（--keep-broken）" 1
    do_rollback
    exit 1
  fi
  finish
}

finish() {
  rm -f "$PENDING"
  log "✓ 升级到 $VERSION 完成（备份在 $(sed -n 's|.*|&|p' "$STATE_DIR/last-backup" 2>/dev/null)）"
  log "  回滚：sh $STATE_DIR/upgrade-dsh.sh rec"
  if [ "$STAY" = "1" ]; then
    log "  --stay：留在恢复模式。回应用点「退出恢复模式」即可用新版本启动 harness"
    return 0
  fi
  if bridge /recovery/stop >/dev/null 2>&1; then
    log "  已请求退出恢复模式 —— 沙箱会重启，harness 用新版本起来"
  else
    log "  请回应用点「退出恢复模式」（这一版会在启动时自动补齐 profile）"
  fi
}

# ---------------------------------------------------------------------- main

log ""
log "=== upgrade-dsh $(date -Iseconds) mode=$MODE version=$VERSION dry=$DRY ==="

if [ "$MODE" = "rollback" ]; then
  do_rollback
  exit 0
fi

recovery=0
recovery_active || recovery=$?
if [ "$recovery" = "0" ]; then
  log "  桥说现在处于恢复模式 → 直接走阶段 B"
  if harness_live; then
    log "  （注意：另有一个孤儿 harness 还在跑。离线换树是把旧树整棵挪开，"
    log "    所以它握着的 inode 不受影响 —— 升级完最好重启一次应用。）"
  fi
  phase_b
  exit 0
fi
[ "$recovery" = "2" ] && log "  ! 桥不可用，只能靠端口/进程判断"

if harness_live && [ "$FORCE" != "1" ]; then
  phase_a
  exit 0
fi

if harness_live && [ "$FORCE" = "1" ]; then
  log "  --force：harness 还在运行，仍然继续 —— 当前会话会断，树可能停在半路。"
fi

phase_b
exit 0
