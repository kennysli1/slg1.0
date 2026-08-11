/**
 * 推送契约测试：验证 notifications.ts 的 EVENT_MAP 与 gateway 聚合 manifests
 * 的 eventToPush 保持一致，防止推送名漂移。
 *
 * 规则：
 *  1. EVENT_MAP 中每个 key 必须出现在 aggregated eventToPush 中（不漏登记）。
 *  2. EVENT_MAP 中每个 value（裸推送名）必须与 manifest 的值相同（不改名漂移）。
 *  3. EVENT_MAP 中的裸推送名不含模块前缀（如 'BattleEnded' 而非 'combat.BattleEnded'）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EVENT_MAP } from '../modules/notifications.js';
import { aggregateManifests } from '../gateway/manifest.js';
import { MODULE_MANIFESTS } from '../gateway/gateway.js';

const { eventToPush } = aggregateManifests(MODULE_MANIFESTS);

test('EVENT_MAP 中每个 key 都已在 gateway manifests 中登记', () => {
  const missing: string[] = [];
  for (const internalEvent of Object.keys(EVENT_MAP)) {
    if (!(internalEvent in eventToPush)) {
      missing.push(internalEvent);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `以下 EVENT_MAP 条目未在任何 manifest.eventPushMap 中登记：\n  ${missing.join('\n  ')}`,
  );
});

test('EVENT_MAP 中每个推送名与 manifest 声明一致（无漂移）', () => {
  const mismatched: string[] = [];
  for (const [internalEvent, notifPushName] of Object.entries(EVENT_MAP)) {
    const manifestPushName = eventToPush[internalEvent];
    if (manifestPushName !== undefined && manifestPushName !== notifPushName) {
      mismatched.push(`${internalEvent}: EVENT_MAP="${notifPushName}" manifest="${manifestPushName}"`);
    }
  }
  assert.deepEqual(
    mismatched,
    [],
    `以下 EVENT_MAP 推送名与 manifest 不一致：\n  ${mismatched.join('\n  ')}`,
  );
});

test('EVENT_MAP 中的裸推送名不含模块前缀（点号）', () => {
  const withPrefix = Object.entries(EVENT_MAP)
    .filter(([, v]) => v.includes('.'))
    .map(([k, v]) => `${k} → ${v}`);
  assert.deepEqual(
    withPrefix,
    [],
    `以下 EVENT_MAP 推送名包含点号（应为裸名）：\n  ${withPrefix.join('\n  ')}`,
  );
});

test('EVENT_MAP 中每个内部事件名包含模块前缀（内部事件名规范）', () => {
  const noPrefix = Object.keys(EVENT_MAP).filter((k) => !k.includes('.'));
  assert.deepEqual(
    noPrefix,
    [],
    `以下内部事件名缺少模块前缀（应为 module.EventName）：\n  ${noPrefix.join('\n  ')}`,
  );
});
