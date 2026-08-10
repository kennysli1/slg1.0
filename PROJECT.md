# 世界之王 (King of World / KOW) — 项目总览

> **本文是理解整个项目的唯一入口。** 不管你是第一次接触，还是隔了很久回来，先读这篇。
> 它回答四个问题：这是什么 / 目录里都是什么 / 代码怎么组织 / 怎么配置·扩展·修改·运行。

---

## 一、这是什么

一个**多人在线、服务器权威、实时推进**的文字版原创 SLG（世界之王 / KOW），基于战略战争玩法核心构建。

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
│   ├── buildings.csv         全部建筑（含资源田，zone 分城镇中心/城内/城外 + 前置依赖）
│   ├── town_center_slots.csv 城镇中心各级开放的城内/城外槽位数 + 建造队列条数
│   ├── units.csv             兵种
│   ├── unit_traits.csv       兵种特性
│   ├── pve_targets.csv       PvE 目标模板
│   ├── pve_defenders.csv     PvE 守军
│   ├── pve_spawns.csv        PvE 地图分布点
│   ├── game_constants.csv    全局常量（城墙/铁匠/容量/地图尺寸等，原硬编码）
│   └── village_templates.csv 各部族开局预置建筑布局 + 初始资源
│
├── packages/             ← 【代码】
│   ├── shared/               前后端共享：通信信封类型（必须 ESM）
│   ├── server/               后端
│   └── client/               前端
│
└── docs/                 ← 【文档】设计、规范、手册
    ├── 00_README.md          文档索引 + 进度 + 怎么跑
    ├── 2_2.0设计/           我们的设计与规范（见下）
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
| `economy.ts` | 资源存量/产率/容量/crop消耗 | **5 种资源（含金币 gold，无上限）**、惰性结算、扣费/给资源、crop净消耗与告急；金币靠人口交税 `economy.Grant` 入账（非自然产出）；`settle` 含健壮迁移：旧存档缺字段或残留 `null/NaN` 一律自愈为合法值（gold→`startGoldAmount`，cap→`GOLD_CAP`，`baseRate` 缺键兜底 0） |
| `building.ts` | 三区建筑布局（城镇中心+城内+城外，含资源田）+ 多条建造队列 | 点空槽建造、升级、科技树前置、城镇中心派生槽位/队列容量、主基地降耗时、上报人口耗粮/产率/仓储容量、城墙防御快照 |
| `military.ts` | 兵力/训练队列/铁匠等级 | 训练（逐个产出）、铁匠养成、参战快照、增减兵力 |
| `world.ts` | 地图地块（村庄/PvE/空地） | **六边形网格**（轴坐标 `{q,r}`）坐标、`hexDistance` 距离、放置村庄/PvE |
| `movement.ts` | 在途部队 | 出征→逐格行军→到达发 `combat.Engage`→战斗结束(`BattleEnded`)带战利品返程（raid打PvE / attack打玩家 / return）；坐标为六边形 `{q,r}` |
| `combat.ts` | **进行中的战斗**（`battle` 集合） | 有状态逐 tick 战斗：前后排承伤 + 近战/远程 + 特性；一地一场战、后到按阵营并入；结束发 Command 让 owner 扣兵/掠夺、发 Event 出战报（PvE/PvP 共用）；每 tick 推实时快照 |
| `pve.ts` | PvE目标守军/战利品 | 提供守军快照、应用战果、重生 |
| `population.ts` | 每村人口上限(hardCap,建筑累加)/劳动人口(currentPop)/士兵人口(soldierPop) | v3 硬上限模型：hardCap 由建筑 `popCapPerLevel×level` 累加；availableLabor=hardCap−soldierPop（兼容别名 softLimit）；laborRatio 驱动五轴统一的 `prosperityMult`∈[0.75,1]；**增长速率绑定城镇中心**（`main.popGrowthPerLevel × mainLevel`，GM 可改；旧全局 `pop_growth_per_hour` 已废弃）；开局人口=城镇中心当前等级贡献的 popCap；**金币税随结算累加**：`goldGained=currentPop×goldTaxPerCivilianPerHour×Δt`，经 `economy.Grant` 入账（不受繁荣度影响）；医院 `RecoverCasualties` 即时回收战死士兵人口（无伤兵池/无定时器）；铁匠升级耗时受繁荣加速；ConsumePop 只减 currentPop 腾空间；单向写 economy 口粮与劳动加成，只读 economy.nonCivilianUpkeep（无环）；**含周期结算 tick（每 30s 结算全部村庄）使金币税与人口增长持续累加、离线也生效** |
| `trade.ts` | 每村贸易中心（NPC 订单池、玩家挂单、贸易路线） | 镜像 mercenary 模式：等级决定容量/视野/刷新；即时交付 NPC 订单 + 玩家挂单派双向商队 + **NPC 宝物订单栏满溢出三选一**（store/replace/sell/discard）；详见 [`docs/贸易模块.md`](./docs/贸易模块.md) |
| `treasure.ts` | 每村宝物栏（城镇中心+宝库）+ 待领取 pending(treasure_pending 集合) | **MULTISET 语义**（同 code 可持有多份，每份占 1 槽，aggregate 累加；加性资源 / 乘性攻防复利）；pending 分 camp/deliver；**归途 ETA 精化**（rollDrop 占位 → movement 用真实 arriveAt 覆盖）；outwardId 索引（修复携带宝物返程丢失 + pending 卡死 bug）；详见 [`docs/宝物模块.md`](./docs/宝物模块.md) |
| `mercenary.ts` | 每村雇佣兵营地（offers 名单 + 存储刷新） | 镜像 trade 模式：金币购买名单上的雇佣兵 → military.troops（popCost=0/upkeep=0，零副作用自动参战）；自动刷新 + 手动刷新 + 升级不重 roll；详见 [`docs/雇佣兵营地模块.md`](./docs/雇佣兵营地模块.md) |
| `notifications.ts` | 每村通知/战报历史(notifications 集合) | 订阅各模块领域事件按 villageId 落盘，每村留最新 N 条；登录拉一次历史，不产生新 Push |
| `meta.ts` | 无（**只读 config**） | `GetGameConfig`：向客户端下发渲染最小集（资源/建筑含zone/兵种/PvE 名称+图标+分类 + 白名单常量），客户端不再硬编码映射 |

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
| `server/src/test/building.test.ts` | 建筑三区布局、建造/升级、槽位/队列、前置门控 |
| `server/src/test/multiplayer-pvp.test.ts` | 多人+PvP：注册/归属/A打B/双方战报/掠夺/返程/禁止自攻 |
| `server/src/test/combat.test.ts` | 有状态战斗 tick、胜负、损失与战报 |
| `server/src/test/hex.test.ts` | 六边形距离与路径 |
| `server/src/test/movement-path.test.ts` | 逐格行军、到达接战、途中相遇 |
| `server/src/test/persistence.test.ts` | 重启恢复：账号/资源/建筑/在途任务 |
| `server/src/test/population.test.ts` | 人口系统 v3：硬上限/availableLabor、繁荣度五轴加成、增长收敛、粮荒减员、医院即时回收、ConsumePop 腾空间、扣人口发 `population.Changed` |
| `server/src/test/population-v2.test.ts` | 人口系统 v3 回归：硬上限累加/availableLabor 门控/繁荣度联动/粮荒状态机/growthPerHour 粮荒为0/settle 永不 emit/RecoverCasualties 即时回收/resume 重算 hardCap/`population.Changed` 含 softLimit |
| `server/src/test/reset.test.ts` | 刷档三模式：season(留账号+位置)/respawn(重排位置)/wipe(全清) |
| `server/src/test/config.test.ts` | 配置中心：常量/模板解析 + 校验器（非法引用/循环依赖抛错） |
| `server/src/test/meta.test.ts` | `GetGameConfig` 下发最小集 + 不泄漏平衡参数 |
| `server/src/test/manifest.test.ts` | manifest 汇总 + 动作/事件名冲突检测 |
| `server/src/test/architecture.test.ts` | **架构守卫**：静态扫 `modules/*.ts` 兜底四铁律（跨模块 import / 模块内定时器 / store 集合归属唯一） |
| `server/src/test/notifications.test.ts` | 服务端通知/战报持久化与上限裁剪 |
| `server/src/test/concurrency.test.ts` 等 | 并发串行化 / Scheduler / CropDeficit 边沿 / RecoverCasualties 即时回收（无伤兵池）/ Gateway 边界 / WAL 恢复 |
| `client/src/test/unit.test.ts` | 前端转义、错误文案、协议版本兼容性 |

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
| `2_2.0设计/08_战斗系统重做设计.md` | 有状态 tick 战斗（近战/远程/特性）设计 | 改战斗前（已实现） |
| `2_2.0设计/09_地图与行军系统重做.md` | 六边形地图 + 真实路径 + 途中相遇 | 改地图/行军前（已实现） |
| `2_2.0设计/10_兵种特性效果表.md` | TraitEffect 枚举参考 + 加新特性怎么改 | 加兵种特性时 |
| `2_2.0设计/11_建筑系统重做.md` | 三区结构 + 城镇中心解锁槽位设计 | 改建筑前（已实现） |
| `2_2.0设计/12_建筑系统重构架构规划.md` | 建筑重构的架构/实现规划 | 读建筑实现依据 |
| `2_2.0设计/13_人口系统设计.md` | 人口机制 A–H + 数值表 + 收敛演算 | 改人口前（已实现） |
| `2_2.0设计/14_人口系统架构规划.md` | 人口系统架构/接口签名规划 | 读人口实现依据 |
| `2_2.0设计/改进方向备选池.md` | 待选扩展点 | 想新功能时 |
| **`服务器/01_数据存储结构.md`** | 存档格式、每个集合的 schema、主键规则 | 改数据 / 排查存档问题前 |
| **`服务器/02_数据库操作手册.md`** | 查看/备份/手改/刷档/删档/换DB | 运维数据 / 刷档时 |
| `服务器/03_GM调试手册.md` | GM 调试命令 / 手动改档技巧 | 联调 / 排障时 |
| `美术资源清单.md` | 美术替换清单（40 张已接入，PvE tier4-8 待补） | 做美术时 |
| `部署手册_腾讯云轻量服务器.md` | 部署步骤 + 需你提供的信息 | 上线时 |

