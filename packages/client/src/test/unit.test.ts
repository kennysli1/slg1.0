/**
 * 客户端单元测试（node:test + tsx）
 * 覆盖：escapeHtml/escapeAttr 转义函数 + errText 错误码翻译 + isCompatibleVersion 版本守卫
 *       + 人口系统 v3 硬上限：PopSnapshot 新字段 + PopulationChanged 事件文案
 *       + 战报分类 notificationKind（驱动报告页的图标与色带）。
 * 纯逻辑，无浏览器依赖，可在 Node 环境直接运行。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml, escapeAttr } from '../shared/utils/escape.js';
import { errText } from '../shared/ui/text.js';
import { isCompatibleVersion } from '../api.js';
import { WIRE_VERSION, WIRE_MIN_VERSION } from '@slg/shared';
import { setPopState, getPopState, interpolatePop } from '../app/state.js';
import { beginVillageSwitch, endVillageSwitch, findTaskCampMarker, setPlayerTaskState, setTaskMarkers, setTaskState, taskMarkers, villageSwitching } from '../app/store.js';
import { populationTooltip } from '../shell/ResourceBar.js';
import { notificationText, notificationKind } from '../features/reports/notification-text.js';
import { fmtDur, secLeft } from '../shared/utils/format.js';
import { modalLayerZ } from '../ui/modal-layer.js';
import { capitalCoordinate, currentVillageCoordinate, currentVillageName, parseMapCoordinate, pendingTaskCamps } from '../features/map/map-navigation.js';
import { terrainDisplayName, terrainFromTile } from '../features/map/HexMap.js';

describe('modalLayerZ', () => {
  it('弹层容器整体高于应用导航，叠加弹窗逐层抬高', () => {
    assert.equal(modalLayerZ(0), 'calc(var(--z-scrim) + 0)');
    assert.equal(modalLayerZ(1), 'calc(var(--z-scrim) + 20)');
    assert.equal(modalLayerZ(-1), 'calc(var(--z-scrim) + 0)');
  });
});

describe('地图定位', () => {
  it('地图地形只消费服务端字段，旧响应降级平原且未探索不泄露', () => {
    assert.equal(terrainFromTile({ terrain: 'forest' }, 'visible'), 'forest');
    assert.equal(terrainFromTile({ terrain: 'hills' }, 'explored'), 'hills');
    assert.equal(terrainFromTile(undefined, 'visible'), 'plain');
    assert.equal(terrainFromTile({ terrain: 'water' }, 'visible'), 'plain');
    assert.equal(terrainFromTile({ terrain: 'forest' }, 'unexplored'), null);
    assert.equal(terrainDisplayName('plain'), '平原');
    assert.equal(terrainDisplayName('forest'), '森林');
    assert.equal(terrainDisplayName('hills'), '丘陵');
    assert.equal(terrainDisplayName(null), '未探索区域');
  });

  it('任务营地导航只保留未清理的营地', () => {
    assert.deepEqual(pendingTaskCamps([
      { id: 'camp-cleared', q: 1, r: 2, cleared: true },
      { id: 'camp-active', q: 3, r: 4, cleared: false },
    ]), [{ id: 'camp-active', q: 3, r: 4, cleared: false }]);
    assert.deepEqual(pendingTaskCamps(undefined), []);
  });

  it('回主城优先使用 capitalVillageId 对应坐标', () => {
    const player = {
      id: 'p1', name: '领主', tribe: 't1', villageId: 'v2', capitalVillageId: 'v1', q: 8, r: 9,
      villages: [
        { id: 'v1', q: 2, r: 3, name: '主城', isCapital: true },
        { id: 'v2', q: 8, r: 9, name: '分城', isCapital: false },
      ],
    };
    assert.deepEqual(capitalCoordinate(player), { q: 2, r: 3 });
  });

  it('地图回正使用当前操作村坐标，而不是主城坐标', () => {
    const player = { id: 'p1', name: '领主', tribe: 't1', villageId: 'v2', capitalVillageId: 'v1', q: 8, r: 9, villages: [] };
    assert.deepEqual(currentVillageCoordinate(player), { q: 8, r: 9 });
  });

  it('地图当前村标签使用村名而不是玩家名', () => {
    const player = {
      id: 'p1', name: '玩家名', tribe: 't1', villageId: 'v2', q: 8, r: 9,
      villages: [{ id: 'v2', q: 8, r: 9, name: '新村名', isCapital: false }],
    };
    assert.equal(currentVillageName(player), '新村名');
  });

  it('坐标跳转只接受地图范围内的完整整数', () => {
    assert.deepEqual(parseMapCoordinate('4', '7', 10, 10), { ok: true, coordinate: { q: 4, r: 7 } });
    assert.equal(parseMapCoordinate('', '7', 10, 10).ok, false);
    assert.equal(parseMapCoordinate('1.5', '7', 10, 10).ok, false);
    assert.equal(parseMapCoordinate('10', '7', 10, 10).ok, false);
  });
});

describe('村庄切换互斥状态', () => {
  it('同一时间只允许一个切换，并能在完成后解除锁定', () => {
    endVillageSwitch();
    assert.equal(beginVillageSwitch('v2', '分城'), true);
    assert.deepEqual(villageSwitching.value, { targetVillageId: 'v2', targetVillageName: '分城' });
    assert.equal(beginVillageSwitch('v3', '另一座村'), false);
    endVillageSwitch();
    assert.equal(villageSwitching.value, null);
  });
});

// ─── escapeHtml ────────────────────────────────────────────────

describe('escapeHtml', () => {
  it('转义 < 和 >', () => {
    assert.equal(escapeHtml('<b>hello</b>'), '&lt;b&gt;hello&lt;/b&gt;');
  });

  it('转义 &', () => {
    assert.equal(escapeHtml('a & b'), 'a &amp; b');
  });

  it('转义双引号', () => {
    assert.equal(escapeHtml('"quoted"'), '&quot;quoted&quot;');
  });

  it('转义单引号', () => {
    assert.equal(escapeHtml("it's"), 'it&#39;s');
  });

  it('转义 XSS 向量', () => {
    assert.equal(
      escapeHtml('<script>alert("xss")</script>'),
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  it('null/undefined 返回空字符串', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });

  it('安全字符串原样返回', () => {
    assert.equal(escapeHtml('世界之王 KOW'), '世界之王 KOW');
  });

  it('数字转成字符串后转义', () => {
    assert.equal(escapeHtml(42), '42');
  });
});

// ─── escapeAttr ────────────────────────────────────────────────

describe('escapeAttr', () => {
  it('与 escapeHtml 等价', () => {
    const samples = ['<>', '"\'', '& test', '普通文本'];
    for (const s of samples) {
      assert.equal(escapeAttr(s), escapeHtml(s), `样本：${s}`);
    }
  });
});

// ─── errText ───────────────────────────────────────────────────

describe('errText', () => {
  it('undefined → 操作失败', () => {
    assert.equal(errText(undefined), '操作失败');
  });

  it('已知错误码返回中文', () => {
    assert.equal(errText('no_such_user'), '用户不存在');
    assert.equal(errText('wrong_password'), '密码错误');
    assert.equal(errText('name_taken'), '该名字已被注册');
    assert.equal(errText('spend_failed'), '资源不足');
  });

  it('训练/动员相关错误码返回中文（不再回退到“操作失败”）', () => {
    assert.equal(errText('mobilize_cap_exceeded'), '已达本族动员上限（士兵占总人口比例超限），无法继续训练');
    assert.notEqual(errText('mobilize_cap_exceeded'), '操作失败');
  });

  it('bad_troops 前缀透传中文', () => {
    assert.equal(errText('bad_troops:cavalry'), '出征兵力不合法');
  });

  it('unknown_building 前缀返回专用文案', () => {
    assert.equal(errText('unknown_building:forge'), '未知建筑');
  });

  it('unknown_ 通用前缀返回"目标不存在"', () => {
    assert.equal(errText('unknown_target_xyz'), '目标不存在');
  });

  it('完全未知的错误码返回固定兜底文案（不原样回显）', () => {
    assert.equal(errText('totally_unrecognized_code_xyz_123'), '操作失败');
  });
});

// ─── errText: 协议/安全相关错误码 ──────────────────────────────────

describe('errText 协议与安全错误码', () => {
  it('protocol_error 返回中文', () => {
    assert.ok(errText('protocol_error').includes('协议'));
  });

  it('version_mismatch 返回中文', () => {
    assert.ok(errText('version_mismatch').includes('协议'));
  });

  it('bad_envelope 返回中文', () => {
    assert.ok(errText('bad_envelope').includes('格式'));
  });

  it('rate_limited 返回中文', () => {
    assert.ok(errText('rate_limited').includes('频繁'));
  });

  it('invalid_payload 返回中文', () => {
    assert.ok(errText('invalid_payload').includes('格式') || errText('invalid_payload').includes('合法'));
  });

  it('message_too_large 返回中文', () => {
    assert.ok(errText('message_too_large').includes('大') || errText('message_too_large').includes('过大'));
  });
});

// ─── isCompatibleVersion ───────────────────────────────────────────

describe('isCompatibleVersion', () => {
  it('当前 WIRE_VERSION 兼容', () => {
    assert.equal(isCompatibleVersion(WIRE_VERSION), true);
  });

  it('WIRE_MIN_VERSION 兼容', () => {
    assert.equal(isCompatibleVersion(WIRE_MIN_VERSION), true);
  });

  it('低于 MIN_VERSION 不兼容', () => {
    assert.equal(isCompatibleVersion(WIRE_MIN_VERSION - 1), false);
  });

  it('高于当前版本不兼容', () => {
    assert.equal(isCompatibleVersion(WIRE_VERSION + 1), false);
  });

  it('非数字类型不兼容', () => {
    assert.equal(isCompatibleVersion('1'), false);
    assert.equal(isCompatibleVersion(null), false);
    assert.equal(isCompatibleVersion(undefined), false);
    assert.equal(isCompatibleVersion(true), false);
    assert.equal(isCompatibleVersion({}), false);
  });

  it('Infinity 不兼容', () => {
    assert.equal(isCompatibleVersion(Infinity), false);
    assert.equal(isCompatibleVersion(-Infinity), false);
  });

  it('NaN 不兼容', () => {
    assert.equal(isCompatibleVersion(NaN), false);
  });
});

// ─── PopSnapshot v2 新字段 ─────────────────────────────────────────

/** 构建测试用完整 PopSnapshot（v3 硬上限 + 劳动→士兵转化模型字段）。 */
function makePopSnap(overrides: Partial<Parameters<typeof setPopState>[0]> = {}) {
  return {
    currentPop: 100,
    soldierPop: 40,
    totalPop: 140,
    trainingPop: 0,
    hardCap: 200,
    availableLabor: 160,
    popCeiling: 160,
    laborRatio: 0.5,
    prosperityBonus: 0.5,
    prosperityMult: 0.875,
    growthPerHour: 10,
    mobilizeCap: 0.75,
    popProsperityFullRatio: 0.7,
    mainLevel: 1,
    inFamine: false,
    civilianCropPerHour: 100,
    garrisonPop: 0,
    lambdaRatio: 0.5,
    wounded: { total: 0, entries: [] },
    cropDeficitRate: 0,
    laborMults: {
      production: 0.875, build: 0.875, train: 0.875, research: 0.875,
    },
    softLimit: 160,
    lastTick: Date.now(),
    fetchedAt: Date.now(),
    ...overrides,
  };
}

