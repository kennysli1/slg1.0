# 世界之王（KOW）项目地图

> 多人在线、服务器权威、实时推进的网页 SLG。全栈 TypeScript，npm workspaces monorepo。
> 开始工作先读 [CLAUDE.md](./CLAUDE.md)；硬性变更规则见 [docs/00_变更契约.md](./docs/00_变更契约.md)。

## 一、技术与目录

- `packages/shared`：客户端与服务端共享的 Wire 类型及内部消息基础类型。
- `packages/server`：Fastify、WebSocket、领域逻辑和 JSON/WAL 持久化。
- `packages/client`：Preact + signals + Vite 客户端。
- `packages/dice-lab`：独立筛色子实验场（Fastify + Preact），不读取或写入 KOW 游戏存档。
- `config`：CSV 游戏配置；表清单及编辑约定见 `config/README.md`。
- `docs`：按需读取的当前参考；`docs/archive` 只保存历史设计，不作为实现依据。
- `scripts` / `tools`：质量闸门、生产冒烟、部署及美术工具。

## 二、当前架构

```text
gateway/   外部协议、鉴权、会话、payload 校验和推送
    ↓
modules/   领域 owner；每块持久状态只有一个 owner
    ↓
infra/     Store、Scheduler、CommandBus、EventBus、配置和通用算法
```

约束：领域模块不能依赖 `gateway` 或其他领域模块；跨 owner 写入走窄契约，广播通知走 Event；未来任务统一登记 Scheduler；派生属性只输出最终快照。外部 action 路由集中在 `gateway/routes.ts`，不会污染领域模块。

## 三、服务端 owner 清单

| 模块 | 状态 owner / 职责 |
|---|---|
| `player.ts` | 账号、登录凭据、玩家与村庄归属 |
| `economy.ts` | 五类资源、产率、容量、维护费与经济加成 |
| `building.ts` | 建筑实例、区域槽位与建造队列 |
| `military.ts` | 常规兵力、训练队列与铁匠养成（含探险家协会的冒险者） |
| `population.ts` | 劳动人口、士兵人口、硬上限与繁荣倍率 |
| `world.ts` | 六边形地图、地块与坐标 |
| `vision.ts` | 玩家探索记录、城池/行军视野与地图战争迷雾 |
| `pve.ts` | PvE 守军、战利品与重生 |
| `movement.ts` | 出征、运输、拦截与返程中的部队 |
| `diplomacy.ts` | 玩家对盟军/中立/敌对关系与宣战 |
| `reputation.ts` | 玩家声望、声望效果与跨模块调整 |
| `kingdom.ts` | 玩家封地归属、循环王国任务与议会厅服务订单 |
| `combat.ts` + `combat/` | 进行中的逐 tick 战斗；准入、纯引擎、战利品规划与可恢复结算均归 combat owner |
| `mercenary.ts` | 雇佣兵营地、候选与刷新任务 |
| `trade.ts` | NPC/玩家订单、贸易中心与路线占用 |
| `treasures.ts` | 宝物库存、随军宝物和待领取宝物 |
| `alchemy.ts` | 炼金炉输入槽、炼化调度、掉率抽取与收获结果 |
| `research.ts` | 科研点、研发任务和已完成科技 |
| `tasks.ts` + `task/` | 主线/随机任务进度、任务营地与 M8/M9/M13 任务村生命周期；状态、玩家归属 Command 目录与任务图适配器均为 task owner 内部实现 |
| `dialogues.ts` | 任务绑定的 NPC 对话 session 与对话配置查找（session 不落盘） |
| `dice-quest.ts` + `dice-quest/` | 骰子王任务的临时对局、普通骰子规则与 NPC 回合；不落盘对局，不依赖骰子实验场 |
| `notifications.ts` | 通知和战报历史 |
| `meta.ts` | 无持久状态；下发客户端渲染所需配置 |
| `packages/dice-lab` | 独立小游戏服务；内存会话、筛色子规则与 NPC，不属于主游戏领域 owner |

组装与生命周期在 `packages/server/src/app.ts`；外部协议路由在 `packages/server/src/gateway/routes.ts`。基础设施包括 `event-bus.ts`、`command-bus.ts`、`scheduler.ts`、`store.ts`、`config.ts`、`config-authority.ts`（配置中心版本/共享镜像/异步同步）、`csv.ts` 等。

## 四、客户端地图

