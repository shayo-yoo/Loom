# Loom

Loom 是给 SillyTavern 用的扩展框架：它提供扩展注册、权限与同意提示、事件、状态持久化和声明式 UI，让第三方功能以"能力 + 界面"的方式接入，而不是各自直接操作酒馆内部。

## 现在能做什么

- 以声明的能力读写宿主数据：世界书（浏览/编辑/整本导入导出改名）、角色卡字段、聊天消息（追加/编辑/删除）、扩展自有设置与持久状态。
- 扩展按包安装：`extensions/<id>/` 放入目录 → `npm run extensions:index` → 刷新酒馆页面即被装载；也可在面板粘贴模块地址手动安装（跨刷新保留）。面板支持启用/停用、重新加载与移除。
- 小功能用**脚本**：面板里粘贴一个 ES 模块即可运行，不需要目录与清单；脚本有独立身份，刷新后自动恢复。
- 用 `LoomUI` 的 17 个组件搭界面：声明式视图树、键控重排保焦点、受控弹层与标签页。
- 权限先请求后使用：能力声明所需权限，用户在同意提示或面板中授权，授权持久化。

## 目录

```
Loom Core/      运行时：注册表、能力执行、权限、事件、状态、扩展装载
Loom Host/      SillyTavern 适配器：把酒馆数据暴露成能力
Loom UI/        面板与通用界面系统（组件、视图引擎、安装器）
extensions/     扩展包（hello-loom 最小示例、world-book-manager 世界书管理器）
scripts/        扩展索引生成（npm run extensions:index）
tests/browser/  真实浏览器端到端验证
docs/guides/    开发者指南
docs/engineering-governance/  架构、API、变更记录与项目状态
```

## 开发

```bash
npm test                 # 单元测试（无需浏览器）
npm run verify:browser   # 端到端验证（需要酒馆运行在 8100）
npm run extensions:index # 重新生成扩展索引
```

写扩展请从 [docs/guides/writing-an-extension.md](docs/guides/writing-an-extension.md) 开始。
