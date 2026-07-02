# Travian 2.0 — 项目总览

> **本文是理解整个项目的唯一入口。** 不管你是第一次接触，还是隔了很久回来，先读这篇。
> 它回答四个问题：这是什么 / 目录里都是什么 / 代码怎么组织 / 怎么配置·扩展·修改·运行。

---

## 一、这是什么

一个**单人可玩的文字版 Travian**（经典策略战争网页游戏）的 2.0 版本，基于原版做扩展。

- **形态**：网页游戏，服务器权威 + 实时（建造/训练/行军按真实时间推进）。
- **技术**：全栈 TypeScript。后端 Node + Fastify + WebSocket，前端原生 TS + Vite。**数据持久化用 JSON 文件**（`data/game.json`，零依赖、重启不丢；架构隔离，以后可换 SQLite/PG）。
- **当前进度**：**多人在线可玩 + 可部署**。账号密码(scrypt加密)、三种族(罗马/高卢/条顿)、核心循环（经济→训练→打PvE/PvP→掠夺→返程）、数据持久化、重启恢复在途任务。
- **核心设计原则**：见下方"代码架构"的四条铁律。一句话——**模块之间只通过明确契约通信，绝不互相直接读写状态**，保证以后好扩展、好修改。

---

## 二、目录结构总览

```
slg1.0/
├── PROJECT.md            ← 本文件（项目入口）
├── package.json          ← monorepo 工作区配置
├── .gitignore
│
├── config/               ← 【游戏数值】全部 CSV，Excel 可改，改完重启生效，不动代码
│   ├── README.md             每张表每列的说明
│   ├── resources.csv         资源种类
│   ├── fields.csv            资源田
│   ├── buildings.csv         中心建筑（含前置依赖）
│   ├── units.csv             兵种
│   ├── pve_targets.csv       PvE 目标模板
│   ├── pve_defenders.csv     PvE 守军
│   ├── pve_spawns.csv        PvE 地图分布点
│   ├── game_constants.csv    全局常量（城墙/铁匠/容量/地图尺寸等，原硬编码）
│   └── village_templates.csv 各部族开局布局（田地/初始建筑/初始资源）
│
├── packages/             ← 【代码】
│   ├── shared/               前后端共享：通信信封类型（必须 ESM）
│   ├── server/               后端
│   └── client/               前端
│
└── docs/                 ← 【文档】设计、规范、手册
    ├── 00_README.md          文档索引 + 进度 + 怎么跑
    ├── 1_原版拆解/           参照系：对原版 Travian 的反向拆解（GDD/开发计划）
    ├── 2_2.0设计/            我们的 2.0 设计与规范（见下）
    ├── 服务器/              数据存储结构 + 数据库操作手册（备份/刷档/删档）
    ├── 美术资源清单.md        需要的占位图替换清单
    └── 部署手册_腾讯云轻量服务器.md
```

---

## 三、代码架构

### 三层结构（依赖只能从上往下）

```
接入层 gateway/   Gateway（唯一翻译官）+ main.ts（Fastify/WS 传输）
     ↑ 调用
领域层 modules/   游戏逻辑，每个模块独占一块状态
     ↑ 使用（注入）
基础设施 infra/   EventBus / CommandBus / Scheduler / Store / config / csv
```

### 四条架构铁律（改任何代码都不能违背）
1. **状态归属唯一**：每块数据只有一个模块是 owner，别人只能通过它的 Command 读/改，**不能直接 import 它的状态**。
2. **跨模块只传 Command/Event**：模块之间不互相 import、不互相调方法。
3. **时间统一走 Scheduler**：禁止模块内 `setTimeout/setInterval`。
4. **派生属性对外只给结果快照**：养成/加成在模块内部分层叠加，对外只暴露算好的最终值。

> 这四条的原理和案例（工会/英雄养成怎么加而不破坏架构）详见 `docs/2_2.0设计/03_架构总览.md`。

