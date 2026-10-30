#!/bin/sh
# Build the Ubuntu rootfs the app ships: base system + official Node + harness.
#
# Produces build/rootfs-ubuntu/, which assemble_payload.sh then finishes off.
# One-time job, roughly:
#   ubuntu-base  30 MB   https://cdimage.ubuntu.com/ubuntu-base/
#   guest tools  ~120 MB the payload's own apt packages (git, sshd, tmux, …)
#   node tarball 30 MB   https://nodejs.org/dist/
#   npm install  ~500 MB unpacked, trimmed to ~150 MB later
#
# Note on --libc: this script is usually run on a musl host (Alpine), and npm
# otherwise picks optional dependencies for the *host* libc. The guest is glibc,
# so the target platform has to be stated explicitly or sharp/require-builtin
# land in their musl variants and fail at runtime.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
BUILD="$ROOT/build"
ROOTFS="$BUILD/rootfs-ubuntu"
UBUNTU_VERSION="${UBUNTU_VERSION:-24.04.5}"
NODE_VERSION="${NODE_VERSION:-22.23.2}"

mkdir -p "$BUILD"

echo "== ubuntu-base $UBUNTU_VERSION =="
if [ ! -d "$ROOTFS" ]; then
  curl -fL --retry 5 -o "$BUILD/ubuntu-base.tar.gz" \
    "https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-${UBUNTU_VERSION}-base-arm64.tar.gz"
  mkdir -p "$ROOTFS"
  tar xzf "$BUILD/ubuntu-base.tar.gz" -C "$ROOTFS"
fi
echo "   $(du -sh "$ROOTFS" | cut -f1)"

echo "== official node $NODE_VERSION =="
if [ ! -x "$ROOTFS/usr/local/bin/node" ]; then
  curl -fL --retry 5 -o "$BUILD/node-arm64.tar.xz" \
    "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz"
  xz -t "$BUILD/node-arm64.tar.xz"          # a truncated download is otherwise silent
  tar xJf "$BUILD/node-arm64.tar.xz" -C "$ROOTFS/usr/local" --strip-components=1
fi
# Ship without the 64 MB of C headers: node-gyp fetches its own when needed.
rm -rf "$ROOTFS/usr/local/include"

# Guest packages the payload promises: the agent's own tools (git/curl/python3/tmux/htop)
# plus openssh-server, which recovery mode needs (see docs/RECOVERY.md).
#
# This step used to be missing from the repository — it was done by hand once, so the
# t2 payload has these tools while a fresh `prepare_rootfs.sh` produces a rootfs
# without them. That is invisible until something needs sshd… which is exactly what
# recovery mode is. It is checked, not assumed: after the install the binaries must
# exist, or the build fails here instead of shipping a payload that cannot be
# recovered.
echo "== guest tools =="
GUEST_PACKAGES="git curl ca-certificates python3 tmux htop openssh-server iproute2 less vim-tiny procps"
# PRoot 只翻译系统调用和路径，**不模拟指令集**：rootfs 里是 arm64 二进制。
# 三条路，按"能不能真的执行 rootfs 里的东西"来选，都不行就交给下面的硬校验去失败：
#
#   1) chroot —— 沙箱里（fake-root）和 CI 上（sudo chroot + binfmt）都能用，首选
#   2) proot CLI —— 需要一个**能在本机执行**的 proot；注意仓库里那份
#      build/proot/libproot.so 是给 Android 用的 bionic 二进制（App 当 native library 打包），
#      在这里执行会 "required file not found"，所以默认不用它，要用就设 PROOT_CLI=<路径>
#   3) 都不行 —— 不装，让校验失败并打印手工命令
#
# 另外：仓库若放在 /sdcard 这类 FUSE 挂载上，文件**没有可执行位**（chmod 也改不了），
# 构建必须落在 app 私有存储 —— 否则上面两条路都不会成立。
HOST_ARCH=$(uname -m)
GUEST_MISSING=""
for t in usr/bin/git usr/bin/curl usr/bin/python3 usr/bin/tmux usr/sbin/sshd; do
  [ -e "$ROOTFS/$t" ] || GUEST_MISSING="$GUEST_MISSING $(basename "$t")"
done
GUEST_PACKAGES="git curl ca-certificates python3 tmux htop openssh-server iproute2 less vim-tiny procps"
APT_CMD="apt-get update -qq && apt-get install -y --no-install-recommends $GUEST_PACKAGES"
PROOT_CLI="${PROOT_CLI:-}"

