# Travian 2.0 AI重构执行 Prompt 模板

本文件是给 AI 的可复用执行模板。  
建议每次只执行一个阶段，避免大爆炸改动。

关联基线文档：`review1.0`

---

## 0) 通用总 Prompt（每轮都先发）

```text
你是本项目的重构执行AI。请严格按以下要求执行：

【项目目标】
1) 大多数内容新增可通过 config/*.csv 完成（兵种/建筑/PvE/全局常量）。
2) 大多数功能新增可通过阅读项目架构快速落地。
3) 保持架构可读、可维护、可扩展。

【必须遵守的架构铁律】
1) 状态归属唯一：每块状态只有一个 owner 模块可直接读写。
2) 跨模块只通过 Command/Event，不允许直接耦合访问对方内部状态。
3) 所有时间逻辑统一走 Scheduler。
4) 对外返回派生后的快照，不暴露内部计算细节。

【执行边界】
- 仅在本仓库内修改。
- 不做与本阶段无关的重构。
- 尽量小步提交，保持行为兼容。
- 变更时同步更新文档与测试。

【输出要求】
完成后请输出：
1) 变更摘要（按文件分组）
2) 配置变更摘要（新增/变更CSV字段）
3) 风险与回滚点
4) 测试与验证结果
5) 下一步建议（最多3条）
```

---

## 1) 阶段A Prompt（基础收敛，低风险）

```text
在遵守通用总 Prompt 的前提下，执行“阶段A：基础收敛”。

【阶段目标】
1) 新增 game_constants 配置表并接入服务端配置中心。
2) 将以下硬编码迁移为配置读取：
   - 城墙防御加成
   - 铁匠升级加成
   - 主基地建造加速（含上限）
3) 增加配置校验器（先覆盖跨表引用与基础范围校验）。

【建议落地点】
- config/game_constants.csv（新增）
- packages/server/src/infra/config.ts（解析 + validate）
- packages/server/src/modules/combat.ts
- packages/server/src/modules/military.ts
- packages/server/src/modules/building.ts
- 对应 server 测试文件（补充或更新）

【兼容性要求】
- 默认配置下，行为应与改造前一致。
- 不改变现有接口字段语义（除非明确新增字段且保持向后兼容）。

【完成标准（DoD）】
1) server 现有测试通过。
2) 新配置表被实际读取并生效。
3) 缺失/非法配置时，启动阶段能给出清晰报错（指出文件和关键字段）。
4) 更新 config/README.md 对新表说明。
```

---

## 2) 阶段B Prompt（配置驱动闭环）

```text
在遵守通用总 Prompt 的前提下，执行“阶段B：配置驱动闭环”。

【阶段目标】
1) 增加服务端统一配置读取接口（建议 action: GetGameConfig）。
2) 客户端改为消费服务端配置，不再强依赖本地 info.ts 静态映射。
3) 验证“仅改CSV新增内容可显示”（至少 1 个示例）。

【建议落地点】
- packages/server/src/gateway/gateway.ts（路由接入）
- packages/server/src/modules（新增或复用配置查询 command）
- packages/client/src/api.ts
- packages/client/src/main.ts（或拆出 config 缓存层）
- packages/client/src/info.ts（降级为fallback或移除）

【接口建议返回最小集】
- resources: key/name/icon
- fields: type/name/icon/resource
- buildings: kind/name/icon
- units: key/tribe/name/icon/cat
- pveTemplates: type/name/icon
- constants: 前端需要的白名单常量（如 mapViewRadius）

【完成标准（DoD）】
1) 客户端页面显示可由服务端配置驱动。
2) 新增一个单位/建筑（仅改CSV）后，前端可正常显示与使用。
3) 保持现有核心流程可用（登录、村庄、训练、地图、战报）。
4) 对外协议变更有说明（如新增 GetGameConfig）。
```

---

## 3) 阶段C Prompt（结构升级）

```text
在遵守通用总 Prompt 的前提下，执行“阶段C：结构升级”。

【阶段目标】
1) 客户端按功能拆分（village/army/map/reports）。
2) Gateway 从手工路由向“模块声明式注册”演进（可分步实现）。
3) 同步更新项目文档，确保 AI 可读、可导航、可执行。

【建议目录改造】
- packages/client/src/app/*
- packages/client/src/features/village/*
- packages/client/src/features/army/*
- packages/client/src/features/map/*
- packages/client/src/features/reports/*
- packages/client/src/shared/*

【Gateway演进建议】
- 先引入 manifest 结构（moduleName/publicActions/eventPushMap）
- 再在初始化阶段汇总生成 ACTION_ROUTES/EVENT_TO_PUSH
- 保留兼容层，避免一次性推翻

【文档更新要求】
- PROJECT.md：更新目录与启动/扩展说明
- docs/2_2.0设计/07_扩展与代码规范.md：补充 manifest 规范与新增流程
- config/README.md：同步配置字段变化

【完成标准（DoD）】
1) main.ts 职责明显收敛（仅启动与编排）。
2) 新增 action 的改动点减少，且不易漏改 gateway。
3) 文档足够让另一个 AI 在无上下文下继续开发。
```

---

## 4) 一次性全流程 Prompt（谨慎使用）

```text
在遵守通用总 Prompt 的前提下，按 A -> B -> C 顺序执行完整重构。
要求每完成一个阶段就：
1) 给出阶段小结
2) 运行测试并报告
3) 列出风险
4) 再进入下一阶段

若任一阶段出现高风险或较大回归，立即停止在当前阶段并输出：
- 当前已完成项
- 阻塞点
- 建议的人类决策项
```

---

## 5) 评审 Prompt（用于代码Review）

```text
请以“架构重构审查者”身份审查当前分支改动，重点关注：
1) 是否真正减少硬编码并转为配置驱动
2) 是否违反模块边界（跨模块直接耦合）
3) 是否引入协议不兼容或网关映射遗漏
4) 客户端是否仍存在双源配置
5) 测试覆盖是否足以保护核心循环

输出格式：
- 阻断级问题（必须修）
- 重要优化（建议修）
- 可后续处理项（记录到下一阶段）
```

---

## 6) 推荐使用方式

1. 先把“通用总 Prompt”贴给 AI。  
2. 再贴对应阶段 Prompt（A/B/C）。  
3. 每轮只做一个阶段，完成后再开下一轮。  
4. 每轮完成都要求 AI 更新 `review1.0` 的进度状态（可附录一节“执行日志”）。  
