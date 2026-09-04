/**
 * 存档结构版本号（落盘数据的 schema 版本，与协议版本 WIRE_VERSION 无关）。
 *
 * 什么时候必须升：改了任何会落盘的数据结构——集合新增/删除、主键规则变化、
 * 字段增删改名、坐标系变化（如方格改六边形）。
 *
 * 升了它表示需要评估旧存档兼容性；优先使用迁移、默认值或惰性初始化。
 * 只有旧存档确实无法读取时，才单独制定并授权刷档方案。
 *
 * 强制约束（scripts/guard/check-version.mjs）：本常量与 CHANGELOG 的 `[需刷档]`
 * 标记双向绑定——升了不写标记、写了标记不升，都会被拒绝提交。
 * 规矩全文见 docs/00_变更契约.md R6。
 */
// v7：新战场冻结 role/traits 与阶段游标；旧 rulesetVersion=2 战场继续用 v2 结算。
export const SAVE_SCHEMA_VERSION = 7;
