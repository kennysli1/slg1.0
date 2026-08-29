---
class: index
status: active
updated: 2026-08-29
owner: ops
summary: 新 Codex 对话接手项目所需的版本、架构、数据边界与最近修复摘要
---

# Codex 工程交接摘要

这份文档用于开启新的 Codex 对话时快速恢复上下文。它不是新的开发规范；硬性规则仍以 [`CLAUDE.md`](../CLAUDE.md) 和 [`00_变更契约.md`](./00_变更契约.md) 为准。

## 1. 当前快照

- 项目：KOW /「世界之王」，多人在线、服务器权威、实时推进的网页 SLG。
- 工作区：`work/slg1.0-codex`（TypeScript + npm workspaces monorepo）。
- 远程仓库：`kennysli1/slg1.0`，`origin` 指向 `https://github.com/kennysli1/slg1.0.git`。
- 当前 `origin/main`：`654dc57fa1ba9d713ee6998a327794691f01a516`（PR #210，2026-08-29）。
- 本地交接分支：`docs/codex-handoff`；建立时工作区干净，未携带用户未提交修改。
- 生产地址：`http://101.43.64.22:8080`。
- 最近一次生产部署：`npm run deploy:prod` 已成功，线上 `/version` 与上述 SHA 一致，HTTP 与 WebSocket 冒烟通过。
- 当前没有理由刷档、respawn 或 wipe。除非用户明确授权，不得执行任何会改变存档/地图的重置。

## 2. 新对话开场顺序

新对话先读以下三个文件，再按需求路由继续下钻：

1. [`CLAUDE.md`](../CLAUDE.md)：红线、分支、验证、部署和重置安全规则。
2. [`PROJECT.md`](../PROJECT.md)：owner 清单、活跃文档路由和常用命令。
3. 本文：最近版本状态、配置边界和已知坑。

不要默认扫描整个仓库。先按 `PROJECT.md` 的 owner 表定位模块，再读取对应的当前参考文档；`docs/archive` 只在查历史时读取。

可直接把下面内容作为新对话的第一条提示：

> 这是 KOW / 世界之王项目的续作。请先读取 `CLAUDE.md`、`PROJECT.md`、`docs/Codex交接摘要.md`。当前主线是 `origin/main@654dc57fa1ba9d713ee6998a327794691f01a516`，生产为 `http://101.43.64.22:8080`。遵守功能分支 → PR → 合并 → `origin/main` → `npm run deploy:prod` 流程；不要刷档/respawn/wipe，除非我明确授权。先说明准备修改的文件范围，再实施、测试并报告分支、PR、合并和部署状态。

## 3. 架构与不可违反的边界

服务端组装在 `packages/server/src/app.ts`，外部 action 集中在 `packages/server/src/gateway/routes.ts`；核心层次为：

```text
gateway（协议、鉴权、会话、payload 校验、推送）
  ↓
modules（每个领域唯一状态 owner）
  ↓
infra（Store、WAL、Scheduler、CommandBus、EventBus、配置与算法）
```

必须遵守：

- 一个持久状态集合只有一个 owner；跨 owner 写入只能走窄 Command，广播走 Event。
- 领域模块不直接 import 其他领域模块，也不调用其他 owner 的内部状态方法。
- 所有未来事件/倒计时统一走 `Scheduler`；领域模块不得自行使用 `setTimeout`/`setInterval`。
- 对客户端只下发最终派生快照，不把内部中间状态当协议。
- 协议或存档结构变化分别检查 `WIRE_VERSION` / `SAVE_SCHEMA_VERSION`；只有确需不兼容迁移时才标 `[需刷档]`。

主要 owner：`player`（账号/村庄归属）、`economy`（资源）、`building`（建筑/槽位/队列）、`population`、`military`、`world`、`vision`、`pve`、`movement`、`diplomacy`、`reputation`、`kingdom`、`combat`、`mercenary`、`trade`、`treasures`、`alchemy`、`research`、`tasks/task`、`dialogues`、`notifications`、`meta`。具体职责以 `PROJECT.md` §三为准。