# chroot 要 root：沙箱里 uid 就是 0，CI 的 runner 是普通用户但 sudo 免密。
# 少了这个前缀，普通 chroot 直接 EPERM，脚本会安静地掉进下面的"装不了"分支
# （2026-10-16 第 3 次 CI 就是这么挂的：一切正常，只有这一步缺 sudo）。
SUDO=""
if [ "$(id -u)" != "0" ] && command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  SUDO="sudo"
fi

CHROOT_OK=0
CHROOT_ERR=""
if [ -n "$GUEST_MISSING" ]; then
  if CHROOT_ERR=$($SUDO chroot "$ROOTFS" /bin/true 2>&1); then
    CHROOT_OK=1
  fi
fi

if [ -z "$GUEST_MISSING" ]; then
  echo "   已经都在（git/curl/python3/tmux/sshd），跳过安装"
elif [ "$CHROOT_OK" = "1" ]; then
  echo "   经 ${SUDO:+sudo }chroot 安装：$GUEST_PACKAGES"
  # resolv.conf 在 ubuntu-base 里可能是悬空软链 → 直接 cp 写不进去，先删再拷。
  [ -s "$ROOTFS/etc/resolv.conf" ] || {
    rm -f "$ROOTFS/etc/resolv.conf"
    cp /etc/resolv.conf "$ROOTFS/etc/resolv.conf" 2>/dev/null || true
  }
  # ubuntu-base 里没有 /tmp、也不带设备节点：apt-key 写不了 /tmp/apt.conf.XXXX 就会
  # 把仓库判成"未签名"（第 4 次 CI 的失败原因），sshd 的 postinst 还要 /dev/urandom。
  mkdir -p "$ROOTFS/tmp" "$ROOTFS/dev" "$ROOTFS/proc"
  chmod 1777 "$ROOTFS/tmp"
  $SUDO mount --bind /dev "$ROOTFS/dev" 2>/dev/null || true
  $SUDO mount -t proc proc "$ROOTFS/proc" 2>/dev/null || true
  # 装包期间别启服务（这个 rootfs 的 sshd 由 start-dsh.sh / 恢复模式自己拉），装完拿掉。
  POLICY_ADDED=0
  if [ ! -e "$ROOTFS/usr/sbin/policy-rc.d" ]; then
    printf '#!/bin/sh\nexit 101\n' > "$ROOTFS/usr/sbin/policy-rc.d"
    chmod +x "$ROOTFS/usr/sbin/policy-rc.d"
    POLICY_ADDED=1
  fi
  $SUDO chroot "$ROOTFS" /usr/bin/env -i \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    DEBIAN_FRONTEND=noninteractive HOME=/root \
    /bin/sh -c "$APT_CMD" 2>&1 | tail -5 || echo "   ! apt 失败（下面按结果判断）"
  $SUDO umount "$ROOTFS/proc" 2>/dev/null || true
  $SUDO umount "$ROOTFS/dev" 2>/dev/null || true
  if [ "$POLICY_ADDED" = "1" ]; then rm -f "$ROOTFS/usr/sbin/policy-rc.d"; fi
elif [ -n "$PROOT_CLI" ] && [ -x "$PROOT_CLI" ]; then
  echo "   经 proot 安装（$PROOT_CLI）：$GUEST_PACKAGES"
  PROOT_TMP_DIR="${TMPDIR:-/tmp}/proot-build" "$PROOT_CLI" -0 -r "$ROOTFS" \
    -b /dev -b /proc -b /sys -b /etc/resolv.conf -w /root \
    /usr/bin/env -i \
      PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      DEBIAN_FRONTEND=noninteractive HOME=/root \
      /bin/sh -c "$APT_CMD" 2>&1 | tail -5 || echo "   ! apt 失败（下面按结果判断）"
else
  echo "   ! 装不了 guest 工具（缺：$GUEST_MISSING）—— ${SUDO:+sudo }chroot 不可用，也没设 PROOT_CLI。"
  echo "     chroot 报错：${CHROOT_ERR:-（无输出；sudo 不可用？）}"
  echo "     原因通常是：rootfs 在 /sdcard 这类 FUSE 上（没有可执行位），"
  echo "     或主机是 $HOST_ARCH 且没注册 binfmt（CI 见 docker/setup-qemu-action）。"
  echo "     手工装（在 app 私有存储里）："
  echo "       ${SUDO:+sudo }chroot $ROOTFS /bin/sh -c \"$APT_CMD\""
