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
目录表（`fields` / `buildings` / `units` / `pve_targets`）每行有两个标识列：

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
| 表2 | `fields.csv` | **资源田**（4类：伐木场/采泥场/铁矿/农田） | 改资源田产量、升级成本、建造时间、最高等级 |
| 表3 | `buildings.csv` | **中心建筑**（主基地/兵营/马厩等10个） | 改建筑成本/耗时/最高等级、改科技树前置依赖 |
| 表4 | `units.csv` | **兵种**（罗马/高卢/条顿） | 改兵种攻防/速度/载货/耗粮/造价、加新兵种、加新部族 |
| 表5 | `pve_targets.csv` | **野怪/PvE目标模板**（老鼠窝/野狼群/强盗营地） | 改目标战利品、重生时间、显示名/图标、加新目标类型 |
| 表6 | `pve_defenders.csv` | **野怪的守军**（每个PvE目标里有哪些怪、几只、多强） | 改某目标守军的种类/数量/三维 |
| 表7 | `pve_spawns.csv` | **野怪在地图上的位置**（哪个坐标放哪种目标） | 增删地图上的PvE点、改其坐标 |

> **常见操作举例**
> - 想让军团兵更强 → 表4 `units.csv`，改 legionnaire 行的 atk。
> - 想让老鼠窝掉更多资源 → 表5 `pve_targets.csv`，改 rats 行的 lootWood 等。
> - 想给老鼠窝加更多守军 → 表6 `pve_defenders.csv`，给 `targetId=1`(老鼠窝) 加一行新怪。
> - 想在地图多放几个强盗营地 → 表7 `pve_spawns.csv`，加几行 `targetId=3`(强盗营地) 的坐标。
> - 想让兵营不需要前置就能造 → 表3 `buildings.csv`，把 barracks 行的 requires 清空。

---

## 各表字段详解

## resources.csv — 资源种类
| 列 | 含义 |
|----|------|
| id | 资源标识（语义串 wood/clay/iron/crop，**勿改**——程序结构字段名） |
| name | 显示名 |
| icon | 图标基名（如 `res_wood`，渲染时拼 `/art/res_wood.png`） |
| note | 备注 |

## fields.csv — 资源田（4类）
| 列 | 含义 |
|----|------|
| id | 数字主键（跨表引用用） |
| code | 英文代码（程序/存档用，勿改） |
| name / icon | 显示名 / 图标基名 |
| resource | 产出哪种资源（对应 resources.csv 的 id，语义串） |
| prodBase | 1级每小时产量基数 |
| prodGrowth | 每级产量增长倍率（如1.3=每级+30%） |
| costWood/Clay/Iron/Crop | 1级升级成本 |
| costGrowth | 成本每级增长倍率 |
| timeBase | 1级建造耗时（秒） |
| timeGrowth | 耗时每级增长倍率 |
| maxLevel | 最高等级 |

> 升n级成本 = costX × costGrowth^(n-1)；耗时同理。

## buildings.csv — 中心建筑
| 列 | 含义 |
|----|------|
| id | 数字主键（跨表引用用：被 units.building、其它建筑的 requires 引用） |
| code | 英文代码（程序/存档用，勿改） |
| name / icon | 显示名 / 图标基名 |
| costWood/.../costGrowth | 成本与增长（同上） |
| timeBase / timeGrowth | 耗时与增长 |
| maxLevel | 最高等级 |
| requires | 前置：`建筑数字ID:等级`，多个用 `\|` 分隔，如 `4:3`（兵营3级）。空=无前置 |

## units.csv — 兵种（含三部族）
| 列 | 含义 |
|----|------|
| id | 数字主键 |
| code | 英文代码（程序/存档用，勿改） |
| tribe | 所属部族（语义串 romans/gauls/teutons） |
| name / icon | 显示名 / 图标基名 |
| cat | 分类：infantry/cavalry/scout/siege/admin/settler |
| atk | 攻击力 |
| defInf | 对步兵防御 |
| defCav | 对骑兵防御 |
| speed | 速度（格/小时，决定行军快慢） |
| carry | 单兵载货（搬战利品） |
| upkeep | 每兵每小时耗粮 |
| costWood/Clay/Iron/Crop | 训练一个的成本 |
| trainSec | 训练一个耗时（秒） |
| building | 训练所需建筑（填**建筑数字ID**，如 4=兵营、5=马厩） |

> 加新部族/兵种：直接加行即可（id 接着往后排）。

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
| atk/defInf/defCav | 三维 |
| carry | 载货（守军一般0） |

> 一个目标可有多行守军（如强盗营地 `targetId=3` 有强盗+弓手两行）。

## pve_spawns.csv — PvE 在地图上的分布点
| 列 | 含义 |
|----|------|
| id | 分布点实例 id（如 `pve-0`，勿改——存档用） |
| targetId | 目标类型（填 **pve_targets 的数字 id**） |
| x / y | 地图坐标 |

> 加目标点 = 加一行。

---

## 改了之后怎么生效
- 后端启动时一次性读取。改完 CSV → 重启后端（`npm run dev:server` 会自动重启，或 Ctrl+C 后重跑）。
- 改 CSV **不需要改任何代码、不需要重新编译**。
- ⚠️ **改了 id/code 或新增/删除目录行，相当于改了数据契约**：开发期建议清空旧存档 `data/game.json` 再重启，避免老村庄里残留的 code 找不到定义。
