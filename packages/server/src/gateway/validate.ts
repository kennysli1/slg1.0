/**
 * 接入层 · Payload 校验器
 *
 * 根据 ActionRoute.schema 对 WireRequest.payload 做轻量校验：
 *  - 类型检查（string / integer / number / boolean / enum / record_int）
 *  - 范围（min/max）/ 长度（minLen/maxLen）/ 枚举值 / record_int 键数与值范围
 *  - 剥离 schema 中未声明的字段（收缩攻击面）
 *  - 必填字段缺失即以 missing_field 拒绝
 *
 * 不依赖任何第三方库；所有类型定义在本文件，由 manifest.ts 重导出。
 */

/** 单个字段的校验规则。 */
export interface FieldSchema {
  /** 期望的基础类型。 */
  type: 'string' | 'integer' | 'number' | 'boolean' | 'enum' | 'record_int';
  /** true=字段可缺失；false/未填=必填。 */
  optional?: boolean;
  /** number / integer：下界（含）。 */
  min?: number;
  /** number / integer：上界（含）。 */
  max?: number;
  /** string：最小字符数。 */
  minLen?: number;
  /** string：最大字符数。 */
  maxLen?: number;
  /** enum：合法值集合。 */
  values?: readonly string[];
  /** record_int：最多允许多少个 key。 */
  maxKeys?: number;
  /** record_int：每个值的下界（含）。 */
  minVal?: number;
  /** record_int：每个值的上界（含）。 */
  maxVal?: number;
}

/** action 的 payload 结构描述：key → 对应字段规则。 */
export type PayloadSchema = Record<string, FieldSchema>;

/** validatePayload 返回值。 */
export type ValidateResult =
  | { ok: true; cleaned: Record<string, unknown> }
  | { ok: false; code: string; msg: string };

/**
 * 校验并净化 payload。
 *  - 按 schema 逐字段校验类型/范围/长度/枚举。
 *  - 仅保留 schema 中声明的字段（剥离多余字段）。
 *  - 不修改传入对象。
 */
export function validatePayload(
  raw: Record<string, unknown>,
  schema: PayloadSchema,
): ValidateResult {
  const cleaned: Record<string, unknown> = {};

  for (const [key, def] of Object.entries(schema)) {
    const val = raw[key];

    if (val === undefined || val === null) {
      if (!def.optional) return { ok: false, code: 'missing_field', msg: `缺少必填字段: ${key}` };
      continue;
    }

    switch (def.type) {
      case 'string': {
        if (typeof val !== 'string')
          return { ok: false, code: 'bad_type', msg: `字段 ${key} 应为字符串` };
        if (def.minLen !== undefined && val.length < def.minLen)
          return { ok: false, code: 'too_short', msg: `字段 ${key} 过短（最少 ${def.minLen} 字符）` };
        if (def.maxLen !== undefined && val.length > def.maxLen)
          return { ok: false, code: 'too_long', msg: `字段 ${key} 过长（最多 ${def.maxLen} 字符）` };
        cleaned[key] = val;
        break;
      }
      case 'integer': {
        if (typeof val !== 'number' || !Number.isInteger(val) || !isFinite(val))
          return { ok: false, code: 'bad_type', msg: `字段 ${key} 应为整数` };
        if (def.min !== undefined && val < def.min)
          return { ok: false, code: 'out_of_range', msg: `字段 ${key} 不能小于 ${def.min}` };
        if (def.max !== undefined && val > def.max)
          return { ok: false, code: 'out_of_range', msg: `字段 ${key} 不能大于 ${def.max}` };
        cleaned[key] = val;
        break;
      }
      case 'number': {
        if (typeof val !== 'number' || !isFinite(val))
          return { ok: false, code: 'bad_type', msg: `字段 ${key} 应为有限数字` };
        if (def.min !== undefined && val < def.min)
          return { ok: false, code: 'out_of_range', msg: `字段 ${key} 不能小于 ${def.min}` };
        if (def.max !== undefined && val > def.max)
          return { ok: false, code: 'out_of_range', msg: `字段 ${key} 不能大于 ${def.max}` };
        cleaned[key] = val;
        break;
      }
      case 'boolean': {
        if (typeof val !== 'boolean')
          return { ok: false, code: 'bad_type', msg: `字段 ${key} 应为 boolean` };
        cleaned[key] = val;
        break;
      }
      case 'enum': {
        if (typeof val !== 'string')
          return { ok: false, code: 'bad_type', msg: `字段 ${key} 应为字符串` };
        if (!def.values?.includes(val))
          return { ok: false, code: 'bad_enum', msg: `字段 ${key} 的值不合法` };
        cleaned[key] = val;
        break;
      }
      case 'record_int': {
        if (typeof val !== 'object' || val === null || Array.isArray(val))
          return { ok: false, code: 'bad_type', msg: `字段 ${key} 应为 Record<string, number>` };
        const entries = Object.entries(val as Record<string, unknown>);
        if (def.maxKeys !== undefined && entries.length > def.maxKeys)
          return { ok: false, code: 'too_many_keys', msg: `字段 ${key} 键数超限（最多 ${def.maxKeys}）` };
        const rec: Record<string, number> = {};
        for (const [k, v] of entries) {
          if (typeof v !== 'number' || !Number.isInteger(v) || !isFinite(v))
            return { ok: false, code: 'bad_type', msg: `字段 ${key}.${k} 应为整数` };
          if (def.minVal !== undefined && v < def.minVal)
            return { ok: false, code: 'out_of_range', msg: `字段 ${key}.${k} 不能小于 ${def.minVal}` };
          if (def.maxVal !== undefined && v > def.maxVal)
            return { ok: false, code: 'out_of_range', msg: `字段 ${key}.${k} 不能大于 ${def.maxVal}` };
          rec[k] = v;
        }
        cleaned[key] = rec;
        break;
      }
    }
  }

  return { ok: true, cleaned };
}