### 通信：两套信封（定义在 `packages/shared`）
- **边界① 服务器↔客户端**（`shared/wire.ts`）：`Request` / `Response` / `Push`。
- **边界② 模块↔模块**（`shared/messaging.ts`）：`Command`（写操作、要结果）/ `Event`（通知、解耦）。
- 原则：**固定外层信封，自由内层 payload**。升级只放资源、战斗放资源+兵力，都是同一信封换内容。
- 详见 `docs/2_2.0设计/04_通信格式规范.md`。

---

## 四、模块清单（packages/server/src）

### 基础设施层 `infra/`（无游戏逻辑）
| 文件 | 职责 |
|------|------|
| `event-bus.ts` | 事件总线：广播 Event，一对多解耦 |
| `command-bus.ts` | 命令总线：发 Command，一对一要结果 |
| `scheduler.ts` | 调度器：全游戏唯一时间源，定时触发（支持假时钟测试） |
| `store.ts` | 存储接口 + 内存实现(测试) + **JSON文件实现(生产,落盘+重启恢复)**；接口 `get/set/delete/all/clear`。以后换 SQLite/PG 只改这里 |
| `csv.ts` | CSV 解析器 |
| `config.ts` | 把 `config/*.csv` 解析成 `GameConfig`（含 `constants`/`villageTemplates`）；**启动期 `validateGameConfig` 校验**：跨表引用、数值范围、建筑 requires 循环依赖，错误定位到表/字段 |

### 领域层 `modules/`（每个模块管一块状态）
| 模块 | 拥有的状态 | 主要能力 |
|------|-----------|---------|
| `player.ts` | 玩家账号(密码scrypt)、玩家↔村庄映射、种族 | 注册/登录、分配地图空位、村庄归属反查 |
| `economy.ts` | 资源存量/产率/容量/crop消耗 | 4资源、惰性结算、扣费/给资源、crop净消耗与告急 |
| `building.ts` | 18资源田 + 中心建筑等级/队列 | 升级、科技树前置、主基地降耗时、上报人口耗粮 |
| `military.ts` | 兵力/训练队列/铁匠等级 | 训练（逐个产出）、铁匠养成、参战快照、增减兵力 |
| `world.ts` | 地图地块（村庄/PvE/空地） | **六边形网格**（轴坐标 `{q,r}`）坐标、`hexDistance` 距离、放置村庄/PvE |
| `movement.ts` | 在途部队 | 出征→逐格行军→到达发 `combat.Engage`→战斗结束(`BattleEnded`)带战利品返程（raid打PvE / attack打玩家 / return）；坐标为六边形 `{q,r}` |
| `combat.ts` | **进行中的战斗**（`battle` 集合） | 有状态逐 tick 战斗：前后排承伤 + 近战/远程 + 特性；一地一场战、后到按阵营并入；结束发 Command 让 owner 扣兵/掠夺、发 Event 出战报（PvE/PvP 共用）；每 tick 推实时快照 |
| `pve.ts` | PvE目标守军/战利品 | 提供守军快照、应用战果、重生 |
| `meta.ts` | 无（**只读 config**） | `GetGameConfig`：向客户端下发渲染最小集（资源/田地/建筑/兵种/PvE 名称+图标+分类 + 白名单常量），客户端不再硬编码映射 |

### 接入层
| 文件 | 职责 |
|------|------|
| `gateway/manifest.ts` | **模块清单声明式注册**：定义 `ModuleManifest`（publicActions/eventPushMap）+ `aggregateManifests` 汇总；动作/事件名冲突启动即报错 |
| `gateway/gateway.ts` | 翻译官 + **多人会话**：路由表由各模块 `static MANIFEST` 汇总生成（不再手工维护）；自己村操作强制注入会话villageId（安全），事件按villageId定向推送 |
| `app.ts` | 组装层：加载 config → new 所有模块 → init；**刷档 `resetWorld()`**（进度/账号集合白名单 + 三种粒度） |
| `main.ts` | 入口：Fastify + WebSocket，挂 Gateway，托管前端 |
| `admin.ts` | **运维 CLI**（一次性进程）：`reset:season`/`reset:respawn`/`wipe:all` 刷档，执行前自动备份 |

