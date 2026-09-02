# 配置表说明（config/）

> 游戏静态数值都在这些 CSV 里。正式修改请使用 `/config` 配置中心：保存会校验并进入配置同步/PR流程；直接编辑 CSV 仅适合本地开发服。
> 编辑注意：① 保持首行表头不动 ② 用英文逗号分隔（Excel 另存为 CSV 会自动处理）③ 文字不要含逗号 ④ 存为「CSV UTF-8」编码避免中文乱码。
>
> **编码已修复**：所有 CSV 已写入 UTF-8 BOM，Excel 双击打开不再中文乱码。另存时请保持「CSV UTF-8(逗号分隔)」格式。
>
> **字段注释行**：每张表表头下方有一行以 `#` 开头的中文字段说明（如 `#数字ID,代码标识,...`），配置时可直接对照，**后端解析时会自动跳过这一行，不影响游戏**。编辑数据时不要动这行；若想重建注释或改了表头，运行 `python tools/annotate_csv.py` 重新生成。

---

## ⭐ 两个全局约定（2.0 起，务必先读）

### 1. 主键 id 与代码 code —— 跨表引用一律用数字 id
目录表（`buildings` / `units` / `pve_targets`）每行有两个标识列：

| 列 | 是什么 | 谁用 |
|----|--------|------|
| `id` | **数字主键**（1,2,3…，每张表各自从 1 开始） | **CSV 里跨表引用就填它**：建筑前置 `requires`、兵种所需建筑 `building`、守军/分布点的 `targetId` |
| `code` | **英文代码**（如 `barracks`、`legionnaire`） | 程序内部与存档用，**勿改**（改了等于换了一个新对象） |

> 为什么这样设计：配置时引用只写数字（如 `building=4` 表示兵营），简洁不易错；而代码内部仍用稳定的英文 code，CSV 行重排也不会错乱。两者在后端加载时自动互转，你只管按下面的规则填数字。
>
> **资源（`resources`）与部族（`tribe`）例外**：主键保持语义串（`wood`/`clay`/`iron`/`crop`、`romans`/`gauls`/`teutons`），因为它们是程序里的结构字段名，不参与"按 id 引用"。

### 2. icon 只填基名 —— 不写路径、不写后缀
所有 `icon` 列只填**图标基名**，如 `bld_barracks`、`unit_legionnaire`、`res_wood`。
渲染时前端自动拼成 `/art/<基名>.png`（美术根 `packages/client/public/art/`）。
换美术只需按同名覆盖图片文件，**不动 CSV、不动代码**（命名规范见 `docs/美术资源清单.md`）。

---

## 📋 速查总表：要改什么 → 改哪张表

| # | 文件 | 配什么（一句话） | 想改这些就动它 |
|---|------|----------------|---------------|
| 表1 | `resources.csv` | **资源种类**（木/泥/铁/粮） | 加一种新资源、改资源显示名/图标 |
| 表2 | `buildings.csv` | **全部建筑**（含资源田；`zone` 分主基地/城内/城外） | 改建筑或资源田的成本/耗时/产量/最高等级、每村最多建造数、主基地最低等级、改科技树前置、改归属区；探险家协会、联盟大厅在此配置 |
| 表3 | `town_center_slots.csv` | **主基地 1–4 阶段开放的槽位**（城内/城外槽位数 + 建造队列条数） | 调发育节奏、调城内外取舍强度、调队列条数 |
| 表4 | `units.csv` | **兵种**（罗马/高卢/条顿；`all` 为通用兵种） | 改兵种攻防/生命值伤亡池/速度/视野/载货/耗粮/造价、加新兵种、加新部族；`simTraits` 为独立阶段化模拟器特性引用；冒险者为 `all` 通用侦察兵种 |
| 表5 | `pve_targets.csv` | **野怪/PvE目标模板**（老鼠窝/野狼群/强盗营地/王国城邦） | 改目标战利品、重生时间、显示名/图标、加新目标类型；`kingdom_city_state` 的内容由运行时配置随机生成 |
| 表6 | `pve_defenders.csv` | **野怪的守军**（每个PvE目标里有哪些怪、几只、多强） | 改某目标守军的种类/数量/三维/模拟器生命值与特性 |
| 表7 | `pve_spawns.csv` | **野怪在地图上的位置**（哪个坐标放哪种目标） | 增删地图上的PvE点、改其坐标 |
| 表8 | `game_constants.csv` | **全局常量**（城墙、容量公式、地图尺寸、M8任务村参数等） | 调平衡参数；原先写死在代码里的常量都在这 |
| 表9 | `village_templates.csv` | **各部族开局预置建筑**（含资源田）+ 初始资源 | 改新手村开局；给不同部族不同起手 |
| 表10 | `building_levels.csv` | **建筑逐等级独立参数** | 调某一级建筑成本、耗时、人口、产量、宝库槽位或保险库资源保护量 |
| 表11 | `mercenaries.csv` | **雇佣兵目录与金币价格** | 调雇佣兵属性、阶段化模拟器生命值、价格或增删雇佣兵 |
| 表12 | `merc_camp.csv` | **雇佣兵营地逐级刷新参数** | 调候选数量、刷新间隔和可囤刷新次数 |
| 表13 | `trade_center.csv` | **贸易中心逐级能力** | 调路线数、交易视野、NPC订单和刷新节奏 |
| 表14 | `treasures.csv` | **宝物目录、效果、价格与掉率** | 调宝物效果、稀有度、NPC价格和出现概率；`my_effort` 使用 `my_effort_use` 对话，`black_badge` 提供 PvE 掉率与军队加成 |
| 表15 | `research.csv` | **科技树目录**（分支/层级/主基地最低等级/前置/RP 造价） | 加科技、调研发耗时与作用域 |
| 表15a | `research_effects.csv` | **科技效果明细**（一个科技可配多条） | 调科技真实效果、目标、叠加上限 |
| 表16 | `academy.csv` | **学院逐级出点参数**（判定间隔与概率曲线） | 调科研点产出速度与保底强度 |
| 表17 | `quest_lines.csv` | **任务线目录**（入口与展示顺序） | 增加/调整独立任务线 |
| 表18 | `quests.csv` | **任务节点目录**（归属任务线、类型与重复规则） | 增加任务、改名称/描述和刷新属性 |
| 表19 | `quest_conditions.csv` | **任务条件**（何时出现、可接取或失败） | 调触发条件与门槛 |
| 表20 | `quest_objectives.csv` | **任务目标**（可逐行审查） | 调完成目标与参数 |
| 表21 | `quest_effects.csv` | **任务效果**（接取/完成/交付/失败） | 调奖励、分支效果与顺序 |
| 表22 | `quest_edges.csv` | **任务关系边**（前置与分支解锁） | 调任务依赖、成功/失败后续 |
| 表23 | `pvp_power_curve.csv` | **PvP 强弱差掠夺衰减曲线** | 调大打小的战利品倍率 |
| 表24 | `kingdom_services.csv` | **议会厅王国服务目录** | 调等级门槛、声望价格、增援/代打兵力、物资、宝物和延迟 |
| 表25 | `dialogues.csv` | **NPC 对话 session 目录** | 调任务触发点、NPC 名称/文本和玩家回复选项 |
| 表26 | `alliance_levels.csv` | **联盟等级与成员容量** | 调联盟大厅等级对应的联盟等级、成员上限与说明 |
| 表27 | `alliance_buildings.csv` | **联盟建筑目录** | 调联盟建筑最高等级、解锁等级、资源成本与成员加成 |
| 表28 | `alliance_tech.csv` | **联盟科技目录** | 调联盟科技最高等级、解锁等级、科技点成本与成员加成 |