## 4. 数据权威与入口分工

### 配置中心（静态默认/平衡）

- 入口：`/config`；定义、条件、奖励、对话、建筑/单位/科技/PvE 参数均属配置中心。
- 文件事实源：仓库 `config/*.csv`；字段与表清单见 `config/README.md`。
- 配置中心保存先隔离校验，再写共享配置、revision/hash 和同步 outbox；异步 worker 可创建 GitHub 配置 PR。
- `config_revision.json`、`config_sync_outbox.json`、`config_sync_status.json` 是运维元数据，不是游戏参数。
- GitHub 配置 PR 合并后，必须从 `origin/main` 部署；“热重载”只代表当前进程重读 CSV，不代表已合并或已上线。

### GM（实时存档）

- 入口：`/gm`；修改当前 `game.json/WAL`，例如资源、人口、军队、村庄坐标、任务状态、任务营地和测试重置。
- GM 修改立即作用于当前存档，不改 CSV 默认值；页面应明确显示这一点。
- 任务定义/任务对话/平衡参数不要再从 GM 配置入口修改；旧 `/gm/balance`、`/gm/quests`、`/gm/dialogues` 等仅为兼容重定向，规范入口是 `/config`。

### 旧覆盖文件

`balance_overrides.json` 已不是运行时事实源。部署迁移时只会隔离校验、折叠有效字段进 CSV 并把原文件改名为带时间戳的 `balance_overrides.migrated.<时间>.json`；后端不再读取/写入它。未知表、行、字段或非法 JSON 应硬失败，不能静默吞掉。

### 发布合并

`tools/remote-release.sh` 调用 `scripts/merge-persisted-config.mjs`，按稳定主键把共享配置值叠加到 Git 默认 CSV：既有行保留已确认的手调值，新行/列自动进入生产，Git 删除的旧行不会被共享文件复活。不要用共享 CSV 整文件覆盖 release。

## 5. 近期功能基线

- 主基地已替代旧城镇中心，固定 1–4 级；每升一级新增 4 个城内格和 4 个城外格。主基地不能手动拆除，也不能在攻城战中被拆等级；旧存档按现有建筑容量懒迁移。
- 联盟大厅、议会厅需要二级主基地且每村最多一座；王国任务只有议会厅存在时显示。建筑配置列包含 `maxCount` 与 `mainBaseLevel`。
- 任务包括 M1–M15、S 系列、日常、王国任务；任务定义/目录/关系/营地/对话在配置中心，进度和营地实体在 task owner。M8/M9 的任务村、M13 秘密营地使用稳定任务 ID 与 World 权威坐标。
- 对话支持 `npcName`、`npcText`、`replies`，可按同一 `code` 保存连续 `segment`；任务接取/交付对话模板和宝物使用对话由 CSV 配置。
- 侦察、调查、伏击、驻扎续行、援军、掠夺/攻城、建筑破坏/修复、PvE/PvP 战报等均由 movement/combat/vision/pve/task owner 协作，新增行为必须通过 Command/Event，不得跨模块直写。
- 冒险者可探索/执行侦察，但不参加侦察战防守或贡献侦察战斗力；纯侦察部队规则、返程隐身、预警和地图可见性已有服务端校验。
- 宝物新获得、返程交付、炼金炉收获、备用栏装载在主基地和宝库均有空位时优先进入主基地；宝库扩容不自动搬走主基地已有宝物。
- 繁荣度是基础产值之外的额外加成；低繁荣只取消额外加成，不削减基础产值。人口超过上限按配置削减额外加成，达到默认两倍时额外加成归零。

## 6. 最近对话排序修复（当前线上已包含）

