/**
 * 客户端单元测试（node:test + tsx）
 * 覆盖：escapeHtml/escapeAttr 转义函数 + errText 错误码翻译 + isCompatibleVersion 版本守卫
 *       + 人口系统 v3 硬上限：PopSnapshot 新字段 + PopulationChanged 事件文案。
 * 纯逻辑，无浏览器依赖，可在 Node 环境直接运行。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml, escapeAttr } from '../shared/utils/escape.js';
import { errText } from '../shared/ui/text.js';
import { isCompatibleVersion } from '../api.js';
import { WIRE_VERSION, WIRE_MIN_VERSION } from '@slg/shared';
import { setPopState, getPopState, interpolatePop } from '../app/state.js';
import { notificationText } from '../features/reports/reports.js';

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
    assert.equal(errText('smithy_busy'), '铁匠铺正在升级中，请稍后再试');
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

/** 构建测试用完整 PopSnapshot（v3 硬上限字段）。 */
function makePopSnap(overrides: Partial<Parameters<typeof setPopState>[0]> = {}) {
  return {
    currentPop: 100,
    soldierPop: 40,
    hardCap: 200,
    availableLabor: 160,
    laborRatio: 0.5,
    prosperityBonus: 0.5,
    prosperityMult: 0.875,
    growthPerHour: 10,
    mobilizeCap: 0.75,
    popProsperityFullRatio: 0.7,
    mainLevel: 1,
    inFamine: false,
    civilianCropPerHour: 100,
    laborMults: {
      production: 0.875, build: 0.875, train: 0.875, research: 0.875, smithy: 0.875,
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

  it('interpolatePop 在增长中线性外插，上限 availableLabor', () => {
    setPopState(makePopSnap({ currentPop: 100, availableLabor: 200, growthPerHour: 3600, fetchedAt: Date.now() - 1000 }));
    const interp = interpolatePop();
    // 经过 1 秒，growthPerHour=3600 → 约 1 人/秒，应约为 101
    assert.ok(interp >= 100 && interp <= 102, `外插值 ${interp} 超出预期范围`);
  });

  it('interpolatePop 达上限附近（currentPop >= availableLabor）时不外插', () => {
    setPopState(makePopSnap({ currentPop: 200, availableLabor: 200, growthPerHour: 10 }));
    assert.equal(interpolatePop(), 200);
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