`quest_objectives.csv` 的 `kind` 还支持 `dice_match`，参数格式为 `difficulty:targetScore:winsRequired`（例如 `easy:2000:1`、`normal:4000:2`、`hard:6000:2`），用于骰子任务的独立对局目标；`reputation_at_least`/`reputation_at_most` 分别表示声望达到阈值或更高/更低。`easy`、`normal`、`hard` 分别对应简单、普通、困难 NPC。

> **常见操作举例**
> - 想让军团兵更强 → 表4 `units.csv`，改 legionnaire 行的 meleeAtk。
> - 想让老鼠窝掉更多资源 → 表5 `pve_targets.csv`，改 rats 行的 lootWood 等。
> - 想给老鼠窝加更多守军 → 表6 `pve_defenders.csv`，给 `targetId=1`(老鼠窝) 加一行新怪。
> - 想在地图多放几个强盗营地 → 表7 `pve_spawns.csv`，加几行 `targetId=3`(强盗营地) 的坐标。
> - 想让兵营不需要前置就能造 → 表2 `buildings.csv`，把 barracks 行的 requires 清空。

---

## 各表字段详解

## resources.csv — 资源种类
| 列 | 含义 |
|----|------|
| id | 资源标识（语义串 wood/clay/iron/crop，**勿改**——程序结构字段名） |
| name | 显示名 |
| icon | 图标基名（如 `res_wood`，渲染时拼 `/art/res_wood.png`） |
| note | 备注 |

## fields.csv — 已废弃（资源田并入 buildings.csv）
> 资源田现在是 `buildings.csv` 里 `zone=outer` 且填了 `resource/prodBase/prodGrowth` 的行。此表已删除。

## buildings.csv — 全部建筑（含资源田）
| 列 | 含义 |
|----|------|
| id | 数字主键（跨表引用用：被 units.building、其它建筑的 requires 引用） |
| code | 英文代码（程序/存档用，勿改） |
| name / icon | 显示名 / 图标基名 |
| zone | 归属区：`center`(主基地,唯一) / `inner`(城内·民生研发) / `outer`(城外·生产量产)。资源田填 `outer` |
| resource | **仅资源田填**：产出哪种资源（对应 resources.csv 的 id）；非产出建筑留空 |
| prodBase | **仅资源田填**：1级每小时产量基数 |
| prodGrowth | **仅资源田填**：每级产量增长倍率（如1.3=每级+30%） |
| costWood/.../costGrowth | 成本与增长（升n级成本 = costX × costGrowth^(n-1)） |
| timeBase / timeGrowth | 耗时与增长 |
| maxLevel | 最高等级；主基地固定为 4，其他建筑按各自目录配置 |
| maxCount | 每座村庄最多可建造数量；`-1` 表示不限制。达到上限后建造列表隐藏该建筑，服务端也会拒绝继续建造 |
| mainBaseLevel | 建造或升级该建筑所需的主基地最低等级；默认 1，配置中心可调 |
| requires | 前置：`建筑数字ID:等级`，多个用 `\|` 分隔，如 `1:3`（主基地3级）。空=无前置 |

> **加建筑只需加一行并填 `zone`**：城内外分池 + 侧边栏可建清单全部由 zone 自动归位，前端无需改代码。
> 资源田是 `zone=outer` 且填了 `resource/prodBase/prodGrowth` 的建筑，与普通建筑走同一套"点空槽建造/升级"逻辑。

## building_levels.csv — 建筑逐等级独立参数
| 列 | 含义 |
|----|------|
| code / level | 建筑代码 / 目标等级（须覆盖该建筑 `1..maxLevel`） |
| costWood/costClay/costIron/costCrop/costGold | 建造或升级到该级的五资源成本 |
| timeSec | 建造或升级到该级的耗时（秒） |
| popCap | 该级相对上一级新增的人口硬上限 |
| prod | 仅资源田填写：该级每小时产量 |
| treasureSlots | 仅宝库填写：该级相对上一级新增的宝物栏槽位 |
| storagePerLevel / defensePerLevel | 仅仓库/粮仓或城墙填写：该级仓储容量或城墙防御增量 |
| taskRefreshSec / taskMaxTasks | 仅酒馆填写：任务刷新间隔（秒）/同时展示的任务槽数；等级越高可分别调得更快、更多 |
| taskSideQuestChance | 仅酒馆填写：每个任务槽刷新为“酒馆触发型”支线任务的概率（0..1）；未抽中时刷新日常任务 |
| vaultProtectWood/vaultProtectClay/vaultProtectIron/vaultProtectCrop/vaultProtectGold | 仅保险库填写：该级新增保护量，按等级累加；攻城拆除后按剩余等级生效 |

主基地（`code=main`）是村庄发展阶段指标：1 级“村落集市”（一本）、2 级“领主庄园”（二本）、3 级“城镇大厅”（三本）、4 级“中央主堡”（四本）。四个阶段分别开放 `town_center_slots.csv` 的槽位；每升一级增加四个城内格和四个城外格，并沿用逐级人口增长与建造提速参数。主基地不可拆除，也不会被攻城建筑损伤。`mainBaseLevel` 是所有建筑的主基地门槛列，`maxCount` 是每村数量上限列。

## research.csv — 科技树目录
| 列 | 含义 |
|----|------|
| id / code | 数字主键 / 稳定英文代码 |
| branch / tier | 科技分支 / 层级 |
| mainBaseLevel | 研发该科技所需的主基地最低等级；默认 1，配置中心可调 |
| requires | 前置科技 code（`|` 为 AND，`OR` 表示备选路径） |
| durationSec / rpCost | 研发耗时（秒）/科研点消耗 |