用户截图中的表格曾出现 `s3_accept`、`m1_accept`、`m2_accept` 混排。根因不是 CSV 数据本身，而是浏览器端由 HTML 模板生成的 JavaScript 中，数字匹配正则的反斜杠被模板字符串吞掉，实际变成了 `match(/d+|D+/g)`，比较器因此失效并保留 CSV 原顺序。

当前 `654dc57` 已修复：

- 服务端与浏览器端都按 `code` 用 `_` 分段比较；每段内部自然数字排序。
- 共有前缀时较短 code 先排，等价于 `_` 分隔优先于后续数字；因此 `m2`–`m9` 在 `m10`–`m19` 前。
- code 相同后依次按 `taskCode`、`segment`、`id` 稳定排序。
- 模板源代码使用双反斜杠，生成页面的浏览器源码实际包含 `/\d+|\D+/g`，不会退化成 `/d+|D+/g`。
- `packages/server/src/test/gm-routes.test.ts` 有回归断言检查生成 HTML 仍含正确正则；配置加载和保存接口共用同一排序逻辑。

线上已验证 `/config/dialogues/data` 前 18 个 code 为 `m1_accept` … `m9_accept` 的自然顺序，`/config/dialogues` HTML 含正确正则。若浏览器仍显示旧顺序，先用 `Ctrl+F5` 清理旧页面缓存，再检查 `/version` 是否为目标 SHA。

相关代码：

- `packages/server/src/gateway/gm.ts`：`compareNatural`、`compareDialogueCode`、对话表格脚本和配置页面路由。
- `packages/server/src/test/gm-routes.test.ts`：GM/配置中心页面与排序回归测试。
- `config/dialogues.csv`：对话数据事实源。

## 7. 标准工作流与验证

每项修改先：

```bash
git status --short --branch
git fetch --prune origin
git merge origin/main
```

然后在非 `main` 功能分支完成修改，更新必要的文档索引和 `CHANGELOG.md`（只要改 `packages/**/src/` 或 `config/*.csv` 就必须写入 `## [未发布]`），再运行与风险匹配的检查：

```bash
npm run guard
npm run verify:quick
npm run test:server
npm run verify
```

完成后执行：

```text
commit → push feature branch → PR → 等待 CI → squash merge → fetch origin/main → npm run deploy:prod → 公网 HTTP/WebSocket 冒烟
```

报告状态时明确区分“分支完成”“已合入 origin/main”“已部署”，不要把三者笼统写成“已完成”。生产发布只认 `origin/main`，发布脚本使用不可变 `releases/<SHA>` 和独立 `shared/` 数据。

## 8. 已知测试/运维注意事项

- 提交钩子会执行完整验证，服务端全测约数十秒；不要因为日志暂时无输出就重复启动第二份测试。
- Windows 本地可能跳过 release-layout 的 symlink 测试，这是权限/平台限制；Linux 生产发布仍会执行真实布局逻辑。
- 生产上传阶段可能因公网 SCP/SSH 需要数分钟；部署脚本已启用 keepalive，除非命令明确失败，不要并发重复部署。
- 首次打开线上页面若长时间使用旧 bundle，先检查 `/version`、`/config/status`，再强制刷新；不要通过刷档解决前端缓存问题。
- 删档安全顺序：先确认目标和范围 → 创建带时间戳、非空且可解析的备份 → 用户明确授权 → 执行指定 reset → 记录结果。`season` 保留地图，`respawn` 只重生成地图布局/尺寸，`wipe` 删除账号；三者都不应删除共享配置或配置 revision。

## 9. 新需求接手模板

新对话收到需求后，先用下面格式确认理解，再修改：

```text
当前基线：origin/main@654dc57fa1ba9d713ee6998a327794691f01a516
需求范围：……
预计修改：……（文件/owner）
配置还是实时状态：配置中心 CSV / GM game.json-WAL / 两者均需但边界分开
是否涉及协议/存档：WIRE_VERSION …；SAVE_SCHEMA_VERSION …；是否需要刷档 …
验证计划：……
不会执行：未经明确授权的 season / respawn / wipe
```