describe('PopSnapshot v3 硬上限 - 新字段', () => {
  it('setPopState / getPopState 含新字段', () => {
    setPopState(makePopSnap());
    const ps = getPopState();
    assert.equal(ps?.currentPop, 100);
    assert.equal(ps?.soldierPop, 40);
    assert.equal(ps?.hardCap, 200);
    assert.equal(ps?.availableLabor, 160);
    assert.equal(ps?.laborRatio, 0.5);
    assert.equal(ps?.prosperityMult, 0.875);
    assert.equal(ps?.inFamine, false);
  });

  it('currentPop=0 能正确写入（不被 falsy 过滤）', () => {
    setPopState(makePopSnap({ currentPop: 0, hardCap: 100, growthPerHour: 0 }));
    assert.equal(getPopState()?.currentPop, 0);
    assert.equal(interpolatePop(), 0);
  });

  it('inFamine=true 能正确写入', () => {
    setPopState(makePopSnap({ inFamine: true }));
    assert.equal(getPopState()?.inFamine, true);
  });

  it('interpolatePop 在增长中线性外插，上限 popCeiling', () => {
    setPopState(makePopSnap({ currentPop: 100, popCeiling: 200, growthPerHour: 3600, fetchedAt: Date.now() - 1000 }));
    const interp = interpolatePop();
    // 经过 1 秒，growthPerHour=3600 → 约 1 人/秒，应约为 101
    assert.ok(interp >= 100 && interp <= 102, `外插值 ${interp} 超出预期范围`);
  });

  it('interpolatePop 达上限附近（currentPop >= popCeiling）时不外插', () => {
    setPopState(makePopSnap({ currentPop: 200, popCeiling: 200, growthPerHour: 10 }));
    assert.equal(interpolatePop(), 200);
  });
});

