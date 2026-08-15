/**
 * 存档结构版本号（落盘数据的 schema 版本，与协议版本 WIRE_VERSION 无关）。
 *
 * 什么时候必须升：改了任何会落盘的数据结构——集合新增/删除、主键规则变化、
 * 字段增删改名、坐标系变化（如方格改六边形）。
 *
 * 升了它就意味着老存档读不了，部署必须带刷档：
 *   bash .claude/deploy/deploy.sh --reset respawn
 *
 * 强制约束（scripts/guard/check-version.mjs）：本常量与 CHANGELOG 的 `[需刷档]`
 * 标记双向绑定——升了不写标记、写了标记不升，都会被拒绝提交。
 * 规矩全文见 docs/00_变更契约.md R6。
 */
export const SAVE_SCHEMA_VERSION = 5;
