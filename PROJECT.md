# 世界之王 (King of World / KOW) — 项目总览

> **本文是理解整个项目的唯一入口。** 不管你是第一次接触，还是隔了很久回来，先读这篇。
> 它回答四个问题：这是什么 / 目录里都是什么 / 代码怎么组织 / 怎么配置·扩展·修改·运行。
>
> ⛔ **动手改任何东西前，先读 [`docs/00_变更契约.md`](./docs/00_变更契约.md)**（六条硬规矩 + 四道自动闸门）。
> 本文的 **§四 模块清单**和 **§五 文档清单**是全仓索引的唯一真相：加了模块/文档不登记在这里，`npm run guard` 会拒绝提交。

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
├── PROJECT.md            ← 本文件（项目入口 / 模块与文档索引的唯一真相）
├── CLAUDE.md             ← AI 每次必读的 L0 入口：红线 + 任务路由表
├── CHANGELOG.md          ← 唯一的历史入口，业务改动必须在此记账
├── package.json          ← monorepo 工作区配置
├── .githooks/            ← 提交/推送闸门（npm install 后自动生效）
├── scripts/guard/        ← 变更契约校验器（npm run guard）
├── .gitignore
│
├── config/               ← 【游戏数值】全部 CSV，Excel 可改，改完重启生效，不动代码
│                            每张表每列的含义见 config/README.md（那是 CSV 的唯一索引）
├── tools/                ← 工具脚本：部署、CSV 注释、美术流水线（art_pipeline.py 等）
│
├── packages/             ← 【代码】
│   ├── shared/               前后端共享：通信信封类型（必须 ESM）
│   ├── server/               后端
│   └── client/               前端
│
└── docs/                 ← 【文档】设计、规范、手册（清单见 §五，那是文档的唯一索引）
    ├── 00_变更契约.md        ⛔ 六条硬规矩 + 四道自动闸门，改代码前必读
    ├── 2_2.0设计/           我们的设计与规范
    ├── 服务器/              数据存储结构 + 数据库操作手册（备份/刷档/删档）
    └── archive/             已上线系统的一次性实现规划。**AI 默认不读**
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
| `mercenary.ts` | 每村雇佣兵营地的候选名单、刷新次数与刷新任务 | 按营地等级自动/手动刷新候选，消耗金币雇佣零人口零口粮兵种 |
| `trade.ts` | 每村贸易中心、NPC订单池、玩家挂单与贸易路线占用 | NPC即时交易、附近玩家挂单/接单、商队派发与路线回收 |
| `treasures.ts` | 每村宝物栏、随军宝物与待领取宝物 | 宝物存取/出售/丢弃、效果快照下发、随军转移、战报确认与超时遗弃 |
| `military.ts` | 兵力/训练队列/铁匠等级 | 训练（逐个产出）、铁匠养成、参战快照、增减兵力 |
| `world.ts` | 地图地块（村庄/PvE/空地） | **六边形网格**（轴坐标 `{q,r}`）坐标、`hexDistance` 距离、放置村庄/PvE |
| `movement.ts` | 在途部队 | 出征→逐格行军→到达发 `combat.Engage`→战斗结束(`BattleEnded`)带战利品返程（raid打PvE / attack打玩家 / return）；坐标为六边形 `{q,r}` |
| `combat.ts` | **进行中的战斗**（`battle` 集合） | 有状态逐 tick 战斗：前后排承伤 + 近战/远程 + 特性；一地一场战、后到按阵营并入；结束发 Command 让 owner 扣兵/掠夺、发 Event 出战报（PvE/PvP 共用）；每 tick 推实时快照 |
| `pve.ts` | PvE目标守军/战利品 | 提供守军快照、应用战果、重生 |
| `population.ts` | 每村人口上限(hardCap,建筑累加)/劳动人口(currentPop)/士兵人口(soldierPop) | v3 硬上限模型：hardCap 由建筑 `popCapPerLevel×level` 累加；availableLabor=hardCap−soldierPop（兼容别名 softLimit）；laborRatio 驱动五轴统一的 `prosperityMult`∈[0.75,1]；**增长速率绑定城镇中心**（`main.popGrowthPerLevel × mainLevel`，GM 可改；旧全局 `pop_growth_per_hour` 已废弃）；开局人口=城镇中心当前等级贡献的 popCap；**金币税随结算累加**：`goldGained=currentPop×goldTaxPerCivilianPerHour×Δt`，经 `economy.Grant` 入账（不受繁荣度影响）；医院 `RecoverCasualties` 即时回收战死士兵人口（无伤兵池/无定时器）；铁匠升级耗时受繁荣加速；ConsumePop 只减 currentPop 腾空间；单向写 economy 口粮与劳动加成，只读 economy.nonCivilianUpkeep（无环）；**含周期结算 tick（每 30s 结算全部村庄）使金币税与人口增长持续累加、离线也生效** |
| `trade.ts` | 每村贸易中心（NPC 订单池、玩家挂单、贸易路线） | 镜像 mercenary 模式：等级决定容量/视野/刷新；即时交付 NPC 订单 + 玩家挂单派双向商队 + **NPC 宝物订单栏满溢出三选一**（store/replace/sell/discard）；详见 [`docs/贸易模块.md`](./docs/贸易模块.md) |
| `treasure.ts` | 每村宝物栏（城镇中心+宝库）+ 待领取 pending(treasure_pending 集合) | **MULTISET 语义**（同 code 可持有多份，每份占 1 槽，aggregate 累加；加性资源 / 乘性攻防复利）；pending 分 camp/deliver；**归途 ETA 精化**（rollDrop 占位 → movement 用真实 arriveAt 覆盖）；outwardId 索引（修复携带宝物返程丢失 + pending 卡死 bug）；详见 [`docs/宝物模块.md`](./docs/宝物模块.md) |
| `mercenary.ts` | 每村雇佣兵营地（offers 名单 + 存储刷新） | 镜像 trade 模式：金币购买名单上的雇佣兵 → military.troops（popCost=0/upkeep=0，零副作用自动参战）；自动刷新 + 手动刷新 + 升级不重 roll；详见 [`docs/雇佣兵营地模块.md`](./docs/雇佣兵营地模块.md) |
| `research.ts` | 每村科研进度(research 集合) + 学院 RP 生产 | 学院产科研点（保底概率 + 多学院加速 + 人口因子）→ 科技树消耗 RP 研发 → 双轨效果注入（数值配置驱动 + 机制注册表钩子）；科技依赖 AND/OR 语法 + 启动期无环校验；scope=player 的科技自动跨村注入；详见 [`docs/科研模块.md`](./docs/科研模块.md) |
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