// ─── 任务营地地图标记 ──────────────────────────────────────────────

describe('任务营地地图标记', () => {
  it('完整任务快照与单独地图推送都会剔除已清理营地', () => {
    const villageId = 'task-marker-test';
    const camps = [
      { id: 'camp-live', q: 1, r: 2, cleared: false },
      { id: 'camp-cleared', q: 3, r: 4, cleared: true },
    ];

    setTaskState({ villageId, active: [{ camps }] });
    assert.deepEqual(taskMarkers.value[villageId].map((camp: any) => camp.id), ['camp-live']);

    setTaskMarkers({ villageId, camps });
    assert.deepEqual(taskMarkers.value[villageId].map((camp: any) => camp.id), ['camp-live']);
  });

  it('玩家任务快照把全局营地同步到每个村庄，并清除旧坐标标记', () => {
    setTaskMarkers({ villageId: 'task-global-capital', camps: [{ id: 'stale', q: 16, r: 40, cleared: false }] });
    setPlayerTaskState({
      global: { active: [{ camps: [{ id: 'global-camp', q: 12, r: 0, cleared: false }] }] },
      villages: [
        { villageId: 'task-global-capital', active: [] },
        { villageId: 'task-global-branch', active: [] },
      ],
    });
    assert.deepEqual(taskMarkers.value['task-global-capital'], [{ id: 'global-camp', q: 12, r: 0, cleared: false }]);
    assert.deepEqual(taskMarkers.value['task-global-branch'], [{ id: 'global-camp', q: 12, r: 0, cleared: false }]);
  });

  it('任务营地标记携带任务名称与说明，地图推送不会丢失关联信息', () => {
    const villageId = 'task-detail-test';
    setTaskState({
      villageId,
      active: [{
        code: 'm3', name: '清剿野兽', desc: '清理一处骚扰村落的营地', type: 'main', scope: 'global',
        campCleared: 0, campTotal: 1, camps: [{ id: 'detail-camp', q: 4, r: 5, cleared: false }],
      }],
    });
    assert.equal(taskMarkers.value[villageId][0].taskInfo.name, '清剿野兽');
    assert.equal(taskMarkers.value[villageId][0].taskInfo.desc, '清理一处骚扰村落的营地');
    assert.equal(findTaskCampMarker('detail-camp', 4, 5)?.taskInfo.scope, 'global');

    setTaskMarkers({ villageId, camps: [{ id: 'detail-camp', q: 4, r: 5, cleared: false }] });
    assert.equal(findTaskCampMarker('detail-camp', 4, 5)?.taskInfo.name, '清剿野兽');
  });
});