### 已上线模块的实现参考文档（docs/ 根目录）

按模块组织的"实现参考"，与上方"设计/规范"文档互补——这里讲"现在的状态"，设计文档讲"为什么这么设计"。

| 文档 | 作用 | 何时看 |
|------|------|--------|
| `贸易模块.md` | trade 模块（NPC 订单 + 玩家挂单 + 路线回收 + NPC 宝物栏满溢出）+ 2026-08 新增「危险操作·拆除贸易中心」 | 改贸易/挂单/商队/栏满三选一时 |
| `宝物模块.md` | treasure 模块（MULTISET 语义 + 待领取 pending + 归途 ETA 精化 + 与军队/建筑/贸易的交互） | 改宝物/掉落/携带/领取/出售时 |
| `雇佣兵营地模块.md` | mercenary 模块（金币购买名单 + 自动囤积 + 升级不重 roll + 2026-08 新增「危险操作·拆除雇佣兵营地」） | 改雇佣兵/刷新/招募时 |
| `经济与金币模块.md` | economy 模块（5 资源惰性结算 + 金币税收/自愈）+ 人口交税入账 | 改资源/金币/经济计算时 |
| `服务器客户端同步与UI刷新.md` | 跨模块通用：事件→定向推送→onPush 刷新策略（含新增接线步骤与死循环坑） | 加事件/改推送时 |

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

