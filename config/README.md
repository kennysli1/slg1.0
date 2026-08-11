# 配置表说明（config/）

> 游戏所有数值都在这些 CSV 里。**双击用 Excel 打开编辑，保存即可，改完重启后端生效**，无需改代码。
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
| 表2 | `buildings.csv` | **全部建筑**（含资源田；`zone` 分城镇中心/城内/城外） | 改建筑或资源田的成本/耗时/产量/最高等级、改科技树前置、改归属区 |
| 表3 | `town_center_slots.csv` | **城镇中心各级开放的槽位**（城内/城外槽位数 + 建造队列条数） | 调发育节奏、调城内外取舍强度、调队列条数 |
| 表4 | `units.csv` | **兵种**（罗马/高卢/条顿） | 改兵种攻防/速度/载货/耗粮/造价、加新兵种、加新部族 |
| 表5 | `pve_targets.csv` | **野怪/PvE目标模板**（老鼠窝/野狼群/强盗营地） | 改目标战利品、重生时间、显示名/图标、加新目标类型 |
| 表6 | `pve_defenders.csv` | **野怪的守军**（每个PvE目标里有哪些怪、几只、多强） | 改某目标守军的种类/数量/三维 |
| 表7 | `pve_spawns.csv` | **野怪在地图上的位置**（哪个坐标放哪种目标） | 增删地图上的PvE点、改其坐标 |
| 表8 | `game_constants.csv` | **全局常量**（城墙/铁匠加成、容量公式、地图尺寸等） | 调平衡参数；原先写死在代码里的常量都在这 |
| 表9 | `village_templates.csv` | **各部族开局预置建筑**（含资源田）+ 初始资源 | 改新手村开局；给不同部族不同起手 |
| 表10 | `building_levels.csv` | **建筑逐等级独立参数** | 调某一级建筑成本、耗时、人口、产量或宝库槽位 |
| 表11 | `mercenaries.csv` | **雇佣兵目录与金币价格** | 调雇佣兵属性、价格或增删雇佣兵 |
| 表12 | `merc_camp.csv` | **雇佣兵营地逐级刷新参数** | 调候选数量、刷新间隔和可囤刷新次数 |
| 表13 | `trade_center.csv` | **贸易中心逐级能力** | 调路线数、交易视野、NPC订单和刷新节奏 |
| 表14 | `treasures.csv` | **宝物目录、效果、价格与掉率** | 调宝物效果、稀有度、NPC价格和出现概率 |
| 表15 | `research.csv` | **科技树目录**（分支/层级/前置/效果/RP 造价） | 加科技、调研发耗时与效果数值 |
| 表16 | `academy.csv` | **学院逐级出点参数**（判定间隔与概率曲线） | 调科研点产出速度与保底强度 |

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

## units.csv — 兵种（含三部族）
| 列 | 含义 |
|----|------|
| id | 数字主键 |
| code | 英文代码（程序/存档用，勿改） |
| tribe | 所属部族（语义串 romans/gauls/teutons） |
| name / icon | 显示名 / 图标基名 |
| form | 形态：`melee`(近战/前排) 或 `ranged`(远程/后排)。取代旧的 cat |
| meleeAtk | 近战攻击力（近战兵永远用它；远程兵被迫肉搏时用它） |
| rangedAtk | 远程攻击力（远程兵后排放输出时用它） |
| meleeDef | 近战防御（被近战攻击时的承伤耐久） |
| rangedDef | 远程防御（被远程攻击时的承伤耐久） |
| speed | 速度（格/小时，决定行军快慢） |
| carry | 单兵载货（搬战利品） |
| upkeep | 每兵每小时耗粮 |
| costWood/Clay/Iron/Crop | 训练一个的成本 |
| trainSec | 训练一个耗时（秒） |
| building | 训练所需建筑（填**建筑数字ID**，如 4=兵营、5=马厩） |
| traits | 特性ID列表（逗号分隔，引用 **unit_traits.csv 的数字 id**，可空） |

> 加新部族/兵种：直接加行即可（id 接着往后排）。战斗只区分近战/远程，靠攻防四列 + 特性表达。

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
| popCost / popPermanent | 人口消耗 / 是否永久占人口；当前均为 0 |
| goldCost | 在雇佣兵营地购买单个兵种的金币价格 |

