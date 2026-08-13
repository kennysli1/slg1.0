---
class: reference
status: active
updated: 2026-08-14
owner: server
summary: 服务端事件定向推送与客户端按需刷新机制
---
# 服务器客户端同步与 UI 刷新机制

> 跨模块通用机制。所有「服务器状态变化 → 推到浏览器 → 界面更新」都走这一套，与具体业务模块（贸易/人口/建筑…）解耦。
> 配套代码：`packages/server/src/gateway/{manifest,gateway}.ts` + `packages/client/src/app/bootstrap.ts` + `packages/client/src/api.ts`。

本文档记录同步与刷新的整体架构、客户端刷新策略，以及**新增一条推送→刷新接线**的标准步骤。各业务模块（如 `贸易模块.md` / `经济与金币模块.md`）只描述自己特有的事件名与刷新函数，通用机制统一看本文。

## 1. 总原则：事件驱动，不轮询

```
服务端领域事件(bus.emit) ──┐
                           ▼
        Manifest.eventPushMap 聚合 → EVENT_TO_PUSH
                           ▼
   Gateway.subscribeEvents 监听 bus → 取 payload.villageId → 定向推给本村 WS 连接
                           ▼
              客户端 WS.onPush(event, payload)
                           ▼
        bootstrap.ts 派发：refreshAll() / refreshXIfOpen() / 本地校正
```

强制刷新只发生在**两处**，不存在周期性盲轮询：
1. **客户端发起实质操作**（`act`：建造/升级/买兵/接单…）→ 操作后 `refreshAll()`。
2. **服务器推送确认**（`onPush`：升级完成/进攻/报告/贸易更新…）→ `refreshAll()`（或抽屉局部刷新）。

纯 UI 变化（资源数字增长、建造倒计时、人口显示）由客户端 **1s 定时器本地插值**完成，全程不访问服务器。标签页被后台挂起后切回（`visibilitychange`）补一次 `refreshAll()` 拉取最新真相（事件驱动，非轮询）。

连接生命周期另有两条基础设施链路，不属于游戏状态轮询：

- 服务端每 30 秒发送 WebSocket ping，浏览器自动 pong；pong 会重置 10 分钟空闲计时，玩家只阅读不操作也不会退出。休眠、断网或部署导致连接重建时，客户端用本地 30 天签名凭证执行一次 `ResumeSession`，恢复账号及当前村庄后再拉快照。
- 客户端通过无缓存 `/version` 探针检测部署构建指纹（最多每分钟一次，并在聚焦、上线、WS 重连时立即检查）。发现变化后更新 Service Worker 并刷新一次；`/version`、`version.json`、`sw.js` 不进入运行时缓存，避免旧缓存遮蔽新部署。

## 2. 服务端：事件 → 定向推送

### 2.1 声明（Manifest）
每个模块在 `static MANIFEST` 里用 `eventPushMap` 把**内部领域事件名**映射到**对外推送事件名**：

```ts
// 例：trade 模块
static readonly MANIFEST: ModuleManifest = {
  moduleName: 'trade',
  publicActions: { /* … */ },
  eventPushMap: {
    'trade.CenterUpdated': 'TradeCenterUpdated',
  },
};
```

- 内部事件名通常 `模块.事件`（如 `trade.CenterUpdated`、`economy.CropDeficit`）。
- 对外推送名是客户端 `onPush` 实际收到的 `event` 字符串。
- payload **必须含 `villageId`**（见 §2.3 定向投递）。

### 2.2 聚合（`aggregateManifests`）
`gateway.ts` 启动时汇总所有模块 manifest：

```ts
const { actionRoutes, eventToPush } = aggregateManifests(MODULE_MANIFESTS);
```

`aggregateManifests` 把各 `eventPushMap` 合并成扁平的 `EVENT_TO_PUSH`（内部事件名 → 对外推送名）；**重复事件名会抛错**，提前暴露冲突。

### 2.3 监听与定向投递（`gateway.subscribeEvents`）

```ts
for (const [internalName, pushEvent] of Object.entries(EVENT_TO_PUSH)) {
  this.app.bus.on(internalName, (evt) => {
    const villageId = (evt.payload as any)?.villageId;
    const push = { v: WIRE_VERSION, type: 'push', id: `push-${evt.ts}`, ts: evt.ts,
                   event: pushEvent, payload: evt.payload };
    if (villageId) this.sendToVillage(villageId, push);  // 只推给拥有该村的连接
  });
}
```

