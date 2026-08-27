---
class: reference
status: active
updated: 2026-08-28
owner: ops
summary: 配置中心、GM 实时状态、旧覆盖迁移与 GitHub 同步边界
---

# 配置中心与 GM 边界

## 两种数据

| 数据 | 文件/入口 | 生效方式 |
| --- | --- | --- |
| 实时游戏状态 | `shared/data/game.json`、WAL；`/gm` | GM 保存后立即生效，只影响当前存档 |
| 静态游戏配置 | `config/*.csv`；`/config` | 校验、配置 PR、合并、`deploy:prod` 后生效 |

任务也遵循这个边界：任务定义、条件、目标、效果、奖励和对话在配置中心；玩家任务进度、任务营地、倒计时和领取状态在 GM 的实时状态管理中。玩家页面只读取服务端快照。

## 配置中心保存流程

1. 配置中心先把修改应用到隔离副本，运行 `loadGameConfig` 全图校验。
2. 校验通过后写入当前 release 和生产 `shared/config/`，更新 `balance_csv_files.list`。
3. 写入 `config_revision.json`（所有 CSV 的 SHA-256）并把文件列表合并进 `config_sync_outbox.json`。
4. 异步 worker 在短暂防抖后调用 GitHub API，提交 `config-sync/live` 分支并创建/更新配置 PR；没有 `GITHUB_CONFIG_SYNC_TOKEN` 时只保留队列并在 `/config/status` 报错，不阻塞游戏。页面“立即同步 / 重试”调用 `POST /config/sync`，与定时 worker 共用互斥锁，避免重复提交。
5. PR checks 通过后按 `CLAUDE.md` 的顺序合并和运行 `npm run deploy:prod`。发布脚本会在构建和激活前覆盖共享配置，并校验迁移/配置文件，确保服务器、GitHub 和当前 release 使用同一版本。

生产机可把 `GITHUB_CONFIG_SYNC_TOKEN`（以及可选的 repo/API 地址）写入 `shared/config.env`，发布脚本会在 PM2 重启前加载该文件；它不进入 release 压缩包、Git 或日志。没有 token 时仍可运行游戏，管理员可补齐密钥后在配置中心点击重试。

配置中心的“热重载”只表示当前进程重新读取 CSV，不等同于 GitHub 合并或生产发布。发布失败不应手动覆盖 `current`，按部署手册回滚。

## GM 实时状态流程

GM 只允许修改 `game.json/WAL` 所属集合，例如资源、人口、村庄坐标、军队、任务状态和测试重置。GM 操作需要审计，并在页面上标注“立即修改当前存档，不改变 CSV 默认值”。删档/respawn 只处理存档数据，不删除 `shared/config`、配置 revision 或配置 PR。

兼容旧书签的页面 `/gm/balance`、`/gm/quest-modules`、`/gm/quests`、`/gm/dialogues` 会重定向到对应 `/config/*`；旧的配置 data/save API 返回 410。GM 首页不再展示这些入口，新操作统一从 `/config` 进入。

## `balance_overrides.json` 迁移

旧版本的 `balance_overrides.json` 不是运行时事实源。部署升级时先在临时配置目录应用并校验全部旧覆盖，然后复制到 CSV 和 `shared/config/`，记录 revision/同步 outbox，最后把原文件改名为 `balance_overrides.migrated.<时间>.json`。任何未知表、未知行、非法 JSON 或校验失败都会中止发布并保留原文件。迁移后的后端不读取也不写入该文件。

历史上已经从配置表删除的键/字段（例如 `treasure_trade_drop_chance`、旧 `research.effectValue`）不会被错误映射到含义不同的新参数：有效覆盖继续迁移，已删除项只在原始归档中保留并记录原因。未知表、未知行和未知字段仍然硬失败，确保真正的拼写错误或数据丢失不会被静默吞掉。

`config_revision.json`、`config_sync_outbox.json`、`config_sync_status.json` 属于运维元数据，不是平衡参数；它们可以是 JSON，但不能被 GM 当作游戏状态编辑，也不会成为配置覆盖来源。

## 排查优先级

- 页面显示异常但服务器状态正确：先看 `/config/status` 和 `/version` 的 revision，再检查浏览器是否加载了旧 release。
- 重启/删档后数值回退：检查 `shared/config/`、manifest 和 release 日志，不要恢复 `balance_overrides.json`。
- 配置 PR 没出现：检查 `config_sync_outbox.json`、`GITHUB_CONFIG_SYNC_TOKEN` 和服务端日志；可在配置中心重试，不要手动把 CSV 推到 `main`。
- 生产与 GitHub 哈希不一致：停止继续改值，记录当前 release SHA 和 revision，按 Git 协作规范重新生成配置 PR。
