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
| 表2 | `buildings.csv` | **全部建筑**（含资源田；`zone` 分城镇中心/城内/城外） | 改建筑或资源田的成本/耗时/产量/最高等级、改科技树前置、改归属区；探险家协会在此配置 |
| 表3 | `town_center_slots.csv` | **城镇中心各级开放的槽位**（城内/城外槽位数 + 建造队列条数） | 调发育节奏、调城内外取舍强度、调队列条数 |
| 表4 | `units.csv` | **兵种**（罗马/高卢/条顿；`all` 为通用兵种） | 改兵种攻防/速度/视野/载货/耗粮/造价、加新兵种、加新部族；冒险者为 `all` 通用侦察兵种 |
| 表5 | `pve_targets.csv` | **野怪/PvE目标模板**（老鼠窝/野狼群/强盗营地） | 改目标战利品、重生时间、显示名/图标、加新目标类型 |
| 表6 | `pve_defenders.csv` | **野怪的守军**（每个PvE目标里有哪些怪、几只、多强） | 改某目标守军的种类/数量/三维 |
| 表7 | `pve_spawns.csv` | **野怪在地图上的位置**（哪个坐标放哪种目标） | 增删地图上的PvE点、改其坐标 |
| 表8 | `game_constants.csv` | **全局常量**（城墙、容量公式、地图尺寸、M8任务村参数等） | 调平衡参数；原先写死在代码里的常量都在这 |
| 表9 | `village_templates.csv` | **各部族开局预置建筑**（含资源田）+ 初始资源 | 改新手村开局；给不同部族不同起手 |
| 表10 | `building_levels.csv` | **建筑逐等级独立参数** | 调某一级建筑成本、耗时、人口、产量、宝库槽位或保险库资源保护量 |
| 表11 | `mercenaries.csv` | **雇佣兵目录与金币价格** | 调雇佣兵属性、价格或增删雇佣兵 |
| 表12 | `merc_camp.csv` | **雇佣兵营地逐级刷新参数** | 调候选数量、刷新间隔和可囤刷新次数 |
| 表13 | `trade_center.csv` | **贸易中心逐级能力** | 调路线数、交易视野、NPC订单和刷新节奏 |
| 表14 | `treasures.csv` | **宝物目录、效果、价格与掉率** | 调宝物效果、稀有度、NPC价格和出现概率 |
| 表15 | `research.csv` | **科技树目录**（分支/层级/前置/RP 造价） | 加科技、调研发耗时与作用域 |
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
| zone | 归属区：`center`(城镇中心,唯一) / `inner`(城内·民生研发) / `outer`(城外·生产量产)。资源田填 `outer` |
| resource | **仅资源田填**：产出哪种资源（对应 resources.csv 的 id）；非产出建筑留空 |
| prodBase | **仅资源田填**：1级每小时产量基数 |
| prodGrowth | **仅资源田填**：每级产量增长倍率（如1.3=每级+30%） |
| costWood/.../costGrowth | 成本与增长（升n级成本 = costX × costGrowth^(n-1)） |
| timeBase / timeGrowth | 耗时与增长 |
| maxLevel | 最高等级 |
| requires | 前置：`建筑数字ID:等级`，多个用 `\|` 分隔，如 `1:3`（城镇中心3级）。空=无前置 |

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
| vaultProtectWood/vaultProtectClay/vaultProtectIron/vaultProtectCrop/vaultProtectGold | 仅保险库填写：该级新增保护量，按等级累加；攻城拆除后按剩余等级生效 |

## town_center_slots.csv — 城镇中心槽位曲线
| 列 | 含义 |
|----|------|
| tcLevel | 城镇中心等级（需覆盖 1..城镇中心maxLevel，逐级写全） |
| innerSlots | 该等级开放的城内槽位数（须单调不减） |
| outerSlots | 该等级开放的城外槽位数（须单调不减） |
| queueSlots | 该等级的建造队列条数（≥1；可随等级增长） |
| unlockNote | 里程碑说明（仅注释，程序不读） |

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
| traits | 特性ID列表（逗号分隔，引用 **unit_traits.csv 的数字 id**，可空） |

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
| speed / carry | 行军速度 / 单兵载货量 |
| upkeep | 每小时耗粮；雇佣兵当前固定为 0 |
| costWood/costClay/costIron/costCrop | 普通训练资源成本；雇佣兵固定为 0 |
| trainSec / building / traits | 训练秒数 / 所需建筑 / 特性；当前均留空或为 0 |
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