### 前端 `packages/client/src`（Preact + signals，按 feature 拆分）
> 视图层契约、设计令牌、UI 原子与跨特性接口见 **`docs/2_2.0设计/14_前端设计系统.md`**（写前端代码前必读）。

| 路径 | 职责 |
|------|------|
| `main.tsx` | 入口：`render(<App/>)` + 生产环境注册 Service Worker |
| `api.ts` | WebSocket 通信 + 登录（记住自己身份 `me`） |
| `info.ts` | 显示映射**回退表**（fallback）；正常走服务端 `GetGameConfig` |
| `app/store.ts` | 响应式仓库（signals）：1 秒心跳 `tick`、数据版本 `dataVersion`、页签、弹层栈、Toast、地图选中、次级数据源 |
| `app/refresh.ts` | 数据层：`refreshAll` 统一拉取、`act()` 动作提交、推送分发（事件驱动，无盲轮询） |
| `app/state.ts` | 纯数据与插值逻辑（快照缓存、人口/资源本地外插），无框架依赖，可单测 |
| `app/config.ts` | 服务端配置缓存层（消费 `GetGameConfig`，提供 `resInfo`/`unitInfo`…，缺失回退 `info.ts`） |
| `shell/` | `App`（连接生命周期/页签路由）+ `TopBar` + `ResourceBar` + `TabBar` |
| `ui/` | UI 原子：`Icon`/`IconPlate`/`Panel`/`Btn`/`Bar`/`TimerBar`/`CostRow`/`Modal`/`Stat` |
| `styles/` | `tokens.css`（唯一配色/间距来源）+ `base`/`frame`/`shell` + 各页私有样式 |
| `features/{login,village,army,map,research,reports,trade}/` | 各页面组件与其弹窗；村庄页含可视化场景与列表双视图，research 含科技树页与学院弹窗 |
| `shared/ui/`、`shared/utils/` | 错误文案 / 转义 / 格式化 / 六边形数学 |

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
| `server/src/test/smithy.test.ts` | 铁匠养成：造价公式、`GetArmy` 下发 `pendingSmithy`（起止时刻，不外泄 taskId）、并发互斥、资源不足 |
| `server/src/test/manifest.test.ts` | manifest 汇总 + 动作/事件名冲突检测 |
| `server/src/test/architecture.test.ts` | **架构守卫**：静态扫 `modules/*.ts` 兜底四铁律（跨模块 import / 模块内定时器 / store 集合归属唯一） |
| `server/src/test/notifications.test.ts` | 服务端通知/战报持久化与上限裁剪 |
| `server/src/test/concurrency.test.ts` 等 | 并发串行化 / Scheduler / CropDeficit 边沿 / RecoverCasualties 即时回收（无伤兵池）/ Gateway 边界 / WAL 恢复 |
| `client/src/test/unit.test.ts` | 前端转义、错误文案、协议版本兼容性 |