// ─── PopulationChanged 事件文案 ────────────────────────────────────

describe('notificationText - PopulationChanged v3 硬上限', () => {
  it('无 event 字段时返回 null（静默增长不扰战报）', () => {
    const result = notificationText('PopulationChanged', { currentPop: 100 });
    assert.equal(result, null);
  });

  it('consumed 事件：含消耗量与当前平民数', () => {
    const result = notificationText('PopulationChanged', { event: 'consumed', consumed: 150, currentPop: 50 });
    assert.ok(result?.includes('150'), `应含消耗量 150，实际：${result}`);
    assert.ok(result?.includes('50'), `应含当前值 50，实际：${result}`);
  });

  // 服务端饥荒减员事件名为 famine / starved（含 reduced 字段）
  it('famine/starved 事件：含减员量与当前平民数', () => {
    const result = notificationText('PopulationChanged', { event: 'starved', reduced: 25, currentPop: 325 });
    assert.ok(result?.includes('25'), `应含减员量 25，实际：${result}`);
    assert.ok(result?.includes('325'), `应含当前值 325，实际：${result}`);
  });

  it('recovery 事件：含恢复提示', () => {
    const result = notificationText('PopulationChanged', { event: 'recovery', currentPop: 325 });
    assert.ok(result != null, '恢复事件应有文案');
    assert.ok(result?.includes('恢复') || result?.includes('粮食'), `应含恢复描述，实际：${result}`);
  });

  it('recovered 事件：含医院回收提示', () => {
    const result = notificationText('PopulationChanged', { event: 'recovered', recovered: 30, permanentDead: 5, currentPop: 200 });
    assert.ok(result?.includes('30'), `应含回收数 30，实际：${result}`);
  });

  it('capChanged 事件：含硬上限', () => {
    const result = notificationText('PopulationChanged', { event: 'capChanged', hardCap: 300, currentPop: 200 });
    assert.ok(result?.includes('300'), `应含硬上限 300，实际：${result}`);
  });

  it('returned 事件：含归队提示', () => {
    const result = notificationText('PopulationChanged', { event: 'returned', returned: 50, currentPop: 150 });
    assert.ok(result != null, '返回事件应有文案');
    assert.ok(result?.includes('50') || result?.includes('150'), `应含数量，实际：${result}`);
  });
});