> effect 枚举：`dmg_taken_ranged`(受远程伤害倍率) / `dmg_taken_melee`(受近战伤害倍率) / `atk_ranged` / `atk_melee`(自身攻击加成) / `def_ranged` / `def_melee`(自身防御加成)。
> 加新特性：本表加一行；若新增 effect 类型，先在 `packages/server/src/infra/combat-types.ts` 扩展枚举，再在战斗计算里接入。

## pve_targets.csv — PvE 目标模板
| 列 | 含义 |
|----|------|
| id | 数字主键（被 pve_defenders.targetId、pve_spawns.targetId 引用） |
| code | 英文代码（程序/存档用，勿改） |
| name / icon | 显示名 / 图标基名 |
| respawnSec | 被清空后重生秒数 |
| lootWood/Clay/Iron/Crop | 战利品总量 |

配置中的 `tianwang_village` 是 M8 任务村模板；其地图实体由任务模块按接取村庄动态生成，不应手动添加到 `pve_spawns.csv`。模板标注四种资源各 500，实际初始资源和金币由 `m8_task_village_resource_amount` / `m8_task_village_gold` 控制，守军由 `pve_defenders.csv` 的 `targetId=106` 控制。

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
| carry | 载货（守军一般0） |

> 一个目标可有多行守军（如强盗营地 `targetId=3` 有强盗+弓手两行）。

## pve_spawns.csv — PvE 在地图上的分布点
| 列 | 含义 |
|----|------|
| id | 分布点实例 id（如 `pve-0`，勿改——存档用） |
| targetId | 目标类型（填 **pve_targets 的数字 id**） |
| q / r | 六边形轴坐标（地图为六边形网格，q/r 为 axial 坐标） |

> 加目标点 = 加一行。

这些行是必须保留的人工锚点。World 会按实际世界面积自动补足公共 PvE 到 `round(W×H×5%)`；自动点位由 `world_seed` 确定，不写回 CSV，也不进入存档。新世界使用 `world_width/world_height`，已有世界始终优先采用存档中的 `world_meta` 尺寸。

地貌同样由 `world_seed` 确定生成，规则分类为平原 55%、森林 30%、丘陵 15%。地貌当前只用于地图表现和 PvE 分布，不改变行军速度或战斗数值。

## game_constants.csv — 全局常量（原硬编码迁出）

声望模块参数也在此表维护：`reputation_s4_release_delta` 控制 S4 释放抉择，`reputation_*_pvp_*` 控制正/负声望玩家按每十点敌方士兵人口击杀获得的声望值与目标门槛，`reputation_good_pop_growth_*` 控制正声望对人口增长的倍率及上限，`reputation_evil_pop_growth_penalty_*` 控制负声望的人口增长下降，`reputation_evil_army_attack_*` / `reputation_evil_army_defense_*` 控制负声望军队攻防倍率及上限，`reputation_good_gold_tax_penalty_*` 控制正声望的金币税收下降，`reputation_evil_pve_drop_rate_*` 控制负声望对 PvE 宝物掉落概率的倍率及上限。配置中心 `/config/balance` 会把这些行集中显示在“声望参数”板块；保存后热重载即可生效，无需刷档。宝物目录的 `reputationValue` 列控制主宝物栏被动声望修正。

王国系统的 `kingdom_*` 行控制封地位置比例、首次/循环任务等待、期限、四类任务权重、上贡与击杀目标范围、负声望目标门槛及声望奖励。王都/四封地守军与掉落仍在 `pve_targets.csv` / `pve_defenders.csv` 调整。
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

> 加新常量：加一行，并在 `packages/server/src/infra/config.ts` 的 `GameConstants` 里加一个字段映射（`cn('your_key', 默认值)`）。

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

## research.csv — 科技树目录
| 列 | 含义 |
|----|------|
| id / code | 数字主键 / 稳定英文代码（前置引用用 code） |
| name / desc / icon | 显示名 / 说明 / 图标基名 |
| branch | 分支：`military` 军事 / `production` 生产 / `social` 社会 |
| tier | 层级，1 为最底层；界面按层分组显示 |
| requires | 前置科技 code；`\|` 分隔=全都要，`OR` 分隔=任满其一，留空=无前置 |
| scope | `village` 仅本村生效 / `player` 全部村庄生效 |
| durationSec / rpCost | 研发耗时（秒）/ 消耗科研点 |

## research_effects.csv — 科技效果明细
| 列 | 含义 |
|----|------|
| techCode / order | 所属科技 code / 同科技内展示与应用顺序 |
| effectType | 效果类型；必须是服务端白名单中的真实已接线效果 |
| effectKey | 作用目标，如资源 code、`all`、`form:melee` |
| effectValue | 效果值；倍率类填小数，`0.15` 表示 +15% |
| cap | 该叠加组最终上限 |