fi

# 打包是以 runner（非 root）身份跑的：apt 在 chroot 里以 root 建的目录（/etc/ssl/private、
# var/lib/apt/lists/partial …）是 700 root，读不了就 EACCES —— 第 5 次 CI 正是死在收尾那行 du。
# 从缓存恢复的树同理。这里统一把属主改回当前用户；权限位保持不动（载荷 zip 只存模式，不存属主）。
if [ -n "$SUDO" ]; then
  $SUDO chown -R "$(id -u):$(id -g)" "$ROOTFS" 2>/dev/null || true
fi

# apt 在 rootfs 里留下两坨纯构建垃圾，不清就会原样进载荷：
#   /var/cache/apt/archives  装 guest 工具时下载的 .deb（~120 MB）
#   /var/lib/apt/lists       索引文件（几十 MB）
# 第 8 次 CI 的载荷 398 MB / 全量 APK 389 MiB 就是这么来的（t2 只有 186 MiB）。
# partial 目录按 apt 的习惯留 0700；载荷 zip 只存模式，属主由 App 解包时决定。
rm -rf "$ROOTFS/var/cache/apt/archives" "$ROOTFS/var/lib/apt/lists"
mkdir -p "$ROOTFS/var/cache/apt/archives/partial" "$ROOTFS/var/lib/apt/lists/partial"
chmod 700 "$ROOTFS/var/cache/apt/archives/partial" "$ROOTFS/var/lib/apt/lists/partial"

# 手册 / INFO / 包文档也不是运行时（~8 MB 未压缩）。copyright 留着 —— 那是许可证信息。
find "$ROOTFS/usr/share/doc" -mindepth 2 -maxdepth 2 ! -name copyright -exec rm -rf {} + 2>/dev/null || true
rm -rf "$ROOTFS/usr/share/man" "$ROOTFS/usr/share/info"

for tool in usr/bin/git usr/bin/curl usr/bin/python3 usr/bin/tmux usr/sbin/sshd; do
  if [ ! -e "$ROOTFS/$tool" ]; then
    echo "error: 载荷缺 $tool —— guest 工具没装上（apt 那步失败？）" >&2
    echo "       recovery mode 需要 sshd；git/curl/python3 是 agent 的常用工具。" >&2
    echo "       手工装：proot -0 -r $ROOTFS -b /dev -b /proc -b /sys \\" >&2
    echo "                 /usr/bin/env -i PATH=/usr/bin:/bin apt-get install -y $GUEST_PACKAGES" >&2
    exit 1
  fi
done
echo "   ✓ git / curl / python3 / tmux / sshd 都在"

echo "== harness =="
mkdir -p "$ROOTFS/opt/dsh"
[ -f "$ROOTFS/opt/dsh/package.json" ] || cat > "$ROOTFS/opt/dsh/package.json" <<'EOF'
{ "name": "dsh-sandbox", "private": true, "version": "1.0.0" }
EOF
cd "$ROOTFS/opt/dsh"
HOME="${TMPDIR:-/tmp}/npmhome" npm i --no-audit --no-fund \
  --os=linux --cpu=arm64 --libc=glibc \
  "@deepseek-ai/dsh@${DSH_VERSION:-0.2.0-rc.2}" \
  @xterm/xterm@5.5.0 @xterm/addon-fit@0.10.0 @xterm/addon-canvas@0.7.0

# The stock node binary carries debug sections; stripping is worth ~18 MB and
# changes nothing at runtime.
strip --strip-all "$ROOTFS/usr/local/bin/node" 2>/dev/null || true

echo "== trim runtime (node_modules) =="
# Source maps, .d.ts, TS sources, docs and test trees are not runtime, and this tree
# carries ~120 MB of them (plus sharp's wasm/musl halves). Nothing package.json
# promises is ever removed — the script fails the build if it would.
sh "$ROOT/scripts/trim_runtime.sh" "$ROOTFS/opt/dsh/node_modules"

echo "== done =="
du -sh "$ROOTFS" "$ROOTFS/opt/dsh/node_modules" 2>/dev/null || true
echo "next: sh scripts/assemble_payload.sh"
