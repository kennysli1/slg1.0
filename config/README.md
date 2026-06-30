# 配置表说明（config/）

> 游戏所有数值都在这些 CSV 里。**双击用 Excel 打开编辑，保存即可，改完重启后端生效**，无需改代码。
> 编辑注意：① 保持首行表头不动 ② 用英文逗号分隔（Excel 另存为 CSV 会自动处理）③ 文字不要含逗号 ④ 存为「CSV UTF-8」编码避免中文乱码。

---

## 📋 速查总表：要改什么 → 改哪张表

| # | 文件 | 配什么（一句话） | 想改这些就动它 |
|---|------|----------------|---------------|
| 表1 | `resources.csv` | **资源种类**（木/泥/铁/粮） | 加一种新资源、改资源显示名/图标 |
| 表2 | `fields.csv` | **资源田**（4类：伐木场/采泥场/铁矿/农田） | 改资源田产量、升级成本、建造时间、最高等级 |
| 表3 | `buildings.csv` | **中心建筑**（主基地/兵营/马厩等10个） | 改建筑成本/耗时/最高等级、改科技树前置依赖 |
| 表4 | `units.csv` | **兵种**（罗马10兵种） | 改兵种攻防/速度/载货/耗粮/造价、加新兵种、加新部族 |
| 表5 | `pve_targets.csv` | **野怪/PvE目标模板**（老鼠窝/野狼群/强盗营地） | 改目标战利品、重生时间、显示名/图标、加新目标类型 |
| 表6 | `pve_defenders.csv` | **野怪的守军**（每个PvE目标里有哪些怪、几只、多强） | 改某目标守军的种类/数量/三维 |
| 表7 | `pve_spawns.csv` | **野怪在地图上的位置**（哪个坐标放哪种目标） | 增删地图上的PvE点、改其坐标 |

> **常见操作举例**
> - 想让军团兵更强 → 表4 `units.csv`，改 legionnaire 行的 atk。
> - 想让老鼠窝掉更多资源 → 表5 `pve_targets.csv`，改 rats 行的 lootWood 等。
> - 想给老鼠窝加更多守军 → 表6 `pve_defenders.csv`，改 rats 那行 count，或加一行新怪。
> - 想在地图多放几个强盗营地 → 表7 `pve_spawns.csv`，加几行 type=bandits 的坐标。
> - 想让兵营不需要前置就能造 → 表3 `buildings.csv`，把 barracks 行的 requires 清空。

---

## 各表字段详解

## resources.csv — 资源种类
| 列 | 含义 |
|----|------|
| key | 资源标识（程序用，勿改已用的） |
| name | 显示名 |
| icon | 占位图标（emoji，后续换图片路径） |
| note | 备注 |

## fields.csv — 资源田（4类）
| 列 | 含义 |
|----|------|
| type | 资源田标识 |
| name / icon | 显示名 / 图标 |
| resource | 产出哪种资源（对应 resources.csv 的 key） |
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
| kind | 建筑标识 |
| name / icon | 显示名 / 图标 |
| costWood/.../costGrowth | 成本与增长（同上） |
| timeBase / timeGrowth | 耗时与增长 |
| maxLevel | 最高等级 |
| requires | 前置：`建筑:等级`，多个用 `\|` 分隔，如 `barracks:3`。空=无前置 |

## units.csv — 兵种（罗马族）
| 列 | 含义 |
|----|------|
| key | 兵种标识 |
| name / icon | 显示名 / 图标 |
| cat | 分类：infantry/cavalry/scout/siege/admin/settler |
| atk | 攻击力 |
| defInf | 对步兵防御 |
| defCav | 对骑兵防御 |
| speed | 速度（格/小时，决定行军快慢） |
| carry | 单兵载货（搬战利品） |
| upkeep | 每兵每小时耗粮 |
| costWood/Clay/Iron/Crop | 训练一个的成本 |
| trainSec | 训练一个耗时（秒） |
| building | 训练所需建筑 |

> 加新部族/兵种：直接加行即可。

## pve_targets.csv — PvE 目标模板
| 列 | 含义 |
|----|------|
| type | 目标标识 |
| name / icon | 显示名 / 图标 |
| respawnSec | 被清空后重生秒数 |
| lootWood/Clay/Iron/Crop | 战利品总量 |

## pve_defenders.csv — PvE 守军（与上表一对多）
| 列 | 含义 |
|----|------|
| targetType | 属于哪个目标（对应 pve_targets 的 type） |
| unitKey | 守军单位标识 |
| name | 显示名 |
| count | 数量 |
| atk/defInf/defCav | 三维 |
| carry | 载货（守军一般0） |

> 一个目标可有多行守军（如强盗营地有强盗+弓手两行）。

## pve_spawns.csv — PvE 在地图上的分布点
| 列 | 含义 |
|----|------|
| id | 目标唯一id |
| type | 目标类型（对应 pve_targets 的 type） |
| x / y | 地图坐标 |

> 加目标点 = 加一行。

---

## 改了之后怎么生效
- 后端启动时一次性读取。改完 CSV → 重启后端（`npm run dev:server` 会自动重启，或 Ctrl+C 后重跑）。
- 改 CSV **不需要改任何代码、不需要重新编译**。
