# CLAUDE.md

> 本文件是 AI 进入项目的第一站，只做两件事：**把你导向完整文档** + **前置不可违背的红线**。
> 详细的"这是什么 / 怎么改 / 怎么跑"全部在 **[PROJECT.md](./PROJECT.md)**（唯一入口）。动手前请务必读它。

## 这是什么（一句话）

多人在线、服务器权威、实时推进的文字版 Travian 2.0 网页 SLG，全栈 TypeScript（npm workspaces monorepo）。

## 四条架构铁律（改任何代码都不能违背）

1. **状态归属唯一**：每块数据只有一个 owner 模块，别人只能通过它的 Command 读/改，**不能直接 import 它的状态**。
2. **跨模块只传 Command/Event**：模块之间不互相 import、不互相调方法。
3. **时间统一走 Scheduler**：禁止模块内 `setTimeout/setInterval`。
4. **派生属性对外只给结果快照**：加成在模块内部叠加，对外只暴露算好的最终值。

> 原理与扩展案例见 `docs/2_2.0设计/03_架构总览.md`；每次加代码前先读 `docs/2_2.0设计/07_扩展与代码规范.md` 的扩展决策树与自查清单。
>
> **这四条不只是约定，有自动闸门兜底**：写代码时 ESLint 实时红线（跨模块 import / 模块内 setTimeout），提交前 `npm run lint` + `npm run test:server`（含 `test/architecture.test.ts` 静态扫描）会挡住违规。写错不再靠"记得读文档"，而是当场报错。

## 怎么改（速查）

> **动手前先问总闸这一句**：我要加的东西有没有"自己独占的一块状态"（工会成员表 / 邮件箱 / 任务进度）？
> **有 → 新建模块文件**（`modules/xxx.ts`，它当这块状态的 owner）；**没有，只是给旧状态加数值/加成/触发 → 改已有文件**（配置表 / 派生管线 / 流水线插件）。
> 说得出 owner 就加文件，说不出就改文件。展开见 `docs/2_2.0设计/07_扩展与代码规范.md` §二。

| 我想… | 怎么做 |
|-------|--------|
| 改数值 / 加内容（兵种·建筑·PvE 目标） | 只动 `config/*.csv` 加一行或改一行，重启后端。前端无需改（走服务端 `GetGameConfig` 下发）。见 `config/README.md` |
| 加全局常量 / 平衡参数 | 改 `config/game_constants.csv` + 在 `infra/config.ts` 的 `GameConstants` 加字段 |
| 加新系统（工会 / 邮件等） | 照 `packages/server/src/modules/` 模板加模块，给它加 `static MANIFEST`，在 `gateway/gateway.ts` 的 `MODULE_MANIFESTS` 登记，挂到 `app.ts` |
| 改逻辑 | 找到状态 owner 模块（见 PROJECT.md 模块清单）改其私有方法，**不要跨模块直接读写** |
| 刷档 / 重置游戏 | `npm run reset:season`（留账号+位置，进度归零）/ `reset:respawn`（留凭据，重排位置）/ `wipe:all`（连账号清）。均自动备份。见 `docs/服务器/02_数据库操作手册.md` |

## 结构 & 通信

- 三层，依赖只能自上而下：**接入层 `gateway/` → 领域层 `modules/` → 基础设施 `infra/`**。
- 两套固定信封（定义在 `packages/shared`）：服务器↔客户端用 `Request/Response/Push`；模块↔模块用 `Command/Event`。**固定外层信封，自由内层 payload。**

## 常用命令

```bash
npm install                      # 首次
npm run build:shared             # 改过 packages/shared 后必跑（前后端共享类型）
npm run dev:server               # 终端A：后端 :8080（ws: /ws）
npm run dev -w @slg/client       # 终端B：前端 :5173
npm run lint                     # 提交前必跑：ESLint 守铁律#2/#3（跨模块import/模块内定时器）
npm run test:server              # 改完逻辑必跑：单人全循环 + 多人PvP + 持久化 + 配置校验 + 架构守卫
```

**提交前**：跑 `npm run lint` + `npm run test:server`（均须绿），并对照 `docs/2_2.0设计/07_扩展与代码规范.md` 末尾的自查清单。

**部署到服务器**：一键脚本 + 服务器凭据/说明在本地 `.claude/deploy/`（该目录被 gitignore，不上传）。普通更新 `bash .claude/deploy/deploy.sh`；**数据结构变更（坐标/兵种字段/新集合）必须带刷档** `bash .claude/deploy/deploy.sh --reset respawn`。细节读 `.claude/deploy/README.md`。
