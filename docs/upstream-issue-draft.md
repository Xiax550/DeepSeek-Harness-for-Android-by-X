# 上游 issue 草案（`dshmarket`）

> **状态：草案，等 Lead 过目后再决定是否提交。不擅自提交。**
> 内容只写事实与可复现步骤，不含我们的内部实现细节。
> 注：总结器那位也在整理一份"可直接发布"的版本；两份以事实为准，提交前请二选一或合并。

**建议标题**

> Panel render errors leave a blank tab with no visible error; `@deepseek-ai/dsh-settings` peer range does not match current releases

## 环境

- `dshmarket` 1.66.21（npm 安装）
- Host：DSH Harness（`web` profile），Node v22，Android/PRoot（aarch64）
- 宿主 harness 里 `@deepseek-ai/dsh-settings` 的版本：`0.1.7-rc.2`

## 1. 面板渲染异常 → 空标签页、零报错（最难排查的一条）

**现象**：市场面板里任何渲染期异常都会让 React 卸载整棵子树：标签页还在、内容全白，控制台里
**没有**可读报错，用户与开发者都无从下手。

**最小复现**：让面板处理的一个字段是对象而不是字符串（见第 2 条），即可稳定触发。

**建议**：在面板根部包一个错误边界，把异常渲染成面板里的一句可读文字（我们这边正是这么绕过去的）。

## 2. `meta.title` / `meta.description` 可能是 `{en, zh}` 对象

**现象**：目录/注册表返回的 `meta.description`（`title` 也可能）是 `{en, zh}` 形态；
直接作为 React child 会抛 `Objects are not valid as a React child`（React error #31），
表现为第 1 条的空白面板。

**建议**：取值时按当前 locale 选择或做一次字符串归一，并在类型上写明它可能是对象。

## 3. 客户端 `inject`：服务名与命名空间是两件事

**现象**：客户端运行时 `inject` 里只声明服务名不够 —— `remote.pluginManager` 这类**命名空间**
也要列进去，否则网关会拒绝该名字；表现为面板能渲染、但**所有按钮都是 disabled**（很难与"权限问题"区分）。

**建议**：文档里写明两者的区别；需要用到某个命名空间时把它一并列进 `inject`，
或改成 `try { ... } catch { 降级提示 }` 的写法。

## 4. `@deepseek-ai/dsh-settings` 的 peer 范围与当前发布不匹配（不阻塞，但会误导）

**现象**：`peerDependencies` 里是
`^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2 || ^0.2.0-rc.1`，而当前可安装的是 `0.1.7-rc.2`。
按 semver 的预发布规则，`0.1.7-rc.2` **不满足**该范围（预发布版本只在同一
`major.minor.patch` 元组内被接纳）。

**实测**：加载不受影响 —— `--dump-config` 无 skipping、启动日志无告警、插件接口全部 200
（`/dsh-market/api/v1/capabilities` 13ms、`/installed` 44ms、`/registry` 1.0s/4.4MB）。
但包管理器与 CI 会报 unsatisfied peer，容易让人以为装错了版本。

**建议**：把范围放宽到覆盖现有 `0.1.x` 发布（例如 `>=0.1.0-rc.7 <0.3.0`），
或在 README 里写明"peer 仅作提示，不影响加载"。

---

## 附：目录源的建议（可选，放在同一条 issue 里）

目录目前有三条来源（站点 + 两条 npm 镜像）。实测：**只封站点时仍能回退 npm 镜像并正常返回**
（约 1.0s / 4.4MB）；**完全断网**时约 27ms 返回 502 与一句列出各源失败原因的可读错误 ——
这个错误信息写得很清楚，值得保持。若能在 README 里列出这三条来源与失败语义，使用者会更好判断。