## town_center_slots.csv — 主基地槽位曲线（1–4级）
| 列 | 含义 |
|----|------|
| tcLevel | 主基地等级（需覆盖 1..主基地maxLevel，逐级写全） |
| innerSlots | 该等级开放的城内槽位数（须单调不减） |
| outerSlots | 该等级开放的城外槽位数（须单调不减） |
| queueSlots | 该等级的建造队列条数（≥1；可随等级增长） |
| unlockNote | 里程碑说明（仅注释，程序不读） |

当前默认槽位为：1级城内4/城外6、2级8/10、3级12/14、4级16/18；每次升级分别增加4个城内格和4个城外格。

> **发育节奏与取舍强度的总阀门**：槽位总量始终 < 想盖的建筑总数 → 玩家必须放弃某些流派。
> 想让玩家发育更快就调大 slots；想让城内外取舍更狠就压低满级 slots。

## units.csv — 兵种（含三部族与通用兵种）
| 列 | 含义 |
|----|------|
| id | 数字主键 |
| code | 英文代码（程序/存档用，勿改） |
| tribe | 所属部族（语义串 romans/gauls/teutons；`all` 表示所有部族可训练） |
| name / icon | 显示名 / 图标基名 |
| form | 形态：`melee`(近战/前排) 或 `ranged`(远程/后排)。取代旧的 cat |
| meleeAtk | 近战攻击力（近战兵永远用它；远程兵被迫肉搏时用它） |
| rangedAtk | 远程攻击力（远程兵后排放输出时用它） |
| meleeDef | 近战防御（被近战攻击时的承伤耐久） |
| rangedDef | 远程防御（被远程攻击时的承伤耐久） |
| speed | 速度（格/小时，决定行军快慢） |
| vision | 视野（六边形格数；军队取数量最多兵种的视野，并列时取较大值） |
| carry | 单兵载货（搬战利品） |
| popCost | 训练/在途/驻军占用的人口；所有兵种返程、解散都会按此值返还。拓荒者每名占用 5 人口，成功建城后由出发城永久转移，新城以 5 人口开局 |
| upkeep | 每兵每小时耗粮 |
| costWood/Clay/Iron/Crop | 训练一个的成本 |
| trainSec | 训练一个耗时（秒） |
| building | 训练所需建筑（填**建筑数字ID**，如 4=兵营、5=马厩） |
| traits | 线上战斗特性ID列表（竖线分隔，引用 **unit_traits.csv 的数字 id**，可空） |
| hp | 阶段化战斗模拟器的单兵生命值伤亡池（只读 CSV 的实验规则） |
| simTraits | 阶段化战斗模拟器专用特性ID列表；与 `traits` 分开，避免影响线上旧战斗 |
| techTier | 战斗科技档位标签（1/2/3）；用于解锁、目录和数值验收，不直接乘战斗力 |

> 加新部族/兵种：直接加行即可（id 接着往后排）。战斗只区分近战/远程，靠攻防四列 + 特性表达。探险家协会训练 `adventurer`：攻击力为0，可探索/执行侦察，但不具备发现侦察部队的能力；被真实侦察兵发现时冒险者全部失去。

## mercenaries.csv — 雇佣兵目录
| 列 | 含义 |
|----|------|
| id / code | 数字主键 / 稳定英文代码 |
| tribe | 固定为 `merc`，表示全种族可用 |
| name / icon | 显示名 / 图标基名 |
| form | `melee` 或 `ranged` |
| meleeAtk/rangedAtk | 近战/远程攻击 |
| meleeDef/rangedDef | 近战/远程防御 |
| hp | 阶段化战斗模拟器的单兵生命值伤亡池 |
| speed / carry | 行军速度 / 单兵载货量 |
| upkeep | 每小时耗粮；雇佣兵当前固定为 0 |
| costWood/costClay/costIron/costCrop | 普通训练资源成本；雇佣兵固定为 0 |
| trainSec / building / traits | 训练秒数 / 所需建筑 / 线上战斗特性；当前均留空或为 0 |
| simTraits | 阶段化模拟器特性ID列表（竖线分隔；与线上 `traits` 隔离） |
| popCost | 训练/在途/驻军占用的人口；所有兵种返程、解散都会按此值返还。拓荒者每名占用 5 人口，成功建城后由出发城永久转移，新城以 5 人口开局 |
| goldCost | 在雇佣兵营地购买单个兵种的金币价格 |
| commandCost | 单份合同占用的佣兵统御容量 |
| contractSec | 合同服役秒数；离线继续计时 |
| tier | 佣兵档位，用于展示与平衡分组 |

## merc_camp.csv — 雇佣兵营地逐级参数
| 列 | 含义 |
|----|------|
| level | 营地等级 |
| refreshSec | 自动刷新候选名单的间隔（秒） |
| mercCount | 每次刷新生成的可雇佣候选数量 |
| maxStoredRefreshes | 最多可囤积的手动刷新次数 |
| capacity | 该等级提供的佣兵统御容量 |

## unit_traits.csv — 兵种特性（攻防之上的额外倍率修正）
| 列 | 含义 |
|----|------|
| id | 数字主键（units.csv 的 traits 列引用它） |
| code | 英文代码（程序内部用，勿改） |
| name | 显示名（如"持盾"） |
| effect1..effect5 | 效果类型代码（枚举，见下；可填多组） |
| value1..value5 | 数值（含义随 effect 而定，如 -0.30） |

> effect 枚举：`dmg_taken_ranged`(受远程伤害倍率) / `dmg_taken_melee`(受近战伤害倍率) / `atk_ranged` / `atk_melee`(自身攻击加成) / `def_ranged` / `def_melee`(自身防御加成) / `enemy_cavalry_atk`(敌骑兵攻击修正) / `ally_ranged_def`(己方另一兵种远程防御修正) / `enemy_ranged_melee_def`(敌远程兵近战防御修正) / `cavalry_charge_atk`(冲锋阶段骑兵攻击修正)。同一属性按加法叠加，减益最低到 0。

阶段化战斗模拟器页面为 `/battle-simulator`。它通过 `battleSimulator.GetCatalog` / `battleSimulator.Simulate` 读取这些 CSV 配置，不读写主游戏存档。
> 加新特性：本表加一行；若新增 effect 类型，先在 `packages/server/src/infra/combat-types.ts` 扩展枚举，再在战斗计算里接入。