## merc_camp.csv — 雇佣兵营地逐级参数
| 列 | 含义 |
|----|------|
| level | 营地等级 |
| refreshSec | 自动刷新候选名单的间隔（秒） |
| mercCount | 每次刷新生成的可雇佣候选数量 |
| maxStoredRefreshes | 最多可囤积的手动刷新次数 |

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

## game_constants.csv — 全局常量（原硬编码迁出）
| 列 | 含义 |
|----|------|
| key | 常量键（代码按它读取，**勿改**） |
| value | 值 |
| type | 类型：`number`/`bool`/`string`（决定怎么解析 value） |
| note | 中文说明 |

当前常量（改完重启即生效，默认值与重构前行为一致）：

| key | 默认 | 作用 |
|-----|------|------|
| wall_bonus_per_level | 0.03 | 城墙每级防御加成（+3%/级） |
| smithy_bonus_per_level | 0.1 | 铁匠每级攻防加成（+10%/级） |
| smithy_cost_base | 20 | 铁匠升级成本基数（木+泥各 base×目标等级） |
| main_build_speedup_per_level | 0.05 | 主基地每级建造提速（-5%耗时/级） |
| main_build_speedup_cap | 0.6 | 主基地提速上限（最多-60%） |
| storage_base | 800 | 仓库/粮仓基础容量 |
| storage_growth_per_level | 0.5 | 容量每级增长系数（+50%基数/级） |
| start_resource_amount | 750 | 新村各资源初始存量 |
| base_production_per_hour | 1000 | 基础产量兼容常量；当前资源田实际产量以 `buildings.csv` 的 `prodBase/prodGrowth` 为准 |
| map_size | 20 | 地图半径（地图为 [-size,size] 方形） |
| map_view_radius | 6 | 前端地图视野半径（前端白名单常量） |

> 加新常量：加一行，并在 `packages/server/src/infra/config.ts` 的 `GameConstants` 里加一个字段映射（`cn('your_key', 默认值)`）。

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
| priceGold | NPC出售或回收时使用的金币基准价 |
| dropRate | 掉落或进入NPC订单池的概率（0–1） |
| applyType | `passive` 持续生效或即时消费类型 |

## research.csv — 科技树目录
| 列 | 含义 |
|----|------|
| id / code | 数字主键 / 稳定英文代码（前置引用用 code） |
| name / desc / icon | 显示名 / 说明 / 图标基名 |
| branch | 分支：`military` 军事 / `production` 生产 / `social` 社会 |
| tier | 层级，1 为最底层；界面按层分组显示 |
| requires | 前置科技 code；`\|` 分隔=全都要，`OR` 分隔=任满其一，留空=无前置 |
| effectType | 效果类型：`resource_rate` `combat_atk` `combat_def` `unit_unlock` `building_unlock` `pop_growth` `storage_cap` `train_speed` `build_speed` `march_speed` `carry_cap` `mechanism` |
| effectKey / effectValue | 效果作用目标（资源/兵种/建筑 code）/ 数值（倍率类填小数，0.15=+15%） |
| scope | `village` 仅本村生效 / `player` 全部村庄生效 |
| durationSec / rpCost | 研发耗时（秒）/ 消耗科研点 |

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

> 想让条顿开局多带一座兵营、或某部族自带铁匠铺？改这张表 `start_placed`，无需动代码。

---

## ⚙️ 启动校验（改完没生效先看这）
后端启动时会校验所有 CSV，**发现问题直接报错并指出表/字段**，而不是带病运行。覆盖：
- 跨表引用合法性（兵种 `building`、建筑 `requires`、PvE `targetId` 必须指向存在的行）
- 关键数值范围（maxLevel/trainSec/speed 不能 ≤0，提速上限须在 [0,1) 等）
- 建筑 `requires` 不允许**循环依赖**（A 需 B、B 需 A 会报错）

> 若启动报「配置校验失败」，按提示的表名/字段名改对应 CSV 即可。

---

## 改了之后怎么生效
- 后端启动时一次性读取。改完 CSV → 重启后端（`npm run dev:server` 会自动重启，或 Ctrl+C 后重跑）。
- 改 CSV **不需要改任何代码、不需要重新编译**。
- ⚠️ **改了 id/code 或新增/删除目录行，相当于改了数据契约**：开发期建议清空旧存档 `data/game.json` 再重启，避免老村庄里残留的 code 找不到定义。