---

## 五、文档清单（docs/）

> **这张表是全部活跃文档的唯一索引。** 新增/删除 `docs/**` 必须同步改这里，否则 `npm run guard` 拒绝提交。
> 每篇文档开头的 front-matter 里有 `summary`（一句话）——先扫 summary 决定读哪篇，别一篇篇打开。

| 文档 | 作用 | 何时看 |
|------|------|--------|
| **`00_变更契约.md`** | ⛔ 六条硬规矩 + 四道自动闸门 | **改任何东西前** |
| `00_README.md` | 文档区推进流程与进度 | 找东西时 |
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
| `2_2.0设计/13_人口系统设计.md` | 人口机制 A–H + 数值表 + 收敛演算 | 改人口前（已实现） |
| **`2_2.0设计/14_前端设计系统.md`** | 前端视图层契约：Preact+signals、设计令牌、UI 原子、跨特性接口 | **写前端代码前** |
| `2_2.0设计/15_科研系统设计.md` | 学院产 RP 的概率模型 + 三分支科技树 + 效果生效链路 | 改科研/学院前（已实现） |
| `2_2.0设计/改进方向备选池.md` | 待选扩展点 | 想新功能时 |
| `服务器客户端同步与UI刷新.md` | 服务端事件定向推送与客户端按需刷新机制 | 新增事件推送或调整页面刷新时 |
| `经济与金币模块.md` | 五类资源惰性结算、金币税收与经济派生管线 | 改资源、金币或产率结算时 |
| `贸易模块.md` | 贸易中心、NPC订单、玩家挂单与商队路线实现 | 改贸易流程或商队时 |
| `服务器/README.md` | 服务器文档区指路 | 找运维文档时 |
| **`服务器/01_数据存储结构.md`** | 存档格式、每个集合的 schema、主键规则 | 改数据 / 排查存档问题前 |
| **`服务器/02_数据库操作手册.md`** | 查看/备份/手改/刷档/删档/换DB | 运维数据 / 刷档时 |
| `服务器/03_GM调试手册.md` | GM 调试命令 / 手动改档技巧 | 联调 / 排障时 |
| `美术资源清单.md` | 命名/引用约定 + 清单概览（事实源是 `tools/art_manifest.json`） | 做美术时 |
| `美术生成规范.md` | 洋红幕布抠像流水线 + 风格块 + 成套一致性自查 | 做美术时 |
| `部署手册_腾讯云轻量服务器.md` | 部署步骤 + 需你提供的信息 | 上线时 |

> `docs/archive/` 里是**已上线系统的一次性实现规划**（建筑重构、人口 v2、旧版美术 prompt）。它们的结论已并入上表的常青文档，
> **AI 默认不要读**，只在考古"当初为什么这么设计"时才翻。规划文档上线即归档，见变更契约 R4。

### 已上线模块的实现参考文档（docs/ 根目录）

按模块组织的"实现参考"，与上方"设计/规范"文档互补——这里讲"现在的状态"，设计文档讲"为什么这么设计"。

| 文档 | 作用 | 何时看 |
|------|------|--------|
| `贸易模块.md` | trade 模块（NPC 订单 + 玩家挂单 + 路线回收 + NPC 宝物栏满溢出）+ 2026-08 新增「危险操作·拆除贸易中心」 | 改贸易/挂单/商队/栏满三选一时 |
| `宝物模块.md` | treasure 模块（MULTISET 语义 + 待领取 pending + 归途 ETA 精化 + 与军队/建筑/贸易的交互） | 改宝物/掉落/携带/领取/出售时 |
| `雇佣兵营地模块.md` | mercenary 模块（金币购买名单 + 自动囤积 + 升级不重 roll + 2026-08 新增「危险操作·拆除雇佣兵营地」） | 改雇佣兵/刷新/招募时 |
| `经济与金币模块.md` | economy 模块（5 资源惰性结算 + 金币税收/自愈）+ 人口交税入账 | 改资源/金币/经济计算时 |
| `科研模块.md` | research 模块（学院 RP 生产 + 科技树 + 双轨效果注入 + 跨村科技 + GM 面板） | 改科技/学院/科研点时 |
| `服务器客户端同步与UI刷新.md` | 跨模块通用：事件→定向推送→onPush 刷新策略（含新增接线步骤与死循环坑） | 加事件/改推送时 |
| **`项目约定与速查.md`** | 部署两条铁律 + 架构/数据迁移踩坑 + 模块与命令速查表 | **第一次改这个项目前** |

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

### 5. 提交（变更契约，强制）
**同一次提交内**必须一起做完，否则 `pre-commit` 钩子拒收：