### 前端 `packages/client/src`（按 feature 拆分）
| 路径 | 职责 |
|------|------|
| `main.ts` | 仅入口：`import bootstrap()` |
| `api.ts` | WebSocket 通信 + 登录（记住自己身份 `me`） |
| `info.ts` | 显示映射**回退表**（fallback）；正常走服务端 `GetGameConfig` |
| `app/bootstrap.ts` | 启动编排：shell/资源条/页签路由/刷新循环/推送分发 |
| `app/state.ts` | 应用级共享状态（缓存/战报/当前页签/地图选中） |
| `app/config.ts` | 服务端配置缓存层（消费 `GetGameConfig`，提供 `resInfo`/`unitInfo`… 取值，缺失回退 `info.ts`） |
| `features/{login,village,army,map,reports}/` | 各页面独立 render + bind 事件处理 |
| `shared/ui/`、`shared/utils/` | 图标/消耗预览/进度条/格式化/错误文案等共享原子 |

### 测试
| 文件 | 内容 |
|------|------|
| `server/src/test/all.test.ts` | **测试入口 barrel**（跨平台；`npm run test:server` 跑它，汇总导入下列各文件） |
| `server/src/test/full-loop.test.ts` | 单人全循环：经济→训练→打PvE→掠夺→返程 |
| `server/src/test/multiplayer-pvp.test.ts` | 多人+PvP：注册/归属/A打B/双方战报/掠夺/返程/禁止自攻 |
| `server/src/test/persistence.test.ts` | 重启恢复：账号/资源/建筑/在途任务 |
| `server/src/test/reset.test.ts` | 刷档三模式：season(留账号+位置)/respawn(重排位置)/wipe(全清) |
| `server/src/test/config.test.ts` | 配置中心：常量/模板解析 + 校验器（非法引用/循环依赖抛错） |
| `server/src/test/meta.test.ts` | `GetGameConfig` 下发最小集 + 不泄漏平衡参数 |
| `server/src/test/manifest.test.ts` | manifest 汇总 + 动作/事件名冲突检测 |
| `server/src/test/architecture.test.ts` | **架构守卫**：静态扫 `modules/*.ts` 兜底四铁律（跨模块 import / 模块内定时器 / store 集合归属唯一） |

---

## 五、文档清单（docs/）

| 文档 | 作用 | 何时看 |
|------|------|--------|
| `00_README.md` | 文档索引、进度、怎么跑 | 找东西时 |
| **`2_2.0设计/03_架构总览.md`** | 架构原理、四铁律、扩展案例 | 改架构/加大功能前 |
| **`2_2.0设计/04_通信格式规范.md`** | 两套信封格式 | 改通信/加接口前 |
| `2_2.0设计/05_技术栈与工程结构.md` | 选型、工程结构、踩坑记录 | 环境/构建问题 |
| `2_2.0设计/06_代码导读.md` | 代码细节导读、一条链路怎么流动 | 第一次读代码 |
| **`2_2.0设计/07_扩展与代码规范.md`** | 立规矩：怎么加内容/模块/养成 + 自查清单 | **每次加代码前** |
| `2_2.0设计/01_定位与改动方针.md` | S0 核心定位决策 | 回顾方向 |
| `2_2.0设计/02_系统清单.md` | 系统范围（保留/改/新增/后置） | 看做了什么没做什么 |
| `2_2.0设计/改进方向备选池.md` | 待选扩展点 | 想新功能时 |
| **`服务器/01_数据存储结构.md`** | 存档格式、每个集合的 schema、主键规则 | 改数据 / 排查存档问题前 |
| **`服务器/02_数据库操作手册.md`** | 查看/备份/手改/刷档/删档/换DB | 运维数据 / 刷档时 |
| `1_原版拆解/` | 原版 Travian 反拆（参照系） | 还原某系统时对照 |
| `美术资源清单.md` | 31个占位图替换清单 | 做美术时 |
| `部署手册_腾讯云轻量服务器.md` | 部署步骤 + 需你提供的信息 | 上线时 |

