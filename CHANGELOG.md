# 变更日志

> **想知道"最近发生了什么"，只看这一个文件，不要去翻 `git log` 猜。**
> 记账规矩见 [`docs/00_变更契约.md`](./docs/00_变更契约.md) R5：改了 `packages/**/src/` 或 `config/*.csv` 的提交，
> 必须在 `## [未发布]` 下加条目，否则提交会被 `npm run guard` 拒绝。
>
> 分类固定：`### 新增` / `### 变更` / `### 修复` / `### 移除` / `### 破坏性`。
> 需要刷档的改动，条目开头加 **`[需刷档]`**（同时必须升 `SAVE_SCHEMA_VERSION`）。

## [未发布]

### 新增

- 引入《变更契约》与四道自动闸门：`npm run guard` 校验文档分层/front-matter/索引一致/CHANGELOG 记账/版本号同步，挂到 `pre-commit`、`commit-msg`、`pre-push` 与 GitHub CI
- 新增存档结构版本号 `SAVE_SCHEMA_VERSION`（`packages/server/src/infra/schema-version.ts`），与 CHANGELOG 的刷档声明双向绑定

### 变更

- `CLAUDE.md` 收敛为 L0 入口（红线 + 任务路由表），`PROJECT.md` 成为模块清单与文档清单的唯一索引；`docs/00_README.md` 与 `docs/服务器/README.md` 去掉重复索引改为指路
- 已上线系统的一次性实现规划（建筑重构、人口 v2）归档到 `docs/archive/`，不再占用 AI 的常读预算

### 修复

- 地图拖拽、双指移动或缩放导致主城偏离中心后，方向键中央的回城键会立即启用并可一键重新居中

---

## 更早

0.0.1 之前没有正式发版记录，历史请查 `git log`。从本版本起所有改动都在上面记账。