## pve_targets.csv — PvE 目标模板
| 列 | 含义 |
|----|------|
| id | 数字主键（被 pve_defenders.targetId、pve_spawns.targetId 引用） |
| code | 英文代码（程序/存档用，勿改） |
| name / icon | 显示名 / 图标基名 |
| respawnSec | 被清空后重生秒数 |
| lootWood/Clay/Iron/Crop | 战利品总量 |
| faction | 阵营（`neutral`/`kingdom`）；王国城邦填 `kingdom` |
| cityState | 是否启用运行时随机城邦生成（`true`） |

配置中的 `tianwang_village` 是 M8 任务村模板；其地图实体由任务模块按接取村庄动态生成，不应手动添加到 `pve_spawns.csv`。模板标注四种资源各 500，实际初始资源和金币由 `m8_task_village_resource_amount` / `m8_task_village_gold` 控制，守军由 `pve_defenders.csv` 的 `targetId=106` 控制。

`secret_camp` 是 M13「寻找神秘人」的任务村模板，不应手动添加到 `pve_spawns.csv`。接取 M13 后，任务模块会在玩家主城第二近的连片丘陵中选择一个空闲丘陵格生成它，并锁定任务所属玩家；初始库存为四种资源各 1000、金币 500，守军由 `pve_defenders.csv` 的 `targetId=107`（8 雇佣卫兵、3 雇佣弓手）提供。调查该目标不会进入战斗；选择掠夺会让 M13 进入失败确认状态。

## pve_defenders.csv — PvE 守军（与上表一对多）
| 列 | 含义 |
|----|------|
| targetId | 属于哪个目标（填 **pve_targets 的数字 id**） |
| unitCode | 守军单位代码（仅此目标内部标签，不跨表引用，保留英文串） |
| name | 显示名 |
| count | 数量 |
| form | 形态：`melee` / `ranged` |
| meleeAtk/rangedAtk | 近战/远程攻击力 |
| meleeDef/rangedDef | 近战/远程防御 |
| hp | 阶段化模拟器的单兵生命值伤亡池 |
| carry | 载货（守军一般0） |
| traits | 阶段化模拟器特性ID列表（竖线分隔；引用 `unit_traits.csv`，可空） |

> 一个目标可有多行守军（如强盗营地 `targetId=3` 有强盗+弓手两行）。

## pve_spawns.csv — PvE 在地图上的分布点
| 列 | 含义 |
|----|------|
| id | 分布点实例 id（如 `pve-0`，勿改——存档用） |
| targetId | 目标类型（填 **pve_targets 的数字 id**） |
| q / r | 六边形轴坐标（地图为六边形网格，q/r 为 axial 坐标） |

> 加目标点 = 加一行。

这些行是必须保留的人工锚点。World 会按实际世界面积自动补足公共 PvE 到 `round(W×H×5%)`；自动点位由 `world_seed` 确定，不写回 CSV，也不进入存档。新世界使用 `world_width/world_height`，已有世界始终优先采用存档中的 `world_meta` 尺寸。

地貌同样由 `world_seed` 确定生成，规则分类为平原 55%、森林 30%、丘陵 15%。森林会按方向降低军队视野，丘陵提高视野但使经过该格的行军速度降为 2/3；拓荒仅允许平原。

地图计划会按 `kingdom_city_state_count` 随机生成王国城邦（`kingdom_city_state`），数量与生成位置均由 `world_seed` 确定。城邦是王国阵营 PvE 目标，运行时随机抽取一级/二级/三级之一，并随机选择罗马、高卢或条顿种族，只从对应种族兵种池抽取守军：一级 3 种、每种 0–20；二级 4 种、每种 5–35；三级 5 种、每种 10–50。三级资源范围分别在 `kingdom_city_state_tier*_resource_min/max` 配置，默认少量/中量/大量递增。城外四类资源田至少各有一座 3 级田。王都和四个封地也使用同一王国 PvE 生成器，分别读取 `capital` / `fief` 档位。城邦、封地和王都侦察都可选择“资源与守军”或“城内外建筑”两种模式；王国 PvE 战斗按消灭人口累计扣声望，不再按侦察/掠夺/攻城固定扣分。`kingdom_city_state_generation_version` 提升后，启动时会按新规则重生成既有王国 PvE。

## game_constants.csv — 全局常量（原硬编码迁出）

声望模块参数也在此表维护：`reputation_s4_release_delta` 控制 S4 释放抉择，`reputation_*_pvp_*` 控制正/负声望玩家按每十点敌方士兵人口击杀获得的声望值与目标门槛，`reputation_good_pop_growth_*` 控制正声望对人口增长的倍率及上限，`reputation_evil_pop_growth_penalty_*` 控制负声望的人口增长下降，`reputation_evil_army_attack_*` / `reputation_evil_army_defense_*` 控制负声望军队攻防倍率及上限，`reputation_good_gold_tax_penalty_*` 控制正声望的金币税收下降，`reputation_evil_pve_drop_rate_*` 控制负声望对 PvE 宝物掉落概率的倍率及上限。王国任务声望权重/奖励/目标门槛、王国 PvE 击杀累计与封地报复阈值/雇佣军比例也属于声望全局参数。配置中心 `/config/balance` 的“声望参数”板块会集中显示并编辑这些全局行，同时直接列出任务声望目标/调整、正声望兑换佣兵参数、宝物被动/直接声望值和议会厅服务声望价格；保存后分别写回对应 CSV，热重载即可生效，无需刷档。

人口繁荣度参数：`pop_prosperity_full_ratio` 是劳动人口占总人口比例达到繁荣满值的阈值（默认 70%），`pop_prosperity_max_bonus` 是满值时资源产量、建造、训练和研究的额外速率加成（默认 +30%）。劳动人口占比在本族动员上限对应的最低值时额外加成为 0；低繁荣度只取消这层额外加成，不降低基础产值或把耗时变长。

王国系统的 `kingdom_*` 行控制封地位置比例、首次/循环任务等待、期限、上贡与击杀目标范围等非声望调度参数；四类任务权重、负声望目标门槛及声望奖励已归入配置中心“声望参数”。王都/四封地守军与掉落仍在 `pve_targets.csv` / `pve_defenders.csv` 调整。
| 列 | 含义 |
|----|------|
| key | 常量键（代码按它读取，**勿改**） |
| value | 值 |
| type | 类型：`number`/`bool`/`string`（决定怎么解析 value） |
| note | 中文说明 |

### 拓荒成本参数

拓荒开城包按每种资源（木材、泥土、钢、粮食）分别收取：第 `N` 座城（`N≥2`）每种资源的需求量为 `round(found_resource_cost_base × found_resource_cost_growth^(N-2))`。当前默认第 2 座城每种资源 3000（四种资源合计 12000），第 3 座城每种资源 6000（合计 24000）。配置中心 `/config/balance` 的“拓荒参数”板块可直接修改并持久化，删档不会清除 CSV 默认值。