describe('notificationText - 建筑侦察报告', () => {
  it('城内外建筑侦察同时显示守军兵力', () => {
    const result = notificationText('ScoutReport', {
      scoutType: 'scout_buildings',
      buildings: { center: [{ kind: 'townhall', name: '城镇中心', level: 1 }], inner: [], outer: [] },
      defenderTroops: { legionnaire: 4 },
    });
    assert.ok(result?.includes('城镇中心1级'), `应含建筑快照，实际：${result}`);
    assert.ok(result?.includes('军团兵4'), `应含守军兵力，实际：${result}`);
  });
});

describe('notificationText - 来袭预警与途中侦察', () => {
  it('实时来袭预警刷新不进入战报', () => {
    assert.equal(notificationText('IncomingWarningChanged', { visible: true }), null);
  });

  it('途中侦察完胜报告包含兵力、损失与宝物识别', () => {
    const result = notificationText('ScoutReport', {
      context: 'incoming_intercept', side: 'attacker', perfectVictory: true,
      at: { q: 3, r: 4 }, defenderTroops: { legionnaire: 12 },
      attackerLosses: {}, defenderLosses: { equlegati: 2 }, treasures: ['victory_flag'],
    });
    assert.match(result ?? '', /途中侦察完胜/);
    assert.match(result ?? '', /军团兵12/);
    assert.match(result ?? '', /敌方侦察兵损失/);
    assert.match(result ?? '', /宝物/);
  });
});

describe('notificationText - 伏击报告视角', () => {
  it('被伏击方只显示自己的兵种损失和客观胜负', () => {
    const result = notificationText('BattleEnded', {
      side: 'defender', battleLabel: '伏击', attackerWins: true,
      attackPower: 800, defensePower: 500,
      attackerLosses: { legionnaire: 10 },
      defenderLosses: { equimperatoris: 2, merc_archer: 3 },
    });
    assert.match(result ?? '', /被伏击结束（失败）/);
    assert.match(result ?? '', /我方损失：近卫骑兵2/);
    assert.match(result ?? '', /弓箭雇佣兵3/);
    assert.doesNotMatch(result ?? '', /军团兵10/);
  });
});


