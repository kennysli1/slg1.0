import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePayload } from '../gateway/validate.js';
import type { PayloadSchema } from '../gateway/validate.js';

/**
 * Payload 校验器单元测试
 */

test('validatePayload：空 schema 接受空对象', () => {
  const r = validatePayload({}, {});
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.cleaned, {});
});

test('validatePayload：空 schema 剥离所有客户端字段', () => {
  const r = validatePayload({ hack: 'pwned', x: 42 }, {});
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.cleaned, {});
});

test('validatePayload：string 类型校验', () => {
  const schema: PayloadSchema = { name: { type: 'string', minLen: 1, maxLen: 10 } };
  assert.equal(validatePayload({ name: 'Alice' }, schema).ok, true);
  assert.equal(validatePayload({ name: '' }, schema).ok, false); // 太短
  assert.equal(validatePayload({ name: 'x'.repeat(11) }, schema).ok, false); // 太长
  assert.equal(validatePayload({ name: 42 }, schema).ok, false); // 类型错误
  assert.equal(validatePayload({}, schema).ok, false); // 缺少必填字段
});

test('validatePayload：integer 类型校验', () => {
  const schema: PayloadSchema = { count: { type: 'integer', min: 1, max: 100 } };
  assert.equal(validatePayload({ count: 50 }, schema).ok, true);
  assert.equal(validatePayload({ count: 0 }, schema).ok, false); // 下界
  assert.equal(validatePayload({ count: 101 }, schema).ok, false); // 上界
  assert.equal(validatePayload({ count: 1.5 }, schema).ok, false); // 非整数
  assert.equal(validatePayload({ count: 'x' }, schema).ok, false); // 类型错误
  assert.equal(validatePayload({ count: Infinity }, schema).ok, false); // 非有限数
  assert.equal(validatePayload({ count: NaN }, schema).ok, false); // NaN
});

test('validatePayload：boolean 类型校验', () => {
  const schema: PayloadSchema = { flag: { type: 'boolean' } };
  assert.equal(validatePayload({ flag: true }, schema).ok, true);
  assert.equal(validatePayload({ flag: false }, schema).ok, true);
  assert.equal(validatePayload({ flag: 1 }, schema).ok, false);
  assert.equal(validatePayload({ flag: 'true' }, schema).ok, false);
});

test('validatePayload：enum 类型校验', () => {
  const schema: PayloadSchema = { tribe: { type: 'enum', values: ['romans', 'gauls', 'teutons'] } };
  assert.equal(validatePayload({ tribe: 'gauls' }, schema).ok, true);
  assert.equal(validatePayload({ tribe: 'elves' }, schema).ok, false);
  assert.equal(validatePayload({ tribe: 42 }, schema).ok, false);
});

test('validatePayload：record_int 类型校验', () => {
  const schema: PayloadSchema = {
    troops: { type: 'record_int', maxKeys: 3, minVal: 1, maxVal: 1000 },
  };
  assert.equal(validatePayload({ troops: { swordsman: 10, spear: 5 } }, schema).ok, true);
  // 太多键
  assert.equal(validatePayload({ troops: { a: 1, b: 1, c: 1, d: 1 } }, schema).ok, false);
  // 值太小
  assert.equal(validatePayload({ troops: { swordsman: 0 } }, schema).ok, false);
  // 值太大
  assert.equal(validatePayload({ troops: { swordsman: 1001 } }, schema).ok, false);
  // 非整数值
  assert.equal(validatePayload({ troops: { swordsman: 1.5 } }, schema).ok, false);
  // 不是对象
  assert.equal(validatePayload({ troops: [1, 2] }, schema).ok, false);
  assert.equal(validatePayload({ troops: null }, schema).ok, false);
});

test('validatePayload：optional 字段可缺失', () => {
  const schema: PayloadSchema = {
    name: { type: 'string', minLen: 1, maxLen: 16 },
    tribe: { type: 'enum', optional: true, values: ['romans', 'gauls'] },
  };
  const r1 = validatePayload({ name: 'Alice' }, schema);
  assert.equal(r1.ok, true);
  if (r1.ok) {
    assert.equal(r1.cleaned.name, 'Alice');
    assert.equal(r1.cleaned.tribe, undefined);
  }
  const r2 = validatePayload({ name: 'Alice', tribe: 'gauls' }, schema);
  assert.equal(r2.ok, true);
  if (r2.ok) assert.equal(r2.cleaned.tribe, 'gauls');
});

test('validatePayload：剥离 schema 中未声明的多余字段', () => {
  const schema: PayloadSchema = { a: { type: 'string', minLen: 1, maxLen: 10 } };
  const r = validatePayload({ a: 'hello', b: 'injected', __proto__: 'hack' }, schema);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(Object.keys(r.cleaned).length, 1);
    assert.equal(r.cleaned.a, 'hello');
    assert.equal((r.cleaned as any).b, undefined);
  }
});

test('validatePayload：错误码正确区分', () => {
  const schema: PayloadSchema = {
    name: { type: 'string', minLen: 1, maxLen: 5 },
    age:  { type: 'integer', min: 0 },
  };
  const miss = validatePayload({ age: 10 }, schema);
  assert.equal(miss.ok, false);
  if (!miss.ok) assert.equal(miss.code, 'missing_field');

  const short = validatePayload({ name: '', age: 10 }, schema);
  assert.equal(short.ok, false);
  if (!short.ok) assert.equal(short.code, 'too_short');

  const long = validatePayload({ name: 'toolong', age: 10 }, schema);
  assert.equal(long.ok, false);
  if (!long.ok) assert.equal(long.code, 'too_long');

  const badType = validatePayload({ name: 42, age: 10 }, schema);
  assert.equal(badType.ok, false);
  if (!badType.ok) assert.equal(badType.code, 'bad_type');

  const outRange = validatePayload({ name: 'hi', age: -1 }, schema);
  assert.equal(outRange.ok, false);
  if (!outRange.ok) assert.equal(outRange.code, 'out_of_range');
});

test('validatePayload：string_array 类型校验', () => {
  const schema: PayloadSchema = {
    treasures: { type: 'string_array', minItems: 1, maxItems: 10, minLen: 1, maxLen: 64 },
  };
  // 正常通过
  const ok = validatePayload({ treasures: ['chainsaw', 'war_flag'] }, schema);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.cleaned.treasures, ['chainsaw', 'war_flag']);

  // 非数组
  const notArr = validatePayload({ treasures: 'chainsaw' }, schema);
  assert.equal(notArr.ok, false);

  // 元素非字符串
  const badItem = validatePayload({ treasures: [1, 2] }, schema);
  assert.equal(badItem.ok, false);

  // 超 maxItems
  const tooMany = validatePayload({ treasures: new Array(11).fill('x') }, schema);
  assert.equal(tooMany.ok, false);

  // 元素超长
  const tooLong = validatePayload({ treasures: ['x'.repeat(65)] }, schema);
  assert.equal(tooLong.ok, false);
});

test('validatePayload：未声明的数组字段被剥离（攻击面收缩）', () => {
  const schema: PayloadSchema = { a: { type: 'string', minLen: 1, maxLen: 10 } };
  const r = validatePayload({ a: 'hello', treasures: ['hack', 'injected'] }, schema);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal((r.cleaned as any).treasures, undefined);
});