1. 加了模块/文档 → 更新本文 §四 / §五 索引；加了 CSV → 更新 `config/README.md`
2. 改了 `packages/**/src/` 或 `config/*.csv` → 在 `CHANGELOG.md` 的 `## [未发布]` 加条目
3. 改了落盘结构 → 升 `SAVE_SCHEMA_VERSION` 且条目带 `[需刷档]`；改了协议 → 升 `WIRE_VERSION`
4. commit message 用 `<type>(<scope>): <主题>`
5. 自查：`npm run guard`（秒级）→ 推送前自动跑 `npm run verify:quick`

完整规矩与逃生阀见 [`docs/00_变更契约.md`](./docs/00_变更契约.md)。

---

## 七、金币经济（Gold Economy）

金币是**第 5 种资源**（wood/clay/iron/crop/**gold**），用于雇佣兵体系。核心三点：**来源=人口交税、花费=建造/升级逐等级 gold、用途=买雇佣兵**。

| 环节 | 一句话 | 调参处 |
|------|--------|--------|
| 来源 | 劳动人口交税：`金币/时 = currentPop × goldTaxPerCivilianPerHour`。无自然产出，绑定城镇中心、不受繁荣度影响，无上限 | `game_constants.csv` 的 `gold_tax_per_civilian_per_hour` |
| 花费 | 建造/升级逐建筑逐等级扣 `costGold`，叠加在四资源之上 | `building_levels.csv` 的 `costGold` 列 |
| 用途 | 雇佣兵营地买 10 种雇佣兵：不耗粮、不占人口 | `mercenaries.csv` 的 `goldCost` 列 |

在线改参走 `/gm/balance` 覆盖层（热重载，且**跨部署/刷档存活** —— 它写在 `data/balance_overrides.json`，
部署的 `git reset --hard` 与 `wipe:all` 都不碰）。

**两个已知坑**：① 金币由 population 每 30s 的结算 tick 持续累加，离线照常增长，资源条速率是真的；
② 金币功能上线前的老存档可能缺字段或残留 `null/NaN`，`economy.settle` 每次结算会自愈成合法值，无需手改档。

完整机制（惰性结算、派生管线、自愈细节）见 `docs/经济与金币模块.md`。

---

## 八、当前状态与下一步

**已完成**：架构 + 通信规范 + 11 大模块 + **高比例配置驱动**（含全局常量/开局模板 CSV 化 + 启动校验器）+ **服务端统一配置下发（`GetGameConfig`）** + **前端按 feature 拆分** + **gateway 声明式 manifest 路由** + 可玩前端 + 多人 + PvP + 账号密码 + 三种族 + JSON持久化（WAL + fsync 快照）+ 重启恢复 + 部署套件 + **六边形地图/逐格行军** + **有状态 tick 战斗（近战/远程 + 特性 + 实时推送）** + **人口系统 v3 硬上限模型（hardCap 由建筑累加/availableLabor 门控/五轴统一 prosperityMult/增长收敛/粮荒减员/医院即时回收战死/铁匠耗时/ConsumePop 腾空间/military 逃兵）** + **协议/频控/串行化加固** + **正式美术接入** + **地图交互（鼠标拖拽平移 / 滚轮缩放 / 悬停信息浮层 / 点击派兵）** + **真·环面世界（平行四边形 torus 无缝环绕）** + **视口剔除渲染（平移/缩放/跳转即时重绘）** + **全图数据一次拉取（GetArea full:true）** + **金币经济（第 5 资源·人口交税·建造/升级 per-level costGold·雇佣兵营地+10 雇佣兵）** + **GM 平衡调参面板 `/gm/balance`（覆盖层热重载·跨部署/刷档存活）** + **科研系统（学院 RP 生产·科技树三分支 AND/OR 依赖·双轨效果注入·跨村全局科技·GM 科研面板）** + **前端 Preact 重构（深色设计系统 + 村庄可视化场景 + 地图地形贴图 + 实时战斗面板 + 全套 123 张美术）**。提交前跑 `npm run verify`（lint + 类型检查 + 服务端/客户端测试）。

**部署**：见 `docs/部署手册_腾讯云轻量服务器.md`（实操版，含 pm2 保活、数据备份）。本地生产模式 `npm run build && npm start`（与 pm2 `ecosystem.config.cjs` 同入口：`packages/server/dist/main.js`）。

**可选下一步**：
- 域名 + HTTPS（正式公开需要，可帮配 Nginx + 免费证书）
- 种族特性差异化（专属建筑/加成）、英雄/工会等养成系统

---

## 九、项目约定与坑 · 项目速查表

历次部署/开发踩坑总结（部署两条铁律、架构与数据迁移坑）与模块/命令速查表，
已拆到 **[`docs/项目约定与速查.md`](./docs/项目约定与速查.md)**（入口文件有 300 行预算，见变更契约 R1）。
**第一次改这个项目前先通读那一篇。**

