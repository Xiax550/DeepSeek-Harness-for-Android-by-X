# PRoot 对应源码与复建

本文记录当前 DHA APK 内 `lib/arm64-v8a/libproot.so` 的精确来源、对应源码、
验证证据和复建方法。

## 1. 当前结论

- DHA 内的 PRoot 为 266,152 B，SHA-256
  `f6b0381ab9a066fa620fef0001737fd3cfaf9d22474f013ac48d7861411374ac`。
- 该文件与 OpenMinis 官方 `1.13` APK 内的
  `lib/arm64-v8a/libproot.so` 逐字节一致；`1.12` 和 `0.22-preview` 中也是同一文件。
- 采用的对应源码是 OpenMinis 应用提交
  `4ef29002e88db1e20e462ec2ff46916e8a7dcb45`（tag `1.13`）。
- 该提交的 PRoot 子模块固定为
  `8cf13e997cdc9472997aae19df8050c073c9a86c`，即
  `https://github.com/OpenMinis/proot/tree/8cf13e997cdc9472997aae19df8050c073c9a86c`。
- 构建脚本是 OpenMinis 应用源码中的 `deps/build_proot.sh`，Git blob
  `5d83e99e3214b95acbf8ac76bb32f290801c493b`。
- talloc 2.4.2 位于同一应用提交的 `deps/talloc/`，Git 树
  `34887cedc4ca8bf0162904d69e46548ebef99000`。
- 许可证为 GPL-2.0-or-later；PRoot 源码内的 `COPYING` 和 APK 内的
  `assets/licenses/GPL-2.0.txt` 均须保留。

上游明确说明不同 NDK 世代不会生成逐字节相同的 ELF。因此，验证对应关系时
需要把“本 ELF 与哪个公开发行物相同”和“该发行物对应的源码提交”绑定，不能期待
源码归档的哈希等于 ELF 哈希。

## 2. 取证方法

从 DHA APK 中提取 PRoot：

```bash
unzip -p DHA-1.2.50-arm64.apk lib/arm64-v8a/libproot.so > /tmp/libproot.so
sha256sum /tmp/libproot.so
```

期望值：

```text
f6b0381ab9a066fa620fef0001737fd3cfaf9d22474f013ac48d7861411374ac
```

从 OpenMinis 官方 `1.13` 发布 APK 中提取同名条目，哈希和大小相同。
二进制中还可看到：

```text
Copyright (C) 2015 STMicroelectronics, licensed under GPL v2 or later.
/Users/ethan/Src/github.com/OpenMinis/MinisApp/deps/talloc/talloc.c
extension/native_offload/native_offload.c
PROOT_USE_LOADER_FOR_QEMU
```

官方发布页：

- <https://github.com/OpenMinis/OpenMinis/releases/tag/1.13>
- <https://github.com/OpenMinis/OpenMinis/tree/4ef29002e88db1e20e462ec2ff46916e8a7dcb45>
- <https://github.com/OpenMinis/OpenMinis/blob/4ef29002e88db1e20e462ec2ff46916e8a7dcb45/deps/build_proot.sh>
- <https://github.com/OpenMinis/proot/tree/8cf13e997cdc9472997aae19df8050c073c9a86c>

## 3. 对应源码归档

发布附件中的 `proot-src-8cf13e99.tar.gz` 由以下命令生成：

```bash
sh scripts/make-proot-source.sh
```

归档包括：

- OpenMinis `4ef29002e88db1e20e462ec2ff46916e8a7dcb45` 中的
  `deps/build_proot.sh` 和 `deps/talloc/`；
- `OpenMinis/proot@8cf13e997cdc9472997aae19df8050c073c9a86c` 的完整源码；
- 一份 `BUILD-INFO.txt`，记录上述固定提交、PRoot ELF 哈希和许可证。

项目源码 Release 归档与这个 PRoot 专用源码归档同时存在，后者不能由前者的
普通 `git archive` 自动包含，因为 PRoot 是 Git 子模块。

## 4. 本地复建

需要 Linux 或 WSL、Android NDK r28+，以及 `git`、`make`、`curl`、`tar`、
`awk` 和 `sed`。

```bash
ANDROID_NDK_HOME=/path/to/android-ndk-r28 \
  sh scripts/build-proot.sh
```

脚本固定使用上述 OpenMinis app 提交和 PRoot 子模块，并在构建前核对子模块
commit。产物写入 `out/libproot.so`，同时生成：

- `out/libproot.so.sha256`
- `out/build-info.txt`
- `out/libproot-loader.so` / `out/libproot-loader32.so`（若上游构建产生）

复建产物不保证与当前 ELF 逐字节相同。若替换当前二进制，必须：

1. 更新 `THIRD_PARTY.md` 和 `DEPENDENCIES.md` 中的新哈希；
2. 保留 `STMicroelectronics` 版权字符串；
3. 在真机确认沙箱可以启动并执行命令；
4. 同时提供新构建对应的源码、NDK 版本和构建记录。

## 5. Loader 说明

当前 DHA APK 只包含 `libproot.so`，不包含额外的 loader 文件。应用保持
`targetSdk 28`，现有执行路径已在 DHA 1.2.50 构建和此前真机测试中使用。
OpenMinis 上游提示：提高 targetSdk 或改变执行目录后，Android 10+ 可能要求
从 `nativeLibraryDir` 启动 loader。届时必须增加真机回归，不能只凭编译成功
判断可用。

## 6. 发布验收

```bash
sha256sum DHA-1.2.50-arm64.apk
unzip -p DHA-1.2.50-arm64.apk lib/arm64-v8a/libproot.so | sha256sum
tar tzf proot-src-8cf13e99.tar.gz | head
```

检查 PRoot 的哈希、源码归档中的 `BUILD-INFO.txt`、GPL 文本以及 Release
附件名称是否一致。