> **两个全局约定**（详见 `config/README.md` 开头）：① 目录表(buildings/units/pve_targets)主键是**数字 `id`**，CSV 里**跨表引用一律填数字**（如 `units.building=4` 指兵营）；每行另有英文 `code` 供程序内部用，勿改。② `icon` 列只填**基名**（如 `bld_barracks`），渲染时拼 `/art/<基名>.png`。资源/部族主键保持语义串。

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

## 七、金币经济（Gold Economy）

金币是**第 5 种资源**（wood/clay/iron/crop/**gold**），用于雇佣兵体系。核心三点：**来源=人口交税、花费=建造/升级逐等级 gold、用途=买雇佣兵**。

### 1. 来源：人口交税（持续产金）
- 每个**劳动人口（currentPop）** 按税率交税：`金币/时 = currentPop × goldTaxPerCivilianPerHour`。
- 税率由 `gold_tax_per_civilian_per_hour` 控制（默认 1，GM 曾调到 100 → 显示 +2100/时）。**绑定城镇中心、不受繁荣度影响**。
- 金币**无自然产出**（不像木/土/铁/粮有 baseRate），只靠税收 `economy.Grant` 入账；容量 `GOLD_CAP = Number.MAX_SAFE_INTEGER`（无上限）。

### 2. 花费：建造/升级逐建筑逐等级 gold
- `config/building_levels.csv` 新增 **`costGold`** 列（在 `costCrop` 之后、`timeSec` 之前），表示"升/建到该等级**额外**消耗的金币数"（默认全 =1，叠加在原四资源之上）。
- 经济 `TrySpend` 已覆盖 gold，所以 per-level `costGold` 直接进花费对象，无需全局变量。
- **GM 面板可对每个建筑、每一级单独微调 `costGold`**（不再依赖单一 `gold_cost_per_build` 全局变量）。

### 3. 用途
- 雇佣兵营地购买 10 种雇佣兵：金币购买、永久拥有、不耗粮、不占人口。详见 `mercenaries.csv` 的 `goldCost` 列。

### 4. 怎么调参（两种口径，后者优先）
| 方式 | 改哪里 | 说明 |
|------|--------|------|
| 改 CSV | `config/game_constants.csv`：`gold_tax_per_civilian_per_hour` / `start_gold_amount`；`config/building_levels.csv`：`costGold` | 重启生效；CSV 是权威默认 |
| 在线 GM | `/gm/balance` 面板（覆盖层） | 改完即时热重载，**跨部署/刷档存活**（见下方注意事项③） |

### 5. 注意事项 / 已知坑
1. **金币会真实累加**：税收与人口增长由 `population` 模块的**周期结算 tick（每 30s 结算全部村庄）** 持续累加，客户端在线时每 5s 轮询也会触发；两者都按 `lastTick` 算 Δt，**互不重复计数**。所以"资源条显示 +X/时"是真实速率，离线也照常增长。
2. **旧存档自动自愈**：金币功能加入前创建的村庄，存档可能缺 `gold`/`baseRate.gold` 字段、或残留早期算出的 `null/NaN`（JSON 把 NaN 序列化成 `null`）。`economy.settle` 每次结算会把这些**非有限值自愈为合法值**（gold→`startGoldAmount`，cap→`GOLD_CAP`，`baseRate` 缺键兜底 0），**无需手动修档**。所以若看到金币从 `null`/异常值变成正常数字，是正常自愈。
3. **平衡覆盖层长期生效**：GM 手动调参写在 `data/balance_overrides.json`（与 `game.json` 同目录、`gitignore`）。部署的 `git reset --hard` 只清 git 跟踪的 `config/*.csv`，不碰 `data/`；`wipe:all` 只重置 `game.json`，不删覆盖文件。故 GM 调参跨部署/刷档存活。

---

## 八、当前状态与下一步

**已完成**：架构 + 通信规范 + 11 大模块 + **高比例配置驱动**（含全局常量/开局模板 CSV 化 + 启动校验器）+ **服务端统一配置下发（`GetGameConfig`）** + **前端按 feature 拆分** + **gateway 声明式 manifest 路由** + 可玩前端 + 多人 + PvP + 账号密码 + 三种族 + JSON持久化（WAL + fsync 快照）+ 重启恢复 + 部署套件 + **六边形地图/逐格行军** + **有状态 tick 战斗（近战/远程 + 特性 + 实时推送）** + **人口系统 v3 硬上限模型（hardCap 由建筑累加/availableLabor 门控/五轴统一 prosperityMult/增长收敛/粮荒减员/医院即时回收战死/铁匠耗时/ConsumePop 腾空间/military 逃兵）** + **协议/频控/串行化加固** + **正式美术接入** + **地图交互（鼠标拖拽平移 / 滚轮缩放 / 悬停信息浮层 / 点击派兵）** + **真·环面世界（平行四边形 torus 无缝环绕）** + **视口剔除渲染（平移/缩放/跳转即时重绘）** + **全图数据一次拉取（GetArea full:true）** + **金币经济（第 5 资源·人口交税·建造/升级 per-level costGold·雇佣兵营地+10 雇佣兵）** + **GM 平衡调参面板 `/gm/balance`（覆盖层热重载·跨部署/刷档存活·修复常量覆盖键名错配 bug）**。提交前跑 `npm run verify`（lint + 类型检查 + 服务端/客户端测试）。

**部署**：见 `docs/部署手册_腾讯云轻量服务器.md`（实操版，含 pm2 保活、数据备份）。本地生产模式 `npm run build && npm start`（与 pm2 `ecosystem.config.cjs` 同入口：`packages/server/dist/main.js`）。

**可选下一步**：
- 域名 + HTTPS（正式公开需要，可帮配 Nginx + 免费证书）
- 种族特性差异化（专属建筑/加成）、英雄/工会等养成系统
- 补齐 PvE tier4-8 正式美术（当前为占位图，见美术资源清单）

---

## 九、项目约定与坑（2026-08-10 汇总）

> 这一节是历次部署/开发踩坑的总结。**新人/AI 第一次改这个项目前必读**。每条都附触发场景与正确做法。

### 9.1 部署两条铁律

#### ① `origin/main` 可能严重落后（2026-08-09 踩过）

历史多走 `tools/deploy.sh` tar 部署、没 push GitHub。服务器 deploy 含 `git reset --hard origin/main`，**若不先 push 会把全部改动回滚到陈旧 origin**。曾因此把 v3/v4/v5/金币/人口/军事建筑迁入等全部改动整体回滚到 `21efab5`。

**取权威 SHA 必须用 `git ls-remote origin refs/heads/main`**。本机 `.git/refs/remotes/origin/main` 跟踪引用是**沙箱假象**（曾卡在 `21efab5` 不动），`git status` 显示的「领先 N 个提交」纯属误导。**永远以 `git ls-remote` 的返回为准**。

**正确流程**：
```bash
# 本机
git commit ...
git push origin main   # 确认本地 HEAD 是 origin/main 后代 = fast-forward
git ls-remote origin refs/heads/main   # 推送后再次确认权威 SHA 已更新

# 服务器
ssh kow
cd /home/ubuntu/kow
git checkout main   # 防御性：避免在 feature 分支上 reset --hard
git fetch origin
git reset --hard origin/main
npm run build        # 必须：客户端改 TS 必须 vite build，否则前端仍是旧 bundle
pm2 reload kow
```

#### ② 全量刷档前必须先 `pm2 stop kow`（2026-08-08 v3 部署踩过）

否则常驻进程持锁并按旧内存状态 flush，会把 wipe 结果覆盖回去。

**正确流程**：
```bash
ssh kow
cd /home/ubuntu/kow
pm2 stop kow                          # 先停
npm run wipe:all                      # 全量重置（自动备份到 data/backups/）
pm2 start kow                         # 再起
```

**纯 UI/config/HTML/字段层改动无需 wipe**（reload + build 即可）。判断标准：若改动只影响 CSV 数值、UI 文本、客户端 TS、GM 覆盖层等，不会改存档 schema，直接 reload；若改了 schema（坐标格式、兵种字段、新集合），必须 wipe。

### 9.2 架构与代码坑

#### movement.ts 字段是 `arriveAt` 不是 `arrivesAt`（2026-08-10 部署踩过）

`Movement` 接口字段名是 `arriveAt`（`packages/server/src/modules/movement.ts:56`）。本地 `npm run test:server` 跑 tsx 不做类型检查所以不会发现；部署时 `tsc` 报 `TS2551`。**写代码引用字段名要核对接口定义**。

#### 客户端 forEach 回调内禁止 `continue`（2026-08-10 踩过）

```ts
// 错误：TS1107 Jump target cannot cross function boundary
[].forEach((x) => {
  if (...) continue;   // ❌ 箭头函数内非法
});

// 正确：forEach 只能用 return
[].forEach((x) => {
  if (...) return;     // ✅ return 等价于 forEach 的 continue
});
```

#### 本机 `npm run build -w @slg/server` 退出码异常且无输出

本机 node_modules 环境问题导致 `tsc -p tsconfig.json` 退出码 1 但**无任何输出**（也不报错）。**以服务器 `npm run build` 的 tsc 输出为准**——服务器 build 会输出全部类型错误，本机不可信。部署流程天然就经服务器 build，所以本机 tsc 异常不影响部署。

#### 服务端 HTML 模板字符串的转义陷阱（2026-08-08 踩过）

反引号模板字符串（`` `...` ``）中 `\'` **不会**转义引号（反引号是分隔符，`\` 原样保留为字符）。写 `onclick="toggleBl('${code}')"` 渲染出的 JS 是非法的，整段 `<script>` 解析失败 → 面板空白只剩「就绪」。

**正确做法**：动态值用 `data-*` 属性携带，handler 内读 `this.dataset.*`：
```ts
onclick="toggleBl(this.dataset.code)"
<div data-code="${esc(code)}">
```

彻底规避字符串转义。所有「服务端拼 HTML/JS 字符串」场景都优先 data-*。

#### 客户端抽屉的 `slotId` 必须双路径都透传（2026-08-10 踩过）

`village.ts` 打开建筑抽屉有**两条路径**，都要把 `slotId` 透传给抽屉函数，否则抽屉里「危险操作·拆除」等附加按钮整段消失：

1. `openBuilding(slotId)` —— 来自建造区/军队页点击（已传 slotId）
2. `bindVillage` 里的 `[data-bld-slot]` 卡片点击 handler —— **这条路径曾漏传 slotId**，导致从村庄卡片打开的贸易中心/雇佣兵营地没有拆除按钮

**规则**：任何新增的「建筑详情抽屉附加按钮」（拆除、升级卡等）都要确保 `openXxxCenter(act, slotId?)` 在两条打开路径上都收到 `slotId`；抽屉函数内用 `if (slotId)` 决定要不要渲染该段。本次根因是 `mercenary.ts` 的 `openMercenaryCamp` 根本没有 slotId 形参、且 `village.ts` 第二条路径没传，已一并修复（`bcb4dbf`）。

### 9.3 数据与迁移坑

#### treasure 模块 ensureState 是 resume 能否成功的关键（2026-08-09 踩过）

旧档可能 `town`/`treasury` 缺失、非数组、含 `null`/非字符串等损坏。`resume()` → `recomputeAndPush` → `aggregate` 直接 spread 会抛 `is not iterable` 导致**崩溃循环**（每个村庄都崩）。`ensureState` 必须把非数组归一为 `[]`、非字符串过滤、缺字段补默认值，并写回存档。

类似 self-healing 在 `economy.settle()` 也有（旧金币 `null` → 自愈为 `startGoldAmount`）。详见 [`docs/经济与金币模块.md`](./docs/经济与金币模块.md)。

#### pm2 `err.log` 可能含**历史进程**的陈旧报错（2026-08-10 踩过）

`pm2 logs` / `err.log` 是**追加**的，旧进程崩溃的栈也会留在文件里。诊断 `X is not iterable` 这类崩溃时：

- **先确认报错行号对不对得上当前源码**：若行号与当前 `grep` 到的代码行不匹配，多半是旧进程的
- **用当前 pm2 pid 过滤**：`grep $(pm2 pid kow) err.log` 看该 pid 名下是否真有新增报错
- 本次「`s.town is not iterable`」就是历史进程留的——当前源码 `storedCodes` 已有 `?? []` 保护、`grep` 当前 pid 为 0 行，重启后 err.log delta = 0。确认无新报错即可，不必为历史行号改代码。

#### GM 平衡覆盖层长期生效

GM 在 `/gm/balance` 手动调参写在 `data/balance_overrides.json`（与 `game.json` 同目录、`gitignore`）。
- `git reset --hard`（部署）只清 git 跟踪的 `config/*.csv`，**不动 data/**
- `wipe:all` 只重置 `game.json`，**不删覆盖文件**

故 GM 调参**跨部署/刷档存活**。详细机制见 §七（Gold Economy §5）。

### 9.4 授权与流程约定

- **非破坏式改动部署直接执行**：用户已明确「非破坏式（客户端 UI / 平衡 CSV / GM 覆盖层等）部署=push + reset + build + reload，**不 wipe**，不必每步再问」
- **破坏式 / delete 操作全面授权**：含 `npm run wipe:all`、任何删除/清理，**直接执行**，仍保留 wipe 自动备份到 `data/backups/`（自动执行、不询问）
- **本机个人目录（Desktop/Downloads/Documents 等）的删除不在此授权内**，仍须走 trash/备份流程且不可批量 rm

---

## 十、项目速查表

### 10.1 核心模块清单（按 owner 集合）

| 模块 | 拥有的集合 | 主要客户端动作 |
|------|-----------|---------------|
| `player.ts` | `players` | `Register` / `Login` |
| `economy.ts` | `economy`（每村资源/容量/产率） | `GetResources` / `TrySpend` / `Grant` / `settle` |
| `building.ts` | `buildings`（三区+队列） | `Build` / `Upgrade` / `Demolish` |
| `military.ts` | `military`（troops + 训练队列 + 铁匠） | `Train` / `AddMercenaries` |
| `world.ts` | `world`（地块） | `GetArea` |
| `movement.ts` | `movements`（在途） | `Raid` / `Attack` / `Transport` / `SendCaravan` |
| `combat.ts` | `battle`（进行中战斗） | （无对外动作，订阅 `BattleEnded`） |
| `pve.ts` | `pve_targets` / `pve_defenders` | （订阅 `PveBattle`） |
| `population.ts` | `population`（hardCap / currentPop / soldierPop） | `ConsumePop` / `RecoverCasualties` |
| `trade.ts` | `trade`（NPC 订单 + 玩家挂单） | `GetTradeCenter` / `AcceptNpcOrder` / `AcceptNpcTreasure` / `CreateTradeOrder` / `AcceptPlayerOrder` / `CancelTradeOrder` / `RefreshTrade` |
| `treasures.ts` | `treasure`（每村宝物）+ `treasure_pending` | `ListTreasures` / `UseTreasure` / `SellTreasure` / `DiscardTreasure` / `ClaimPendingTreasure` / `AssignToArmy` |
| `mercenary.ts` | `merc`（每村营地） | `GetMercCamp` / `RefreshMercCamp` / `HireMerc` |
| `notifications.ts` | `notifications`（每村战报历史） | `GetNotifications` |
| `meta.ts` | 无（只读 config） | `GetGameConfig` |

### 10.2 关键客户端命令（按"用户高频"分类）

| 场景 | 命令 | 入口 |
|------|------|------|
| 注册/登录 | `Register` / `Login` | `features/login/` |
| 村庄主页 | `GetVillage` / `GetResources` / `GetBuildings` / `GetArmy` | `features/village/` |
| 建造/升级/拆除 | `Build` / `UpgradeBuilding` / `DemolishBuilding` | 村庄页 |
| 训练 | `Train` | 兵营/靶场/马厩详情 |
| 出征/攻占 | `Raid` / `Attack` | 地图 |
| 雇佣 | `HireMerc` | 雇佣兵营地抽屉 |
| 贸易 | `CreateTradeOrder` / `AcceptNpcOrder` / `AcceptNpcTreasure` / `AcceptPlayerOrder` | 贸易中心抽屉 |
| 宝物 | `UseTreasure` / `SellTreasure` / `DiscardTreasure` / `ClaimPendingTreasure` / `AssignToArmy` | 宝物面板 + 战报 |
| GM | `GM.*` / `/gm/balance` 覆盖层 | `/gm` |

### 10.3 关键文件速查（按"读这个就能改那块"）

| 想改什么 | 看这个 |
|---------|--------|
| 资源产出/金币 | `packages/server/src/modules/economy.ts` + `config/resources.csv` / `config/game_constants.csv` |
| 建筑/槽位/队列 | `packages/server/src/modules/building.ts` + `config/buildings.csv` / `config/building_levels.csv` / `config/town_center_slots.csv` |
| 兵种/雇佣兵/特性 | `packages/server/src/modules/military.ts` + `config/units.csv` / `config/unit_traits.csv` |
| 行军/战斗/携带 | `packages/server/src/modules/movement.ts` + `combat.ts` + `treasure.ts` |
| 人口/金币税/繁荣度 | `packages/server/src/modules/population.ts` |
| 贸易/挂单/路线 | `packages/server/src/modules/trade.ts` + `config/trade_center.csv` |
| 宝物/MULTISET/掉落/携带 | `packages/server/src/modules/treasures.ts` + `config/treasures.csv` |
| 雇佣兵营地 | `packages/server/src/modules/mercenary.ts` + `config/merc_camp.csv` |
| 跨模块推送/UI 刷新 | `packages/client/src/features/reports/reports.ts` + `docs/服务器客户端同步与UI刷新.md` |
| 客户端抽屉/建筑详情 | `packages/client/src/features/village/village.ts` |
| 拆建筑按钮 | `village.ts` 的 `openBuildingDetail` + `features/trade/tradecenter.ts` + `features/army/mercenary.ts` |
| 启动/刷档/备份 | `packages/server/src/admin.ts` + `docs/服务器/02_数据库操作手册.md` |
| GM 调参 UI | `packages/server/src/gateway/gm.ts` + `http://host:8080/gm` |

### 10.4 跨模块事件/命令流向

```
building.Built/Upgraded → trade/treasure/mercenary 懒建 + 刷新参数
movement.BattleEnded → combat → treasure.RollDrop → camp pending
movement.scheduleReturn → treasure.SetExpectedArrival（精化 ETA）
movement.arriveReturn → treasure.StoreCarried + treasure.MarkPendingArrived
movement.Sent → treasure.GetCarriedEffects（出战快照叠加）
treasure.Changed → economy.SetRateModifier + population.SetTreasureGrowthMult + military.SetTreasureCombatMult
trade.AcceptNpcTreasure → treasure.List/Grant/Replace
building.Demolish → trade/treasure/mercenary 清理 + 重分布
```

### 10.5 测试速查（按"改完这块该跑哪个"）

| 改动模块 | 跑这个 |
|---------|--------|
| 经济/资源/金币 | `test/economy.test.ts` |
| 建筑/队列 | `test/building.test.ts` |
| 兵种/训练 | `test/military.test.ts` |
| 行军/战斗/携带 | `test/combat.test.ts` + `test/movement-path.test.ts` + `test/treasure.test.ts` |
| 人口 | `test/population.test.ts` + `test/population-v2.test.ts` |
| 贸易 | `test/trade.test.ts` |
| 宝物 | `test/treasure.test.ts`（含 6 例 MULTISET 回归） |
| 雇佣兵 | `test/mercenary.test.ts` |
| 全局 | `npm run test:server`（汇总） + `npm run verify`（提交前） |
