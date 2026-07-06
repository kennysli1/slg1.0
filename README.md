# 世界之王（King of World / KOW）

一个**多人在线、服务器权威、实时推进**的文字版策略战争网页游戏，全栈 TypeScript 实现。

> 📖 想深入理解整个项目？请读 **[PROJECT.md](./PROJECT.md)** —— 它是理解代码与设计的唯一入口。
> 本 README 只做快速上手。

---

## 这是什么

- **形态**：网页 SLG。建造、训练、行军都按**真实时间**推进，服务器为唯一权威。
- **玩法核心循环**：经济（4 资源产出）→ 训练军队 → 出征打 PvE/PvP → 掠夺 → 带战利品返程。
- **已实现**：账号密码登录（scrypt 加密）、三种族（罗马/高卢/条顿）、地图与坐标、科技树前置依赖、JSON 文件持久化、**重启后恢复在途任务**、多人 + PvP。
- **数值全部 CSV 化**：改游戏平衡只动 `config/*.csv`，用 Excel 打开改完重启即生效，**不碰代码**。

测试覆盖：13 个服务端测试文件，61 项用例，覆盖单人全循环、多人 PvP、持久化、配置校验、manifest 与架构守卫。

---

## 技术栈

| 层 | 选型 |
|----|------|
| 语言 | 全栈 TypeScript（npm workspaces monorepo） |
| 后端 | Node 20 + [Fastify](https://fastify.dev/) 5 + WebSocket（`@fastify/websocket`），用 `tsx` 直接跑 TS 源码 |
| 前端 | 原生 TS + [Vite](https://vitejs.dev/)，WebSocket 通信 |
| 持久化 | JSON 文件（`data/game.json`，零依赖、重启不丢；存储接口已隔离，可换 SQLite/PG） |
| 进程守护 | pm2（`ecosystem.config.cjs`） |

---

## 快速开始（本地开发）

需要 **Node 20+**。

```bash
npm install                      # 首次安装依赖
npm run build:shared             # 改过 packages/shared 后必跑（前后端共享类型）

npm run dev:server               # 终端 A：启动后端，监听 http://localhost:8080  (ws: /ws)
npm run dev -w @slg/client       # 终端 B：启动前端，打开提示的 http://localhost:5173
```

打开前端后注册/登录即可游玩。界面四个标签页：

🏠 村庄 ｜ ⚔️ 军队 ｜ 🗺️ 地图（自己村 / 他人村 / 野怪） ｜ 📜 报告

---

## 常用命令

```bash
npm run build            # 构建 shared + server + client（前端产物到 packages/client/dist）
npm start                # 生产模式启动后端（托管已构建的前端静态文件）
npm run test:server      # 跑后端测试（单人全循环 + 多人 PvP）

npm run reset:season     # 刷档：留账号+地图位置，进度归零（新赛季）
npm run reset:respawn    # 刷档：留登录凭据，重新分配地图位置
npm run wipe:all         # 删档：连账号一起清空（均自动备份到 data/backups/）
```

环境变量（生产）：`PORT`（默认 8080）、`HOST`（默认 0.0.0.0）、`DATA_PATH`（存档路径，默认 `./data/game.json`）。

---

## 目录结构

```
slg1.0/
├── PROJECT.md            ← 项目总入口（先读这个）
├── README.md             ← 本文件（快速上手）
├── package.json          ← monorepo 工作区配置
├── ecosystem.config.cjs  ← pm2 生产进程配置
│
├── config/               ← 【游戏数值】全部 CSV，Excel 可改，改完重启生效
│   ├── README.md             每张表每列的说明 + 速查
│   ├── resources.csv  buildings.csv  town_center_slots.csv  units.csv
│   ├── unit_traits.csv  pve_targets.csv  pve_defenders.csv  pve_spawns.csv
│   └── game_constants.csv  village_templates.csv
│
├── packages/             ← 【代码】
│   ├── shared/               前后端共享：通信信封类型（ESM）
│   ├── server/               后端（infra / modules / gateway）
│   └── client/               前端
│
├── data/                 ← 运行时存档（git 忽略）
├── tools/                ← 部署/工具脚本（deploy.sh、annotate_csv.py、gen_art.py）
└── docs/                 ← 设计文档、规范、部署手册
```

---

## 架构一句话

三层结构，依赖只能从上往下：**接入层 gateway → 领域层 modules → 基础设施 infra**。

四条铁律（详见 `docs/2_2.0设计/03_架构总览.md`）：

1. **状态归属唯一** —— 每块数据只有一个 owner 模块，别人只能通过它的 Command 读写，不能直接 import 它的状态。
2. **跨模块只传 Command/Event** —— 模块之间不互相 import、不互相调方法。
3. **时间统一走 Scheduler** —— 禁止模块内 `setTimeout/setInterval`。
4. **派生属性对外只给结果快照** —— 加成在模块内部叠加，对外只暴露算好的最终值。

通信用两套固定信封（定义在 `packages/shared`）：服务器↔客户端用 `Request/Response/Push`；模块↔模块用 `Command/Event`。

---

## 怎么改

| 我想… | 怎么做 |
|-------|--------|
| 改数值（兵种攻防、建造成本、掉落…） | 改 `config/*.csv` 对应行，重启后端。详见 `config/README.md` |
| 加新内容（新建筑/兵种/PvE 目标） | `config/*.csv` 加一行 |
| 加新系统（工会/邮件等） | 照 `packages/server/src/modules/` 模板加模块，挂到 `app.ts`，gateway 加路由 |
| 改逻辑 | 找到状态 owner 模块改其私有方法，**不要跨模块直接读写**，跑 `npm run test:server` |

> 动代码前请先看 `docs/2_2.0设计/07_扩展与代码规范.md` 的扩展决策树与自查清单。

---

## 部署

生产部署到服务器请按 **`docs/部署手册_腾讯云轻量服务器.md`**（含 pm2 保活、数据备份）。
`tools/deploy.sh` 提供 scp 一键部署（绕过服务器连不上 GitHub 的情况）。

---

## 文档导航

| 文档 | 何时看 |
|------|--------|
| [PROJECT.md](./PROJECT.md) | 第一次接触 / 隔久回来 |
| `docs/00_README.md` | 文档总索引 |
| `docs/2_2.0设计/03_架构总览.md` | 改架构 / 加大功能前 |
| `docs/2_2.0设计/04_通信格式规范.md` | 改通信 / 加接口前 |
| `docs/2_2.0设计/06_代码导读.md` | 第一次读代码 |
| `docs/2_2.0设计/07_扩展与代码规范.md` | 每次加代码前 |
| `docs/服务器/` | 存档结构 / 备份 / 刷档 / 删档 |
| `config/README.md` | 改数值前 |