当前常量（配置中心保存后热重载，默认值与重构前行为一致）：

| key | 默认 | 作用 |
|-----|------|------|
| wall_bonus_per_level | 0.03 | 城墙每级防御加成（+3%/级） |
| combat_strength | 0.15 | 线上每秒战斗强度；配合 200ms tick 将常规镜像战斗控制在约 30 秒 |
| combat_max_ticks | 180 | 线上战斗安全上限（36 秒）；达到后按守方守住战场 |
| battle_sim_melee_rounds | 8 | 模拟器第三阶段全军近战互殴战术窗口 |
| combat_influence_reference_value | 200 | 基础战斗价值/人口的有效战斗人口参考点 |
| combat_influence_quality_exponent | 1.15 | 有效战斗人口质量指数，放大高质量兵种差异 |
| combat_influence_min_quality / combat_influence_max_quality | 0.65 / 1.55 | 有效战斗人口质量上下限 |
| combat_phase_decision_ratio | 1.15 | 战术窗口结束后，优势方有效战力达到 1.15 倍才判定胜负 |
| combat_value_melee_attack_weight / ranged_attack_weight | 1 / 1.1 | 基础战斗价值中的近战/远程攻击权重 |
| combat_value_melee_defense_weight / ranged_defense_weight | 0.85 / 0.75 | 基础战斗价值中的近战/远程防御权重 |
| combat_value_hp_weight | 0.65 | 基础战斗价值中的生命值权重 |
| combat_phase_cavalry_vs_cavalry_coeff | 0.18 | 模拟器骑兵对冲伤害系数 |
| combat_phase_cavalry_vs_melee_coeff | 0.25 | 模拟器骑兵冲击近战步兵伤害系数 |
| combat_phase_cavalry_vs_ranged_coeff | 0.40 | 模拟器骑兵冲击远程步兵伤害系数（目标用近战防御） |
| combat_phase_ranged_strike_coeff | 0.25 | 模拟器远程打击伤害系数（目标用远程防御） |
| combat_phase_melee_round_coeff | 0.30 | 模拟器第三阶段每轮近战伤害系数 |
| combat_phase_advantage_amplifier | 1.50 | 攻击高于防御时的优势放大系数；攻击低于防御时不额外放大 |
| combat_phase_compare_epsilon | 0.0001 | 模拟器攻城最终阶段判断数值相等的容差 |
| combat_phase_min_survivor_units | 1 | 模拟器攻城最终阶段胜方至少保留单位数 |
| main_build_speedup_per_level | 0.05 | 主基地每级建造提速（-5%耗时/级） |
| main_build_speedup_cap | 0.6 | 主基地提速上限（最多-60%） |
| storage_base | 800 | 仓库/粮仓基础容量 |
| storage_growth_per_level | 0.5 | 容量每级增长系数（+50%基数/级） |
| start_resource_amount | 750 | 新村各资源初始存量 |
| base_production_per_hour | 1000 | 基础产量兼容常量；当前资源田实际产量以 `buildings.csv` 的 `prodBase/prodGrowth` 为准 |
| map_size | 20 | 地图半径（地图为 [-size,size] 方形） |
| map_view_radius | 6 | 前端地图视野半径（前端白名单常量） |
| march_point_base | 0 | 每座城镇的基础行军点数 |
| march_point_per_rallypoint_level | 1 | 集结点每级增加的行军点数；同时在地图上的军队数不能超过基础值加该值×集结点等级 |
| forest_vision_penalty | 2 | 军队视野朝森林方向减少的格数 |
| hills_vision_bonus | 1 | 军队位于丘陵时视野增加的格数 |
| hills_march_speed_multiplier | 0.6666666667 | 军队位于丘陵时的行军速度倍率（默认 2/3） |
| march_size_reference_pop | 20 | 军队规模减速的免惩罚人口基准 |
| march_size_penalty | 0.0015 | 超出基准人口后的规模减速系数 |
| march_size_min_multiplier | 0.45 | 军队规模减速后的最低速度比例 |
| pop_prosperity_full_ratio | 0.70 | 劳动人口 / 总人口达到此比例时繁荣度额外加成达到上限 |
| pop_prosperity_max_bonus | 0.30 | 繁荣度满值时资源产量、建造、训练、研究的额外速率加成（+30%） |
| kingdom_city_state_count | 8 | 地图随机生成的王国城邦数量 |
| kingdom_city_state_generation_version | 4 | 王国 PvE 生成规则版本；提升后按新规则重生成既有城邦、封地和王都 |
| kingdom_city_state_tier_weights | 1:1\|2:1\|3:1 | 一级/二级/三级随机权重 |
| kingdom_city_state_tribe_pool | romans\|gauls\|teutons | 城邦随机种族池 |
| kingdom_city_state_unit_pool_romans/gauls/teutons | 各族兵种 code | 对应种族的城邦守军随机池 |
| kingdom_city_state_tier1_unit_count/min/max | 3 / 0 / 20 | 一级兵种数、每种兵数量范围 |
| kingdom_city_state_tier1_resource_min/max | 500/1500 | 一级四类资源范围（少量） |
| kingdom_city_state_tier1_gold_min/max | 0/300 | 一级金币范围 |
| kingdom_city_state_tier2_unit_count/min/max | 4 / 5 / 35 | 二级兵种数、每种兵数量范围 |
| kingdom_city_state_tier2_resource_min/max | 1500/5000 | 二级四类资源范围（中量） |
| kingdom_city_state_tier2_gold_min/max | 300/1200 | 二级金币范围 |
| kingdom_city_state_tier3_unit_count/min/max | 5 / 10 / 50 | 三级兵种数、每种兵数量范围 |
| kingdom_city_state_tier3_resource_min/max | 5000/15000 | 三级四类资源范围（大量） |
| kingdom_city_state_tier3_gold_min/max | 1200/5000 | 三级金币范围 |
| kingdom_city_state_raid_defense_min/max_ratio | 0.2/0.8 | 掠夺时随机分配的防守兵力比例 |
| kingdom_city_state_recovery_min/max_sec | 43200/172800 | 兵力恢复随机时长（12–48 小时） |
| kingdom_city_state_recovery_resource_extra_sec | 21600 | 资源恢复比兵力额外延长时长（6 小时） |
| kingdom_city_state_reputation_penalty | 2 | 旧版固定扣分参数（弃用，仅兼容旧配置；当前按王国 PvE 消灭人口累计扣分） |
| kingdom_city_state_resource_field_level | 3 | 四类城外资源田保底等级 |
| kingdom_city_state_inner/outer_building_count_min/max | 3–8 / 4–8 | 城内/城外随机建筑数量范围 |
| kingdom_city_state_building_level_min/max | 1/5 | 随机建筑等级范围 |
| kingdom_city_state_inner/outer_building_pool | `...|...` | 城邦随机建筑池 |
| kingdom_fief_unit_count/min/max | 7 / 30 / 100 | 四个领主封地统一标准：随机兵种数及每种兵数量范围 |
| kingdom_fief_resource_min/max | 15000/30000 | 封地四类资源随机范围 |
| kingdom_fief_gold_min/max | 5000/10000 | 封地金币随机范围 |
| kingdom_capital_unit_count/min/max | 10 / 50 / 150 | 王都随机兵种数及每种兵数量范围（高于封地） |
| kingdom_capital_resource_min/max | 30000/60000 | 王都四类资源随机范围 |
| kingdom_capital_gold_min/max | 10000/20000 | 王都金币随机范围 |
| kingdom_pve_killed_population_per_reputation | 25 | 每累计消灭 25 人王国 PvE 军队人口扣 1 点声望，跨战斗累加 |
| kingdom_pve_retaliation_chunk | 5 | 每累计产生 5 点该类声望扣分时检查一次封地报复 |
| kingdom_pve_retaliation_raid_threshold | -10 | 声望小于等于此值时掠夺主城 |
| kingdom_pve_retaliation_siege_threshold | -20 | 声望小于等于此值时攻城主城 |
| kingdom_fief_mercenary_min/max_ratio | 0.4/0.7 | 封地报复雇佣军占封地守军总人口的随机比例 |
| cavalry_unit_codes | `equlegati|equimperatoris|equcaesaris|theutates|druidrider|haeduan|paladin|teutonknight|merc_cavalry|merc_knight` | 骑兵兵种代码（以 `|` 分隔）；猎马人任务和绞马索效果共用此分类；任务进度按 `popCost` 计人口 |

