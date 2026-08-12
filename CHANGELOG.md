# 变更日志

> **想知道"最近发生了什么"，只看这一个文件，不要去翻 `git log` 猜。**
> 记账规矩见 [`docs/00_变更契约.md`](./docs/00_变更契约.md) R5：改了 `packages/**/src/` 或 `config/*.csv` 的提交，
> 必须在 `## [未发布]` 下加条目，否则提交会被 `npm run guard` 拒绝。
>
> 分类固定：`### 新增` / `### 变更` / `### 修复` / `### 移除` / `### 破坏性`。
> 需要刷档的改动，条目开头加 **`[需刷档]`**（同时必须升 `SAVE_SCHEMA_VERSION`）。

## [未发布]

### 新增

- 新增 15 张科技节点战术徽记，补齐 `research.csv` 的全部美术引用；科技树不再退化为文字占位图标。
- 新增测试入口登记、推送映射一致性与 GM HTTP 路由闸口，避免测试静默漏跑、推送契约漂移及危险路由绕过鉴权。
- 补齐贸易资源守恒与路线生命周期、雇佣兵招募与刷新、科研完整研发与拆除边界的端到端覆盖。
- 新增任务系统（服务端 `tasks` 模块 + 客户端任务栏/地图营地标记）：主线/随机任务接取·放弃·上交资源推进，酒馆建造触发随机任务刷新，`clear_camp` 任务在地图生成营地、清掉后移除；接取/放弃/完成经 `TaskListChanged`/`TaskMapUpdated` 推送刷新。

### 变更

- 前端美术与表现升级为“边境战争沙盘”方向：重构应用 HUD、村庄经营驾驶舱、地图出征工作流、科技节点路径与报告时间线，并统一提高字体对比度、触控尺寸和图片承载清晰度。
- `PROJECT.md` 测试索引改以 `all.test.ts` 为唯一清单，并压缩回行数预算；`README.md` 同步当前技术栈、功能与验证命令。
- 导出网关 `MODULE_MANIFESTS` 与通知 `EVENT_MAP` 供契约测试读取唯一真相，并移除从未发射的陈旧 `treasure.Dropped` 映射。

### 新增

- **前端视图层改为 Preact + @preact/signals**：组件化渲染取代模板字符串 `innerHTML` 拼接；`app/store.ts` 提供 1 秒心跳 `tick`、数据版本 `dataVersion`、弹层栈与 Toast，数据刷新只做局部重渲，不再整页重建 DOM（顺带消灭了「刷新打断输入/丢焦点」和地图拖拽被打断的老毛病，`isInteracting()` 兜底逻辑随之删除）
- **全新设计系统**（`src/styles/tokens.css` + `frame.css`）：深色石质面板 + 鎏金浮雕描边的视觉基调，配色/间距/字号/层级全部收敛为 CSS 变量；配套 UI 原子 `src/ui/`（`Icon`/`IconPlate`/`Panel`/`Btn`/`Bar`/`TimerBar`/`CostRow`/`Modal`/`Stat`）
- **村庄可视化场景**：主界面新增手绘俯视村庄底图，建筑按固定坐标坐在垫台上、点击弹面板，保留「列表管理视图」一键切换（偏好存 localStorage）
- **地图改用真实地形贴图**：9 种手绘地块（草原×3/森林/丘陵/水域/绿洲/村落/废墟）裁进六边形，村庄/野怪按归属与难度用描边色区分
- **实时战斗面板**：服务端本就在推 `BattleTick`，此前前端完全没展示；现在报告页顶部显示双方兵力对抗条、逐兵种残余与战损
- **铁匠铺升级入口**：服务端 `UpgradeSmithy` 动作此前无任何界面可用，现补上锻造面板 —— 精确造价（木/泥各 `smithyCostBase`×目标等级，与服务端同公式）、基础耗时、真实起止时刻的进度条、资源不足与互斥占用的禁用理由
- 服务端补齐锻造界面所需数据：`GetGameConfig.constants` 增发 `smithyCostBase`，`GetArmy` 增发 `pendingSmithy { unit, startAt, doneAt }`（调度器内部 `taskId` 不外泄）；`pendingSmithy.startAt` 为新增可选字段，老存档缺失时读取方按 `null` 兜底，**不需要刷档**
- `server/src/test/smithy.test.ts`：铁匠养成此前零测试覆盖，补上造价公式、`pendingSmithy` 下发契约、并发互斥、资源不足四项
- **战报结构化**：战报从裸字符串改为 `StoredReport { text, kind, ts }`，分类由 `notificationKind(event, payload)` 在写入时按**事件名**算好（不是回头正则匹配中文文案——宝物名里带「人口」就会误判）；报告页按类别上图标色带并支持筛选
- 手机端专属布局：紧凑顶栏 + 资源条横向滚动 + 贴底页签栏，弹窗改贴底抽屉，点击目标 ≥44px
- 美术流水线 `tools/art_pipeline.py`（洋红幕布抠像 + 去溢色 + 裁切 + 降采样 + WebP 编码）、资产清单 `tools/art_manifest.json`（123 条）、抠像自查 `tools/art_check.py`、拼版自查 `tools/art_sheet.py`、底图垫台测量 `tools/scene_pads.py`
- 新增 `docs/2_2.0设计/14_前端设计系统.md`：前端视图层契约（架构三条规矩 / 设计令牌 / UI 原子 / 跨特性接口 / 自查清单）
- 引入《变更契约》与四道自动闸门：`npm run guard` 校验文档分层/front-matter/索引一致/CHANGELOG 记账/版本号同步，挂到 `pre-commit`、`commit-msg`、`pre-push` 与 GitHub CI
- 新增存档结构版本号 `SAVE_SCHEMA_VERSION`（`packages/server/src/infra/schema-version.ts`），与 CHANGELOG 的刷档声明双向绑定

