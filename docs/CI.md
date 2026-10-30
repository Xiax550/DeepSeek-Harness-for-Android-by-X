# GitHub Actions 与发布

仓库有两个工作流：

| 工作流 | 触发 | 作用 |
|---|---|---|
| `validate` | push、PR、手动 | Shell/Python/YAML 语法、JVM 单测、插件迁移、署名、许可、发布配置和源码哈希 |
| `release-full` | 手动、应用 Release 发布 | 在 GitHub runner 上重建 rootfs、全量 APK、瘦包和热包 |

`validate` 的主任务名是 `validate`，仓库维护者可以把它设为 `main` 的必需状态检查。

## 发布资产

应用 Release 使用版本化文件名：

| 通道 | 文件名 |
|---|---|
| 全量 APK | `DHA-<版本>-arm64.apk` |
| 瘦包 | `DHA-<版本>-slim.apk` |
| 热包 | `DHA-<版本>-hot.zip` |
| 项目源码 | `DHA-<版本>-source.tar.gz` 或 Release 中说明的等价源码归档 |
| 校验和 | `SHA256SUMS.txt` |

`update.json` 必须指向同一套版本化文件名。CI 不会直接提交受保护的 `main`；
打标签前必须先把 `VERSION`、`VERSION_CODE` 和 `update.json` 一起提交。

## 自动补全

GitHub 没有“Release 资产上传完成”事件，因此 `release-full` 使用
`release: published`，由 `scripts/ci_plan.py` 判断：

| Release 资产 | 决定 |
|---|---|
| 已有版本化全量 APK | 跳过构建 |
| 只有 slim 或 hot | 构建全量包并补齐资产 |
| 只有 `payload.zip` 等终端资产 | 跳过 |
| 手动触发 | 总是构建 |

流程图：

```text
Release 发布
  -> plan（有 slim/hot、没有 full）
  -> 下载固定 PRoot
  -> 构建 rootfs + payload
  -> 构建全量和瘦 APK
  -> 校验内置热包
  -> release.sh 上传版本化资产和 SHA256SUMS.txt
  -> 回读 GitHub Release、update.json 和下载 URL
```

## Secrets

Settings → Secrets and variables → Actions：

| 名称 | 内容 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `keystore/dha.p12` 的 base64 |
| `ANDROID_KEYSTORE_PASSWORD` | 签名库口令 |
| `ANDROID_KEY_ALIAS` | 签名别名，当前为 `dha` |

工作流把密钥还原到 `keystore/dha.p12`，并设置 `REQUIRE_KEYSTORE=1`。
如果 Secret 缺失或文件名错误，构建会失败，绝不会自动生成新的应用签名身份。

`keystore/dha.p12`、口令和 API Key 都不得提交到仓库。

## 发布前本地检查

```sh
sh docs/run-unit-tests.sh
python3 docs/release-notes-test.py
python3 docs/release-config-test.py
node docs/author-attribution-test.mjs
node docs/compliance-test.mjs
node docs/repair-profile-test.mjs
node scripts/check-legacy-market-residue.mjs
bash scripts/regen-source-sums.sh --check
```

还要对全部 Shell 文件执行 `bash -n`：

```sh
find . -type f -name '*.sh' -not -path './build/*' -not -path './out/*' \
  -print0 | xargs -0 -n1 bash -n
```

## 限制

- GitHub runner 完整的 APK 构建需要有效签名 Secrets 和约 10–90 分钟。
- `workflow_dispatch` 的 `dry_run` 只跳过发布，仍需要签名 Secrets 才能完成构建。
- Release 指向的 hot/slim 资产如果未发布，应对应版本的更新按钮保持不可用或不显示；
  不要用重定向文件冒充 APK。