`/config/balance` 的“猎马人 / 绞马索参数”板块会集中显示并编辑这条支线的两个数值：猎马人目标人口（`quest_objectives.csv` 的 `o-s5.params`，按 `cavalry:<数量>` 保存）和绞马索骑兵防御削弱百分比（`treasures.csv` 的 `horse_rope.effectValue`）。这里是对应 CSV 行的专用快捷入口，不会生成第二份运行时参数；骑兵兵种分类仍在上方“骑兵分类参数”板块修改。

> 加新常量：加一行，并在 `packages/server/src/infra/config.ts` 的 `GameConstants` 里加一个字段映射（`cn('your_key', 默认值)`）。

配置中心 `/config/balance` 会把 `forest_vision_penalty`、`hills_vision_bonus` 和 `hills_march_speed_multiplier` 单独集中显示在“地图格子特性 / 地形参数”板块；军队规模减速的三个参数在“军队规模行军参数”板块显示。它们仍写入同一张 `game_constants.csv`。规模人口只取本次行军实际携带部队的 `units.csv.popCost` 总和，按既有兵种/科技/全局/地形计时后逐段应用倍率；商队固定速度不受影响，已在途行军不会因热重载改变原定到达时间。

M8 任务村参数：`m8_attack_delay_sec`（接取后攻城等待，默认 28800 秒/8 小时）、`m8_task_village_spawn_radius`（相对接取村的生成搜索半径，默认 8 格）、`m8_task_village_resource_amount`（四种资源各自初始量，默认 500）、`m8_task_village_gold`（初始金币，默认 500）。任务村坐标以 World 中对应 `refId` 地块为准；配置中心的平衡参数区提供独立的“M8 任务村参数”区编辑攻城倒计时，其余任务村参数仍在全局常量表中。保存后均写回默认 CSV，删档/重启仍沿用。

## trade_center.csv — 贸易中心逐级参数
| 列 | 含义 |
|----|------|
| level | 贸易中心等级 |
| tradeRoutes | 本村可同时占用的贸易路线数 |
| tradeViewRadius | 可查看和接受玩家订单的最大六边形距离 |
| npcOrderCount | NPC订单池同时展示的订单数量 |
| npcRefreshSec | NPC订单自动刷新间隔（秒） |
| npcStoredRefreshes | 最多可囤积的手动刷新次数 |

## treasures.csv — 宝物目录
| 列 | 含义 |
|----|------|
| id / code | 数字主键 / 稳定英文代码 |
| name / icon | 显示名 / 图标基名 |
| category / rarity | 宝物类别 / 稀有度 |
| effectType / effectValue | 效果类型 / 效果数值（倍率类按百分比值填写） |
| reputationValue | 主宝物栏被动声望修正（可为负；备用栏和军队携带中不生效） |
| priceGold | NPC出售或回收时使用的金币基准价 |
| dropRate | 掉落或进入NPC订单池的概率（0–1） |
| applyType | `passive` 持续生效或即时消费类型 |
| equipCategory | 自动生效槽类别：`economic/military/social/special` |
| stackGroup / effectCap | 同类叠加组 / 该效果封顶值 |
| uniqueEffect | `1` 表示同名只允许一份生效 |

`enemyCavalryDef` 为绞马索专用效果类型，`effectValue=30` 表示攻击时将敌方骑兵的近战/远程防御都乘以 `0.70`；只作用于携带该宝物的进攻军队，不会改变持有者自身防御。

## research.csv — 科技树目录
| 列 | 含义 |
|----|------|
| id / code | 数字主键 / 稳定英文代码（前置引用用 code） |
| name / desc / icon | 显示名 / 说明 / 图标基名 |
| branch | 分支：`military` 军事 / `production` 生产 / `social` 社会 |
| tier | 层级，1 为顶层；界面按层从上到下分组显示 |
| mainBaseLevel | 研发所需主基地最低等级；默认 1，配置中心可调 |
| requires | 前置科技 code；`\|` 分隔=全都要，`OR` 分隔=任满其一，留空=无前置 |
| scope | `village` 仅本村生效 / `player` 全部村庄生效 |
| durationSec / rpCost | 研发耗时（秒）/ 消耗科研点 |

## research_effects.csv — 科技效果明细
| 列 | 含义 |
|----|------|
| techCode / order | 所属科技 code / 同科技内展示与应用顺序 |
| effectType | 效果类型；必须是服务端白名单中的真实已接线效果，含 `unit_unlock` 兵种解锁与 `building_unlock` 建筑解锁 |
| effectKey | 作用目标，如资源 code、`all`、`form:melee` 或建筑/兵种 code |
| effectValue | 效果值；倍率类填小数，`0.15` 表示 +15%；解锁类填 `1` |
| cap | 该叠加组最终上限 |