## academy.csv — 学院逐级出点参数
| 列 | 含义 |
|----|------|
| level | 学院等级，每级一行 |
| checkIntervalSec | 判定间隔（秒）；多座学院时实际间隔按数量缩短 |
| baseProbability | 基础成功概率（0~1） |
| probabilityGainPerFail | 每次失败累积的概率增量（保底机制，避免长期不出点） |
| maxProbability | 概率上限 |
| popFactor | 人口对概率的影响系数（0=不受影响，1=满人口时概率翻倍） |

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
| weight | 每日任务抽取权重；主线/支线填 0 |
| repeatable / cooldownSec / abandonCooldownSec | 可重复、交付后冷却和放弃后冷却 |

### quest_conditions.csv — 条件
| 列 | 含义 |
|----|------|
| id | 稳定条件 ID |
| questCode | 所属任务代码 |
| phase | `offer`（出现条件）；`accept` / `success` / `failure` 可用于运行时条件审查。`success` 条件不会自动显示在玩家任务目标卡；例如 `no_damaged_resource_level` 可作为隐藏测试兜底 |
| group | 同组条件的组合语义；当前填 `all` |
| kind / value | 事件或门槛，例如 `building_built` / `treasury`、`troops_reached` / `20` |

### quest_objectives.csv — 目标
| 列 | 含义 |
|----|------|
| id / questCode | 稳定目标 ID / 所属任务 |
| kind | 目标类型，如 `submit_resources`、`clear_camp`、`research_completed`、`defend_task_village`、`raid_task_village` |
| params | 目标参数；资源用 `wood:200|clay:200`，其他格式按 `任务模块.md` 说明 |
| order | 同任务多目标时的顺序 |

### quest_effects.csv — 效果

除资源与宝物效果外，`adjust_reputation` 用于把声望变化绑定到任务结算阶段；`failure` 阶段会显示为任务失败结果，`success`/`deliver` 阶段显示为完成结果。多阶段 `natalie_choice` 会在任务卡片展开各分支获得的宝物、资源和声望。
| 列 | 含义 |
|----|------|
| id / questCode | 稳定效果 ID / 所属任务 |
| phase | `accept` / `success` / `failure` / `deliver`；可把奖励与分支放在各自阶段 |
| kind / params | 效果类型与参数，例如 `grant_resources` / `gold:100`、`grant_treasure` / `warrior_token`；`grant_population` 使用正整数人口（如 `5`）；`grant_population_growth` 使用 `percent:durationSec`（如 `10:86400`，表示人口增长速率 +10% 持续24小时）；M9 可用 `grant_population_m8_success` 与 `grant_treasure_m8_failure` 按 M8 结局选择奖励 |
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
| trigger | 触发点，例如 `accept`（点击接取任务）或 `deliver`（领取奖励）；M8/M9 的成功文本使用默认触发点，失败分支使用 `accept_failure` / `deliver_failure` |
| npcName / npcText | 对话对象名称与 NPC 文本（不要填写英文逗号） |
| replies | 玩家回复列表，格式 `key:显示文本|key2:显示文本`；当前任务接取约定 `accept` 与 `leave`，离开只关闭对话不改变任务状态 |

同一 `id`、`code`、`taskCode`、`trigger` 的多段对话按 `segment` 升序依次显示；玩家关闭当前段或选择回复后进入下一段，最后一段结束。配置中心对话编辑器只允许修改 `npcName`、`npcText`、`replies`，通过“+ 段落”新增同一对象的下一段。

S3 的接取后追问已并入 `s3_accept` 对话对象的第 2 段；不再单独维护 `s3_after_accept` entry。M8 成功交付文本并入 `m8_deliver`，M9 成功接取/交付文本分别并入 `m9_accept` / `m9_deliver`，因此成功时使用默认 `accept` / `deliver`。M8/M9 的失败文本仍保留 `m8_deliver_failure`、`m9_accept_m8_failure`、`m9_deliver_m8_failure`，由任务模块按 M8 结局调用。

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

---

## 改了之后怎么生效
- 配置中心（`/config`）保存先做完整校验并热重载当前进程，同时写入 `shared/config`；异步同步队列只上传 CSV 差异，不阻塞 GM 或玩家请求。
- GitHub 配置 PR 合并、`npm run deploy:prod` 发布后，新 release 读取同一份 CSV；删档/重启只处理 `game.json` 进度，不回退配置。
- 本地直接编辑仓库 CSV 仍可在开发服重启后生效，但正式环境应使用配置中心的 PR 流程。
- 改 CSV **不需要改任何代码、不需要重新编译**。
- ⚠️ **改了 id/code 或新增/删除目录行，相当于改了数据契约**：开发期建议清空旧存档 `data/game.json` 再重启，避免老村庄里残留的 code 找不到定义。