### 变更

- 科研系统接入新前端：科技页（科研点面板 + 三分支 + 分层卡片）与学院弹窗按新设计系统重写，新增「科技」页签，`RpChanged`/`TechCompleted` 推送只重拉科研快照
- 补齐并行合入的科研系统欠下的变更契约债：`research` 模块与 `15_科研系统设计.md` 进 PROJECT.md 索引、`research.csv`/`academy.csv` 进 `config/README.md`、三篇文档补 front-matter
- `PROJECT.md` 超出 300 行预算（合并后 516 行），按 R1 把「项目约定与坑 / 速查表」拆到 `docs/项目约定与速查.md`，金币小节收敛为要点表并指向 `docs/经济与金币模块.md`，目录树不再重复罗列 CSV（`config/README.md` 才是唯一索引）
- **全套美术按新风格重做并补齐**：123 张资源（原 45 张，其中 5 张还是占位图；配置里被引用却缺文件的 52 个基名全部补上——高卢/条顿各 10 兵种、10 雇佣兵、16 宝物、5 建筑、金币图标）
- **美术格式从 PNG 改为 WebP**：同画质体积降到约 1/5，全套约 5MB；`artPath()` 统一拼 `.webp`，仅 `ui_logo` 另存 PNG 供 PWA 图标使用
- 建筑/兵种/宝物图标统一坐在凹陷石板底座上（`IconPlate`），透明美术不再悬浮参差；图标显示尺寸整体放大，美术终于看得清
- 危险操作（拆除/解散/放弃村庄）从 `window.confirm` 改为面板内二次确认
- 每个页面都有真正的空态引导（军队页与报告页此前是整片空白）
- 战报文案去掉 emoji 前缀，改由界面的分类图标承担语义
- `CLAUDE.md` 收敛为 L0 入口（红线 + 任务路由表），`PROJECT.md` 成为模块清单与文档清单的唯一索引；`docs/00_README.md` 与 `docs/服务器/README.md` 去掉重复索引改为指路
- 已上线系统的一次性实现规划（建筑重构、人口 v2）归档到 `docs/archive/`；`美术生成-成品prompt-中文.md` 被 `tools/art_manifest.json` 取代后一并归档
- Service Worker 缓存名升到 `kow-v2`，PWA 主题色改为深色，强制作废旧壳与旧图

### 修复

- **所有耗时/倒计时显示恒为「0秒」**：时长格式化只有一个收「目标时刻」的函数，而消耗预览、建造进度条等调用方传的是**时长**，`ms − Date.now()` 变成大负数被夹到 0。拆成 `fmtDur`（收时长）与 `secLeft`（收时刻）两个语义明确的原语，补上回归测试，并顺手支持「时」量级（长建造不再显示「180分0秒」）
- `BattleTick` 覆盖式写入战斗快照，会把只在 `BattleStarted` 里出现的攻防数值与目标信息抹掉；改为合并写入
- 历史战报的时间戳取错字段（`notification.at`，实际是 `ts`），导致登录后拉回的战报时间全是 Invalid Date
- `PopulationChanged` 推送是增量载荷，此前按全量字段套用会把上限、繁荣度等一片数值误清成 0；现在缺字段一律沿用旧快照
- 地图拖拽、双指移动或缩放导致主城偏离中心后，方向键中央的回城键会立即启用并可一键重新居中

### 移除

- 旧的字符串渲染层：`app/bootstrap.ts`、`style.css`（965 行单文件）、`shared/ui/widgets.ts`、`shared/ui/toast.ts` 及各 feature 的 `render*/bind*` 实现
- 过时的美术脚本 `tools/gen_art.py`（128px 占位图生成器）与 `tools/optimize_art.py`（PNG 降采样），职责已并入 `tools/art_pipeline.py`

---

## 更早

0.0.1 之前没有正式发版记录，历史请查 `git log`。从本版本起所有改动都在上面记账。