## academy.csv — 学院逐级出点参数
| 列 | 含义 |
|----|------|
| level | 学院等级，每级一行 |
| checkIntervalSec | 判定间隔（秒）；多座学院时实际间隔按数量缩短 |
| baseProbability | 基础成功概率（0~1） |
| probabilityGainPerFail | 每次失败累积的概率增量（保底机制，避免长期不出点） |
| maxProbability | 概率上限 |
| popFactor | 总人口对科研点判定的影响系数（0=不受影响；按 `totalPop / hardCap` 同时提高成功概率并缩短判定间隔，1=满硬上限时因子翻倍） |

## village_templates.csv — 各部族开局布局
| 列 | 含义 |
|----|------|
| tribe | 部族（语义串 romans/gauls/teutons） |
| start_placed | 开局预置建筑（含资源田），格式 `code:等级`，多段用 `\|` 分隔，如 `main:1\|rallypoint:1\|woodcutter:1\|claypit:1\|ironmine:1\|cropland:1`。zone 由 buildings.csv 自动归区；开局预置数量不能超过 tcLevel=1 的城内/城外槽位上限 |
| start_resources | 初始资源覆盖（**可选**），格式 `res:量`，留空则各资源用 `game_constants` 的 `start_resource_amount` |
| start_damaged | 开局以 0 级受损状态占位、可修复到指定等级的建筑，格式 `code:修复目标等级`，多段用 `\|` 分隔；对应 code 必须同时在 `start_placed` 中为 0 级。 |

> 铁匠铺只承担建筑介绍与繁荣度，不再承载锻造玩法；军事攻防与行军速度加成统一配置在 `research.csv` / `research_effects.csv`。

---

## ⚙️ 启动校验（改完没生效先看这）
后端启动时会校验所有 CSV，**发现问题直接报错并指出表/字段**，而不是带病运行。覆盖：
- 跨表引用合法性（兵种 `building`、建筑 `requires`、PvE `targetId` 必须指向存在的行）
- 关键数值范围（maxLevel/trainSec/speed 不能 ≤0，提速上限须在 [0,1) 等）
- 建筑 `requires` 不允许**循环依赖**（A 需 B、B 需 A 会报错）

> 若启动报「配置校验失败」，按提示的表名/字段名改对应 CSV 即可。

---

## 任务图配置（`quest_*.csv`）

任务系统以 **任务线 → 任务节点 → 条件 / 目标 / 效果 → 关系边** 为唯一配置事实源。`tasks.ts` 只持有玩家任务实例、事件推进和任务营地；不得再把任务定义散落进运行时代码。配置中心的“任务模块编辑”和“任务关系图”分别用于修改与审查这六张表；GM 只管理任务实例状态，不编辑这些定义。

### quest_lines.csv — 任务线
| 列 | 含义 |
|----|------|
| code | 稳定任务线代码（不可随意改名） |
| name | 任务显示名 |
| kind | `main` / `daily` / `side`，用于展示与刷新策略 |
| entryQuest | 此任务线入口任务的 `code` |
| order | 配置中心关系图和客户端目录的显示顺序 |

### quests.csv — 任务节点
| 列 | 含义 |
|----|------|
| id | 数字主键，仅用于稳定排序 |
| code | 稳定任务代码；存档实例引用它，勿改名 |
| lineCode | 所属 `quest_lines.csv` 的 `code` |
| name / desc | 玩家可见名称与描述 |
| type | `main` / `daily` / `side`，与任务线用途一致 |
| scope | `global` 或 `village`；主线必须为 `global`，日常必须为 `village`，支线按任务设计配置 |
| weight | 日常任务在酒馆槽中的加权抽取权重；主线/支线填 0（酒馆支线由每槽概率先决定是否进入支线池） |
| repeatable / cooldownSec / abandonCooldownSec | 可重复、交付后冷却和放弃后冷却 |
| acceptCost | 接取时支付的资源，格式为 `resource:数量`，多项用 `\|` 分隔；只在点击“接受任务”时扣除，打开或关闭对话不会扣除 |

### quest_conditions.csv — 条件
| 列 | 含义 |
|----|------|
| id | 稳定条件 ID |
| questCode | 所属任务代码 |
| phase | `offer`（出现条件）；`accept` / `success` / `failure` 可用于运行时条件审查。`success` 条件不会自动显示在玩家任务目标卡；例如 `no_damaged_resource_level` 可作为隐藏测试兜底 |
| group | 同组条件的组合语义；当前填 `all` |
| kind / value | 事件或门槛，例如 `building_built` / `treasury`、`troops_reached` / `20`；`tavern_refresh` / `1` 表示由酒馆槽概率刷新 |

### quest_objectives.csv — 目标
| 列 | 含义 |
|----|------|
| id / questCode | 稳定目标 ID / 所属任务 |
| kind | 目标类型，如 `submit_resources`、`clear_camp`、`research_completed`、`reputation_at_least`/`reputation_at_most`（声望达到阈值或更高/更低）、`defend_task_village`、`raid_task_village`、`investigate_task_village`（到达指定任务营地并调查，不战斗）、`kill_units`（累计击杀指定兵种类别） |
| params | 目标参数；资源用 `wood:200|clay:200`，`kill_units` 用 `cavalry:50`，`dice_match` 用 `difficulty:targetScore:winsRequired`，其他格式按 `任务模块.md` 说明 |
| order | 同任务多目标时的顺序 |

### quest_effects.csv — 效果

除资源与宝物效果外，`adjust_reputation` 用于把声望变化绑定到任务结算阶段；`failure` 阶段会显示为任务失败结果，`success`/`deliver` 阶段显示为完成结果。多阶段 `natalie_choice` 会在任务卡片展开各分支获得的宝物、资源和声望。
| 列 | 含义 |
|----|------|
| id / questCode | 稳定效果 ID / 所属任务 |
| phase | `accept` / `success` / `failure` / `deliver`；可把奖励与分支放在各自阶段 |
| kind / params | 效果类型与参数，例如 `grant_resources` / `gold:100`、`grant_treasure` / `warrior_token`；`grant_population` 使用正整数人口（如 `5`）；`grant_population_growth` 使用 `percent:durationSec`（如 `10:86400`，表示人口增长速率 +10% 持续24小时）；`grant_resource_growth` 使用 `percent:durationSec` 作用于四种资源，或 `resource:percent:durationSec` 指定单一资源（如 `crop:25:86400`）；`grant_mercenaries` 使用 `merc_archer:10|merc_sword:5`，交付时直接加入无期限佣兵；`grant_mercenaries_by_positive_reputation` 使用 `merc_sword:2`，交付时将正声望归零并按每点发放无期限佣兵；M9 可用 `grant_population_m8_success` 与 `grant_treasure_m8_failure` 按 M8 结局选择奖励 |
| order | 同阶段的执行顺序 |