- 事件总线 `bus.emit` 后，Gateway 自动把对应事件转成 WS push。
- **定向**：只发给 `payload.villageId` 所属的已连接会话（`byVillage` 索引），不会广播给无关玩家。
- ⚠️ 若 payload **缺 `villageId`**，该分支 `if (villageId)` 为假 → **推送被丢弃**（不报错，但客户端收不到）。这是最常见的「改了服务端事件客户端不刷新」根因。

## 3. 客户端：onPush 派发与刷新策略

`bootstrap.ts` 注册全局 `onPush`（`handlePush` 做快照校正后，再按事件类型决定刷新方式）：

```ts
onPush((event, payload) => {
  handlePush(event, payload);
  if (event === 'VillageFounded' && me?.villageId) { /* selectVillage 重拉 + renderShell */ }
  if (event !== 'PopulationChanged') {
    if (event === 'MercenaryCampUpdated') refreshMercCampIfOpen();
    else if (event === 'TradeCenterUpdated')   refreshTradeIfOpen();
    else void refreshAll();
  } else {
    refreshTrainingIfOpen(); // 人口频繁变化：不整页刷新，避免抢焦点
  }
  if (event === 'TroopTrained' || event === 'BuildingUpgraded') refreshTrainingIfOpen();
});
```

### 3.1 三种刷新策略

| 策略 | 适用 | 行为 |
|------|------|------|
| **整页刷新 `refreshAll()`** | 绝大多数事件（默认分支） | 重新拉取全量状态并重渲当前页 |
| **抽屉局部刷新 `refreshXIfOpen()`** | 某详情抽屉正打开时的更新（`MercenaryCampUpdated` / `TradeCenterUpdated`） | 仅当该抽屉处于打开状态才重拉其内容；**避免 `refreshAll` 把抽屉关掉** |
| **纯本地校正** | `PopulationChanged` | 只做快照校正 + 局部 DOM 更新（`rerenderPopPanel`），**严禁 `refreshAll`/重新 `GetPopulation`** |

### 3.2 关键坑：PopulationChanged 正反馈死循环
`PopulationChanged` **绝不**触发 `refreshAll` 或重新拉 `GetPopulation`。否则会形成：
```
push(PopulationChanged) → refreshAll → 重新 settle 结算 → emit PopulationChanged → push → …
```
→ 无限死循环。人口频繁变化只走本地校正（`refreshTrainingIfOpen` 刷新训练抽屉里的人口提示），不触发整页刷新。

### 3.3 抽屉事件必须用 refreshXIfOpen
若把 `TradeCenterUpdated` / `MercenaryCampUpdated` 放进默认分支走 `refreshAll()`，整页重渲会**直接关掉正在打开的详情抽屉**，破坏操作连续性。新增「详情抽屉类」推送时，务必加 `refreshXIfOpen()` 分支（详见 §4）。

## 4. 新增一条「推送 → 刷新」接线的标准步骤

1. **服务端 emit 领域事件**：在业务模块里 `bus.emit({ name: '模块.事件', source, ts, payload: { villageId, … } })`，**务必带 `villageId`**。
2. **模块 Manifest 登记**：在模块 `MANIFEST.eventPushMap` 加一行 `'模块.事件': '对外Push名'`。无需改 `gateway.ts`（聚合自动生效）。
3. **（如需 GM/客户端常量）** 同模块 `publicActions` 已含对应查询命令（如 `GetTradeCenter`），客户端用 `req('GetXxx')` 拉详情。
4. **客户端派发**：在 `bootstrap.ts` 的 `onPush` 里加分支：
   - 默认 → `void refreshAll();`（多数情况）。
   - 详情抽屉类 → `else if (event === 'XxxUpdated') refreshXxxIfOpen();` 并在该模块导出 `refreshXxxIfOpen()`。
   - 高频且已有本地校正 → 走专用局部刷新，不要 `refreshAll`。
5. **验证**：操作后客户端是否正确刷新；若收不到，先查 payload 是否含 `villageId`、Manifest 事件名与 `onPush` 分支字符串是否完全一致。

> 命名约定：对外 push 名常用 `<模块/实体>Updated`（如 `TradeCenterUpdated`、`MercenaryCampUpdated`），对应客户端 `refresh<模块/实体>IfOpen()`。

## 5. 与具体模块的关系

- `贸易模块.md` §5/§9：贸易特有事件 `trade.CenterUpdated → TradeCenterUpdated` 与 `refreshTradeIfOpen()`。
- `经济与金币模块.md` §4：`economy.CropDeficit → CropDeficit`（触发客户端减员提示，走默认 `refreshAll`）。
- 任何新建筑/兵种详情页（如用户要求「以后都放中间」的居中抽屉）接入推送时，均按本文 §4 接线即可复用 `refreshXIfOpen` 模式。
