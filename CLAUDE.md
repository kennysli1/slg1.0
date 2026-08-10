# CLAUDE.md — AI 入口（L0）

> 这是 AI 每次进项目**必读且只需先读**的一页。它只做三件事：**前置红线** + **任务路由** + **提交闸门**。
> 项目全貌看 **[PROJECT.md](./PROJECT.md)**（模块清单与文档清单的唯一索引）。
> 详细规矩看 **[docs/00_变更契约.md](./docs/00_变更契约.md)**。

## 这是什么（一句话）

多人在线、服务器权威、实时推进的文字版 SLG 网页游戏（世界之王 / KOW），全栈 TypeScript（npm workspaces monorepo）。

---

## 红线一：四条架构铁律（改任何代码都不能违背）

1. **状态归属唯一**：每块数据只有一个 owner 模块，别人只能通过它的 Command 读/改，**不能直接 import 它的状态**。
2. **跨模块只传 Command/Event**：模块之间不互相 import、不互相调方法。
3. **时间统一走 Scheduler**：禁止模块内 `setTimeout/setInterval`。
4. **派生属性对外只给结果快照**：加成在模块内部叠加，对外只暴露算好的最终值。

自动兜底：ESLint 实时红线（跨模块 import / 模块内定时器）+ `architecture.test.ts` 静态扫描（含 store 集合归属唯一）。原理与案例见 `docs/2_2.0设计/03_架构总览.md`。

## 红线二：变更契约六条（不满足就提交不了）

| | 规矩 | 一句话 |
|---|------|--------|
| R1 | 文档分层与行数预算 | CLAUDE.md ≤120 行、PROJECT.md ≤300 行、docs 参考类 ≤400 行 |
| R2 | 每篇 docs 必须有 front-matter | `class/status/updated/owner/summary`，改正文就改 `updated` |
| R3 | **索引即真相** | 加模块 → 写进 PROJECT.md §四；加文档 → 写进 §五；加 CSV → 写进 `config/README.md` |
| R4 | 规划文档用完即归档 | 功能上线后把结论并入常青文档，原文 `git mv` 到 `docs/archive/` |
| R5 | CHANGELOG 记账 | 改了 `packages/**/src/` 或 `config/*.csv` → 写 `## [未发布]` 条目 |
| R6 | 三个版本号同步 | 协议改了升 `WIRE_VERSION`；落盘结构改了升 `SAVE_SCHEMA_VERSION` 且条目带 `[需刷档]` |

全文（含逃生阀用法）：`docs/00_变更契约.md`。

---

## 任务路由表（按需下钻，别通读全仓）

**先问总闸**：我要加的东西有没有"自己独占的一块状态"（工会成员表 / 邮件箱 / 任务进度）？
**有 → 新建模块文件**（`modules/xxx.ts`，它当 owner）；**没有，只是给旧状态加数值/加成/触发 → 改已有文件**。

| 我要… | 只读这些 | 改这里 |
|-------|---------|--------|
| 改数值 / 加兵种·建筑·PvE | `config/README.md` | `config/*.csv` 加一行，重启后端。**前端不用改**（走服务端 `GetGameConfig` 下发） |
| 加全局常量 / 平衡参数 | `config/README.md` | `config/game_constants.csv` + `infra/config.ts` 的 `GameConstants` 加字段 |
| 加新系统（工会 / 邮件） | `docs/2_2.0设计/07_扩展与代码规范.md`、`03_架构总览.md` | 照 `modules/` 模板加模块 + `static MANIFEST` + `gateway.ts` 登记 + 挂 `app.ts` |
| 改某个系统的逻辑 | PROJECT.md §四 找 owner 模块 | 只改该模块的私有方法，要别人的数据就发 Command |
| 改通信接口 / 加 action | `docs/2_2.0设计/04_通信格式规范.md` | `packages/shared` 信封 + gateway；破坏性改动升 `WIRE_VERSION` |
| 改战斗 / 地图行军 / 建筑 / 人口 | 对应 `docs/2_2.0设计/` 的 08 / 09 / 11 / 13 | 对应 owner 模块 |
| 改存档结构 / 排查存档 | `docs/服务器/01_数据存储结构.md` | 升 `SAVE_SCHEMA_VERSION`，部署带刷档 |
| 刷档 / 重置 / GM 调试 | `docs/服务器/02_数据库操作手册.md`、`03_GM调试手册.md` | `npm run reset:season` / `reset:respawn` / `wipe:all`（自动备份） |
| 第一次读代码 | `docs/2_2.0设计/06_代码导读.md` | — |
| 想知道最近改了什么 | `CHANGELOG.md` | 别去翻 `git log` 猜 |

> 表里没点名的文档就**不要读**。全部活跃文档的一句话摘要在 PROJECT.md §五 和各文件的 front-matter `summary` 里。
> `docs/archive/` 是已上线系统的历史规划，**默认不读**。

---

## 常用命令

```bash
npm install                  # 首次（顺带装好 Git 钩子）
npm run build:shared         # 改过 packages/shared 后必跑
npm run dev:server           # 终端A：后端 :8080（ws: /ws）
npm run dev -w @slg/client   # 终端B：前端 :5173

npm run guard                # 变更契约自查（秒级，随时跑）
npm run lint:all             # 前后端 ESLint（守铁律 #2/#3）
npm run test:server          # 改完逻辑必跑：全循环 + 并发/协议/WAL/架构守卫
npm run verify               # 提交前一键全量（guard + build + lint + typecheck + test + audit）
```

## 提交前（强制）

1. 更新受影响的索引（PROJECT.md §四/§五 或 `config/README.md`）
2. 写 `CHANGELOG.md` 的 `## [未发布]` 条目
3. 该升的版本号升掉（`WIRE_VERSION` / `SAVE_SCHEMA_VERSION`）
4. commit message：`<type>(<scope>): <主题>`，type ∈ feat/fix/docs/refactor/perf/test/chore/config/build/revert
5. `npm run guard` 绿了再提交；`git push` 会自动跑 `verify:quick`

**索引没更新的改动 = 没做完的改动。** 这不是额外工作，是这次改动的一部分。

**部署**：`bash .claude/deploy/deploy.sh`；数据结构变更必须带刷档 `--reset respawn`。细节见 `.claude/deploy/README.md`。