- `app/`：状态、启动、刷新和服务端配置缓存。
- `shell/`：连接生命周期、顶栏、资源栏和页签。
- `features/`：login、village、army、map、research、reports、trade 等业务页面。
- `ui/`：通用 UI 原子；`styles/tokens.css` 是设计令牌来源。
- `shared/`：格式化、错误文案、转义和六边形工具。

## 五、活跃文档路由

| 文档 | 何时读取 |
|---|---|
| `00_变更契约.md` | 修改或提交任何内容前 |
| `Git协作规范.md` | 开始、继续、同步、提交、PR、合并或恢复任何修改时 |
| `2_2.0设计/01_定位与改动方针.md` | 判断产品方向与范围 |
| `2_2.0设计/02_系统清单.md` | 查看系统取舍和后置范围 |
| `2_2.0设计/03_架构总览.md` | 修改架构或增加 owner |
| `2_2.0设计/04_通信格式规范.md` | 修改 Wire、action、Command 或 Event |
| `2_2.0设计/05_技术栈与工程结构.md` | 构建和工程环境问题 |
| `2_2.0设计/06_代码导读.md` | 第一次跟踪端到端链路 |
| `2_2.0设计/07_扩展与代码规范.md` | 增加内容、机制或模块 |
| `2_2.0设计/10_兵种特性效果表.md` | 增加战斗特性 |
| `2_2.0设计/11_阶段化战斗系统方案策划书.md` | 评审和实现阶段化战斗方案 |
| `2_2.0设计/14_前端设计系统.md` | 修改客户端 UI |
| `2_2.0设计/改进方向备选池.md` | 选择后续功能 |
| `经济与金币模块.md` | 修改资源、金币和结算 |
| `贸易模块.md` | 修改订单和贸易路线 |
| `宝物模块.md` | 修改宝物、携带和待领取流程 |
| `雇佣兵营地模块.md` | 修改雇佣与刷新 |
| `科研模块.md` | 修改科研点、科技树和效果 |
| `服务器客户端同步与UI刷新.md` | 增加推送或调整客户端刷新 |
| `外交模块.md` | 修改玩家关系或行军目标外交门控 |
| `服务器/01_数据存储结构.md` | 修改存档结构或排查数据 |
| `服务器/02_数据库操作手册.md` | 备份、刷档或恢复 |
| `服务器/03_GM调试手册.md` | GM 联调和故障诊断 |
| `配置中心与GM边界.md` | 配置中心、GM 实时状态、CSV 权威、旧覆盖迁移与 GitHub 同步 |
| `任务模块.md` | 修改任务定义、任务图、任务营地、调查行军或 GM 任务编辑 |
| `视野模块.md` | 修改战争迷雾、视野参数或探索行军 |
| `声望模块.md` | 修改玩家声望、声望效果、任务抉择或声望 GM 参数 |
| `王国模块.md` | 修改王都/封地、王国任务、议会厅服务或王国 GM 参数 |
| `炼金炉模块.md` | 修改炼金炉建筑、宝物输入、炼化结果或收获流程 |
| `美术资源清单.md` | 查询资产命名与事实源 |
| `美术生成规范.md` | 生成或替换美术资源 |
| `筛色子实验场.md` | 开发、测试、运行或部署独立筛色子小游戏 |
| `部署手册_腾讯云轻量服务器.md` | 生产部署和回滚 |

## 六、常用路径

- 改平衡/任务定义/对话：从 `/config` 配置中心提交 CSV 变更；字段见 `config/README.md`。
- 改实时游戏状态/任务进度：从 `/gm` 操作，写入 `game.json/WAL`，不改变 CSV。
- 改业务：先从本页 owner 表定位模块，再读对应参考文档和测试。
- 加外部 action：`gateway/routes.ts` + owner 的内部契约；破坏性协议变更升级 `WIRE_VERSION`。
- 改存档：只有不兼容落盘结构才升 `SAVE_SCHEMA_VERSION`，并在 CHANGELOG 标记 `[需刷档]` 与迁移/重置方案。
- 看最近变化：只读 `CHANGELOG.md`。
- 生产部署：`npm run deploy:prod`；只发布远程 `origin/main` 到不可变 `releases/<SHA>`，由 `current` 原子切换，数据独立放在 `shared/`。

## 七、验证

```bash
npm run guard
npm run verify:changed   # 本地提交闸门按变更范围验证
npm run verify           # CI/发版前全量：含发布布局、产物冒烟与 audit
```

提交钩子只执行本地验证，不改变生产环境。合并到远程 `main` 后，再显式执行生产部署。