describe('人口资源条红框说明', () => {
  it('仓储溢出时说明人口增长扣减比例', () => {
    const text = populationTooltip({ hardCap: 300, inFamine: false, overflowRatio: 0.35, soldierPop: 80 }, 200, 120, 4);
    assert.match(text, /红框原因：仓储溢出使人口增长降低 35%/);
  });

  it('饥荒时说明人口正在减少', () => {
    const text = populationTooltip({ hardCap: 300, inFamine: true, overflowRatio: 0, soldierPop: 80 }, 200, 120, -3);
    assert.match(text, /红框原因：饥荒中，人口正在减少/);
  });
});

// ─── notificationKind：战报语义分类 ────────────────────────────────

describe('notificationKind', () => {
  it('建造类事件归 build', () => {
    assert.equal(notificationKind('BuildingBuilt'), 'build');
    assert.equal(notificationKind('BuildingUpgraded'), 'build');
    assert.equal(notificationKind('BuildingDemolished'), 'build');
  });

  it('训练归 train', () => {
    assert.equal(notificationKind('TroopTrained'), 'train');
  });

  it('战斗与遭遇战归 battle', () => {
    assert.equal(notificationKind('BattleStarted'), 'battle');
    assert.equal(notificationKind('BattleEnded'), 'battle');
    assert.equal(notificationKind('MarchIntercepted'), 'battle');
  });

  it('行军与拓荒归 march', () => {
    assert.equal(notificationKind('MarchSent'), 'march');
    assert.equal(notificationKind('MarchReturned'), 'march');
    assert.equal(notificationKind('VillageFounded'), 'march');
  });

  it('来袭与粮荒归 alarm（需要最高优先级提示）', () => {
    assert.equal(notificationKind('IncomingAttack'), 'alarm');
    assert.equal(notificationKind('CropDeficit'), 'alarm');
  });

  it('全部 Treasure* 事件归 treasure', () => {
    assert.equal(notificationKind('TreasureDropped'), 'treasure');
    assert.equal(notificationKind('TreasurePendingDropped'), 'treasure');
    assert.equal(notificationKind('TreasureCarriedArrived'), 'treasure');
  });

  it('人口变化默认归 pop，但饥荒减员升级为 alarm', () => {
    assert.equal(notificationKind('PopulationChanged', { event: 'capChanged' }), 'pop');
    assert.equal(notificationKind('PopulationChanged', { event: 'starved' }), 'alarm');
    assert.equal(notificationKind('PopulationChanged', { event: 'famine' }), 'alarm');
  });

  it('未知事件归 info（不抛错）', () => {
    assert.equal(notificationKind('SomethingBrandNew'), 'info');
  });
});

// ─── 时长 / 剩余时间格式化 ─────────────────────────────────────────
//
// 回归测试：这里曾经只有一个收「目标时刻」的 secStr，调用方（消耗预览的耗时芯片、
// 建造进度条）普遍误传**时长**，导致 ms - Date.now() 变成大负数被夹到 0，
// 界面上所有耗时一律显示「0秒」。fmtDur 收时长、secLeft 收时刻，二者不可混用。

describe('fmtDur（收时长）', () => {
  it('不足一分钟只给秒', () => {
    assert.equal(fmtDur(0), '0秒');
    assert.equal(fmtDur(1_000), '1秒');
    assert.equal(fmtDur(59_000), '59秒');
  });

  it('超过一分钟给分+秒', () => {
    assert.equal(fmtDur(60_000), '1分0秒');
    assert.equal(fmtDur(95_000), '1分35秒');
  });

  it('超过一小时给时+分', () => {
    assert.equal(fmtDur(3_600_000), '1时0分');
    assert.equal(fmtDur(3_600_000 + 25 * 60_000), '1时25分');
  });

  it('负时长夹到 0（已完成的任务不显示负数）', () => {
    assert.equal(fmtDur(-5_000), '0秒');
  });

  it('传入时长不会被当成时刻而塌成 0（这就是那个 bug）', () => {
    assert.notEqual(fmtDur(120_000), '0秒');
    assert.equal(fmtDur(120_000), '2分0秒');
  });
});

describe('secLeft（收目标时刻）', () => {
  it('未来时刻算出正的剩余时长', () => {
    assert.equal(secLeft(Date.now() + 30_000), '30秒');
  });

  it('已过去的时刻返回 0秒', () => {
    assert.equal(secLeft(Date.now() - 10_000), '0秒');
  });
});