---

## 六、怎么做四件事

### 1. 运行（本地）
```bash
npm install                      # 首次
npm run build:shared             # 改过 shared 后必跑（前后端共享类型）
npm run dev:server               # 终端A：后端 :8080
npm run dev -w @slg/client       # 终端B：前端，打开提示的 http://localhost:5173
```
四个标签页：🏠村庄 / ⚔️军队 / 🗺️地图 / 📜报告。

### 2. 配置（改数值，最常做）
打开 `config/` 里对应的 CSV（Excel 可开），改数值，存为 CSV UTF-8，重启后端。
**不改代码、不重新编译。** 例：改 `units.csv` 里军团兵的 `atk` → 军团兵立刻变强。每列含义见 `config/README.md`。

> **两个全局约定**（详见 `config/README.md` 开头）：① 目录表(fields/buildings/units/pve_targets)主键是**数字 `id`**，CSV 里**跨表引用一律填数字**（如 `units.building=4` 指兵营）；每行另有英文 `code` 供程序内部用，勿改。② `icon` 列只填**基名**（如 `bld_barracks`），渲染时拼 `/art/<基名>.png`。资源/部族主键保持语义串。

### 3. 扩展（加新东西）
先看 `docs/2_2.0设计/07_扩展与代码规范.md` 的"扩展决策树"，归类后照做。
**一句话总闸**：新东西有没有"自己独占的一块状态"？有 → 新建模块文件（它当 owner）；没有，只是给旧状态加数值/加成 → 改已有文件。
- 加**内容/数值**（新建筑/兵种/PvE）→ 改 `config/*.csv` 加一行。**前端无需改代码**（名称/图标走服务端 `GetGameConfig` 下发）。
- 加**全局常量/平衡参数** → 改 `config/game_constants.csv`，在 `config.ts` 的 `GameConstants` 加字段映射。
- 加**新系统**（工会/邮件）→ 照 `modules/` 模板加一个新模块，挂到 `app.ts`，**给模块加 `static MANIFEST`** 并在 `gateway.ts` 的 `MODULE_MANIFESTS` 登记（不必手改路由表）。
- 加**养成/加成**（天赋/突破）→ 在 owner 模块的派生管线加一层。

### 4. 修改（改逻辑）
- 找到状态 owner 模块（见上方模块清单），改它的私有方法。
- **不要**跨模块直接读写；要别的模块的数据就发 Command。
- 改完跑 `npm run lint`（守铁律）+ `npm run test:server`（含架构守卫，确认全循环没坏）。
- 提交前对照 `07` 文档末尾的"自查清单"。

---

## 七、当前状态与下一步

**已完成**：架构 + 通信规范 + 9 大模块 + **高比例配置驱动**（含全局常量/开局模板 CSV 化 + 启动校验器）+ **服务端统一配置下发（`GetGameConfig`）** + **前端按 feature 拆分** + **gateway 声明式 manifest 路由** + 可玩前端 + 多人 + PvP + 账号密码 + 三种族 + JSON持久化 + 重启恢复 + 部署套件 + **六边形地图/逐格行军** + **有状态 tick 战斗（近战/远程 + 特性 + 实时推送）**。测试 39/39。

**部署**：见 `docs/部署手册_腾讯云轻量服务器.md`（实操版，含 pm2 保活、数据备份）。本地生产模式 `npm run build && npm start`。

**可选下一步**：
- 部署上线（按手册操作，需你在服务器执行几条命令）
- 域名 + HTTPS（正式公开需要，我可帮配 Nginx + 免费证书）
- 种族特性差异化（专属建筑/加成）、英雄/工会等养成系统
- 生成美术替换占位图（见美术资源清单）
