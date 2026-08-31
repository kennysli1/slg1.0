# 世界之王（King of World / KOW）

一个**多人在线、服务器权威、实时推进**的文字版策略战争网页游戏，全栈 TypeScript 实现。

> 📖 想深入理解整个项目？请读 **[PROJECT.md](./PROJECT.md)** —— 它是理解代码与设计的唯一入口。
> 本 README 只做快速上手。
>
> ⛔ 要提交代码？先读 **[docs/00_变更契约.md](./docs/00_变更契约.md)**（`npm install` 后自动启用本地闸门）。

---

## 这是什么

- **形态**：网页 SLG。建造、训练、行军都按**真实时间**推进，服务器为唯一权威。
- **玩法核心循环**：经济（5 资源：wood/clay/iron/crop/**gold**）→ 训练军队 / 雇佣兵 / 科研 → 出征打 PvE/PvP → 掠夺 → 返程。
- **已实现**：账号密码登录（scrypt 加密）、三种族（罗马/高卢/条顿）、六边形地图、科技树、雇佣兵营地、贸易中心、JSON 文件持久化（**重启后恢复在途任务**）、多人 + PvP、GM 平衡调参面板。
- **数值全部 CSV 化**：改游戏平衡只动 `config/*.csv`，用 Excel 打开改完重启即生效，**不碰代码**。

测试覆盖由 `packages/server/src/test/all.test.ts` 汇总，`barrel.test.ts` 自动守卫登记完整性；范围包括单人全循环、多人 PvP、贸易/雇佣兵/科研、GM 路由、推送契约、人口、持久化、配置校验、manifest 与架构守卫。

---

## 技术栈

| 层 | 选型 |
|----|------|
| 语言 | 全栈 TypeScript（npm workspaces monorepo） |
| 后端 | Node 20 + [Fastify](https://fastify.dev/) 5 + WebSocket（`@fastify/websocket`），用 `tsx` 直接跑 TS 源码 |
| 前端 | Preact + `@preact/signals` + Vite，WebSocket 通信 |
| 持久化 | JSON 文件（`data/game.json`，零依赖、重启不丢；存储接口已隔离，可换 SQLite/PG） |
| 进程守护 | pm2（`ecosystem.config.cjs`） |

---

## 快速开始（本地开发）

需要 **Node 20+**。

```bash
npm install                      # 首次安装依赖
npm run build:shared             # 改过 packages/shared 后必跑（前后端共享类型）

npm run dev:server               # 终端 A：启动后端，监听 http://localhost:8080  (ws: /ws)
npm run dev:server:test-01       # 终端 A：启动 AI 测试服 01，监听 http://localhost:8081（独立存档）
npm run dev -w @slg/client       # 终端 B：启动前端，打开提示的 http://localhost:5173
```

打开前端后注册/登录即可游玩。界面五个标签页：

🏠 村庄 ｜ ⚔️ 军队 ｜ 🗺️ 地图（自己村 / 他人村 / 野怪） ｜ 🔬 科技 ｜ 📜 报告

---

## 常用命令

```bash
npm run build            # 构建 shared + server + client（前端产物到 packages/client/dist）
npm start                # 生产模式启动后端（托管已构建的前端静态文件）
npm run test:server      # 跑后端测试（all.test.ts barrel 汇总全部 *.test.ts）
npm run lint:all         # 前后端 ESLint 与架构红线
npm run guard            # 变更契约检查
npm run test:deploy      # 隔离启动生产产物，验证 HTTP/静态前端/真实 WebSocket
npm run verify:changed   # 提交闸门：按变更范围验证
npm run verify:commit    # 手动执行提交总闸门
npm run verify           # CI/发版前全量验证（含发布布局、产物冒烟与 audit）
npm run deploy:prod      # 显式生产部署；始终发布远程 origin/main

npm run reset:season     # 刷档：留账号+地图位置，进度归零（新赛季）
npm run reset:respawn    # 刷档：留登录凭据，重新分配地图位置
npm run wipe:all         # 删档：连账号一起清空（均自动备份到 data/backups/）
```

环境变量（生产）：`PORT`（默认 8080）、`HOST`（默认 0.0.0.0）、`DATA_PATH`（默认 `./data/game.json`）、`LOG_DIR`（默认 `./data/logs`）、`GM_TOKEN`（设置后 `/gm/*` 路由需 `X-GM-Token` header 鉴权）。AI 测试服 01 固定使用 8081 与 `data/test-01/game.json`，不会读取或改写主服存档。

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
├── packages/             ← 【代码】shared / server / client
├── data/                 ← 运行时存档（git 忽略）
├── tools/                ← 工具脚本（deploy.sh、art_pipeline.py 等）
└── docs/                 ← 设计文档、规范、部署手册（索引见 PROJECT.md §五）
```

---

## 架构一句话

三层结构：**接入层 gateway → 领域层 modules → 基础设施 infra**。四条铁律详见 `docs/2_2.0设计/03_架构总览.md`。

---

## 部署

生产部署请按 **`docs/部署手册_腾讯云轻量服务器.md`**（含 pm2 保活、数据备份）。
正常 `git commit` 只执行本地验证，不改变生产环境。合并并推送远程 main 后运行 `npm run deploy:prod`；该命令只验证和发布 `origin/main` 的确定提交到不可变 release，再原子切换 `current` 并从公网核对提交 SHA。生产目录不是 Git 工作树。
