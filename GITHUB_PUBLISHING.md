# GitHub 发布说明

这份目录可以作为 DHA 的公开源码仓库。发布前请先阅读本文件、`OPEN_SOURCE_COMPLIANCE.md`
和 `THIRD_PARTY.md`。

## 已整理内容

- 已排除签名密钥、APK、构建目录、临时输出、参考工程和 Python 缓存。
- 保留 Android 源码、插件源码、payload 脚本、构建脚本、测试、许可证文本和第三方声明。
- 构建依赖通过 `docs/BUILD.md`、`scripts/build_apk.ps1` 和 `scripts/build_apk.sh` 说明。
- `app/libs/` 中的预编译依赖保留在源码包内，版本和许可证见 `THIRD_PARTY.md`。
- `payload` 中的运行时依赖保留其必要的许可证和来源说明。
- `DEPENDENCIES.md` 列出主要上游项目、依赖版本、用途、许可证和构建来源；每次二进制发布还应从最终 payload 生成完整 SBOM。

## 发布前必须处理

`libproot.so` 的对应源码已经定位：当前 ELF 与 OpenMinis 官方 `1.13` 安装包中的
PRoot 条目逐字节一致；源码提交、PRoot 子模块、talloc 与构建脚本均固定在
`docs/BUILD-PROOT.md`。发布时用 `scripts/make-proot-source.sh` 生成
`proot-src-8cf13e99.tar.gz` 并附在 Release。

发布时仍应：

1. 发布源码仓库和许可证文件；
2. 附上 PRoot 对应源码归档，并保留 GPL 版权与许可证文本；
3. 不把签名密钥、API Key、设备日志或本地配置上传到 GitHub；
4. 在 Release 页面明确说明当前构建限制。

## 本地检查

```powershell
# JVM 回归测试
javac -version
sh docs/run-unit-tests.sh

# Windows APK 构建（需要本机 Android SDK、JDK、Python 和外部 payload 资产）
pwsh -File scripts\build_apk.ps1 -SkipIcons
```

如果 Windows 执行策略阻止 `.ps1`，请按 `docs/BUILD.md` 中的方式运行脚本。

## GitHub 首次发布建议

```sh
git init
git add .
git diff --cached --check
git commit -m "Initial public DHA source release"
git branch -M main
git remote add origin <your-repository-url>
git push -u origin main
```

不要把 `keystore/`、`build/`、`out/`、`_ref/` 或任何 APK 加入提交。