### quest_edges.csv — 关系边
| 列 | 含义 |
|----|------|
| id | 稳定边 ID |
| fromQuest / toQuest | 起点与终点任务代码 |
| relation | `requires`（前置完成）/ `success_unlock` / `failure_unlock` |
| order | 多条入边的稳定顺序 |

## pvp_power_curve.csv — PvP 强弱差掠夺衰减
| 列 | 含义 |
|----|------|
| maxRatio | 攻击方与防守方出征初始战力比的区间上限；最后一档留空表示无上限 |
| lootMult | 该区间最终可掠夺量倍率 |

> 主线靠 `quest_edges.csv` 的 `requires` 串成链；每日任务由 `weight` 抽取。编辑任一表时应在配置中心关系图复核入边、出边和效果，保存会拒绝不存在的引用、无效目标和循环前置。

### dialogues.csv — NPC 对话
| 列 | 含义 |
|----|------|
| id / code / segment | 对话对象数字主键 / 稳定对话代码 / 对象内段落序号（从 1 连续编号；同一对象可有多行） |
| taskCode | 绑定的任务代码；对话由任务动作启动 |
| trigger | 触发点，例如 `accept`（点击接取任务）或 `deliver`（领取奖励）；宝物使用对话固定为 `use`，代码为 `<treasureCode>_use`、taskCode 从 `t1` 起独立排序；M8/M9 的成功文本使用默认触发点，失败分支使用 `accept_failure` / `deliver_failure` |
| npcName / npcText | 对话对象名称与 NPC 文本（不要填写英文逗号）；支持服务端展示变量 `{villageName}`（当前玩家村庄名）和 `{fiefName}`（当前玩家所属封地名），配置中心保存变量名，运行时由服务端替换后再下发客户端 |
| replies | 玩家回复列表，格式 `key:显示文本|key2:显示文本`；当前任务接取约定 `accept` 与 `leave`，交付常用 `take:收下`；没有配置回复时对话弹窗不显示底部按钮，玩家只能通过右上角关闭 |

同一 `id`、`code`、`taskCode`、`trigger` 的多段对话按 `segment` 升序依次显示；玩家关闭当前段或选择回复后进入下一段，最后一段结束。配置中心对话编辑器只允许修改 `npcName`、`npcText`、`replies`，通过“+ 段落”新增同一对象的下一段。

S3 的接取后追问单独维护为 `s3_after_accept` entry，并在任务真正接取成功后弹出；`s3_accept` 只包含接取时的文本。M8 成功交付文本并入 `m8_deliver`，M9 成功接取/交付文本分别并入 `m9_accept` / `m9_deliver`，因此成功时使用默认 `accept` / `deliver`。M8/M9 的失败文本仍保留 `m8_deliver_failure`、`m9_accept_m8_failure`、`m9_deliver_m8_failure`，由任务模块按 M8 结局调用。

## kingdom_services.csv — 议会厅服务

| 列 | 含义 |
|----|------|
| id / code / name | 数字主键、稳定代码与显示名 |
| category | `reinforcement` 增援 / `attack` 代打 / `supplies` 物资 / `treasure` 宝物 |
| minCouncilLevel / reputationCost | 最低议会厅等级 / 声望价格 |
| unitCode / unitCount | 增援或代打使用的 `units.csv` 兵种代码与数量 |
| wood/clay/iron/crop/gold | 物资服务发放量 |
| treasureCode | 宝物服务发放的 `treasures.csv` 代码 |
| delaySec | 代打服务购买后出发延迟；即时服务填 0 |
| desc | 玩家可见说明 |

## alliance_levels.csv — 联盟等级与成员容量

| 列 | 含义 |
|----|------|
| level | 联盟等级（由联盟大厅等级映射） |
| hallLevel | 对应的联盟大厅等级 |
| memberCap | 联盟成员上限 |
| description | 管理页面显示的等级说明 |

## alliance_buildings.csv — 联盟建筑目录

| 列 | 含义 |
|----|------|
| code / name | 稳定代码 / 显示名称 |
| maxLevel | 该联盟建筑最高等级 |
| requiredAllianceLevel | 解锁所需联盟等级 |
| costWood/costClay/costIron/costCrop | 建造 1 级的资源基准成本；后续等级按目标等级倍增 |
| effectType / effectValue | 建筑提供的成员加成类型与数值（由运行时效果适配器使用） |
| description | 玩家可见说明 |

## alliance_tech.csv — 联盟科技目录

| 列 | 含义 |
|----|------|
| code / name | 稳定代码 / 显示名称 |
| maxLevel | 该联盟科技最高等级 |
| requiredAllianceLevel | 研发所需联盟等级 |
| techPointCost | 研发 1 级所需科技点；后续等级按目标等级倍增 |
| effectType / effectValue | 科技提供的成员加成类型与数值（由运行时效果适配器使用） |
| description | 玩家可见说明 |

联盟建筑和联盟科技在资源/科技点满足后才开始执行，默认建造/研发耗时由 `game_constants.csv` 的
`alliance_project_duration_sec`（默认 10 秒）控制；配置中心“联盟”板块可直接修改，修改只影响新开始的项目。

---

## 改了之后怎么生效
- 配置中心（`/config`）保存先做完整校验并热重载当前进程，同时写入 `shared/config`；异步同步队列只上传 CSV 差异，不阻塞 GM 或玩家请求。发布时配置中心是现有生产值的权威：共享 CSV 已有单元格（包括空值）和自建行覆盖 Git，明确删除的行记录在 `config_row_tombstones.json` 且不会被 Git 复活；Git 只补共享文件从未包含的新列与未被删除的新行。结构删除或改名必须走显式迁移。
- GitHub 配置 PR 合并、`npm run deploy:prod` 发布后，新 release 读取同一份 CSV；删档/重启只处理 `game.json` 进度，不回退配置。
- 本地直接编辑仓库 CSV 仍可在开发服重启后生效，但正式环境应使用配置中心的 PR 流程。
- 改 CSV **不需要改任何代码、不需要重新编译**。
- ⚠️ **改了 id/code 或新增/删除目录行，相当于改了数据契约**：开发期建议清空旧存档 `data/game.json` 再重启，避免老村庄里残留的 code 找不到定义。
