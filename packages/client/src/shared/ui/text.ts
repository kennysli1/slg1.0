/** 服务器错误码 → 中文文案；兵种分类/部族显示名。 */
import { resInfo } from '../../app/config.js';

const ERR_MSG: Record<string, string> = {
  name_taken: '该名字已被注册',
  no_such_user: '用户不存在',
  wrong_password: '密码错误',
  password_too_short: '密码至少4位',
  empty_name: '请输入名字',
  name_too_long: '名字太长(≤16)',
  queue_busy: '已有建造/训练在进行，请等当前完成',
  queue_full: '当前队列已满，请稍后添加',
  requires_not_met: '前置建筑不满足，尚未解锁',
  max_level: '已达最高等级',
  spend_failed: '资源不足',
  slot_empty: '该建筑槽位为空',
  slot_busy: '该建筑正在建造或升级',
  still_constructing: '建筑尚未完成',
  no_free_slot: '该区域没有空槽',
  bad_zone: '建筑区域不合法',
  zone_mismatch: '不能建在这个区域',
  bad_count: '数量不合法',
  bad_troops: '出征兵力不合法',
  empty_troops: '请至少选择一种出征兵力',
  bad_field: '资源田不存在',
  wrong_tribe_unit: '该兵种不属于你的部族',
  no_troops: '没有可派出的兵力',
  target_not_found: '目标不存在或已消失',
  origin_not_found: '出发村庄不存在',
  cannot_attack_self: '不能攻击自己的村庄',
  village_not_found: '村庄不存在',
  not_logged_in: '请重新登录',
  network_error: '网络连接异常',
  insufficient_population: '人口不足，无法训练',
  // 训练/动员相关
  mobilize_cap_exceeded: '已达本族动员上限（士兵占总人口比例超限），无法继续训练',
  smithy_busy: '铁匠铺正在升级中，请稍后再试',
  bad_units: '解散兵种不合法',
  battle_forbidden: '不能查看这场战斗',
  // 协议/信封错误
  protocol_error: '协议版本不兼容，请刷新页面',
  version_mismatch: '协议版本不兼容，请刷新页面',
  bad_envelope: '消息格式错误，请刷新重试',
  // 流量与 payload 错误
  rate_limited: '请求过于频繁，请稍后再试',
  invalid_payload: '请求格式不合法',
  message_too_large: '消息体过大，请减少数据量',
  // 分城 / 运输
  main_level_too_low: '主基地等级不足，无法拓荒',
  soft_limit_too_low: '人口规模不足，无法拓荒',
  found_inflight_limit: '已有拓荒队伍在途',
  tile_occupied: '目标地块已被占用',
  too_close_to_village: '距离其他村庄过近',
  out_of_map: '超出地图范围',
  no_settlers: '拓荒者不足',
  no_settler_unit: '当前部族没有拓荒者',
  cargo_exceeds_carry: '货物超过部队负重',
  empty_cargo: '请填写运输货物',
  same_village: '不能运往出发村本身',
  not_own_village: '只能运往自己的村庄',
  cannot_abandon_capital: '不能放弃主城',
  abandon_locked: '新建分城冷却中，暂不可放弃',
  village_not_owned: '不是你的村庄',
  // 宝物相关
  army_not_returned: '军队尚未归村，无法领取',
  carry_cap_exceeded: '携带宝物超出兵力上限',
  pending_not_found: '该战报已不存在或已被处理',
  pending_expired: '该战报已超时遗弃',
  no_room: '宝物栏已满，无法替换入栏',
};

/** 把服务器错误码翻译成中文，处理带后缀的码（insufficient:wood、insufficient_troops:xx）。 */
export function errText(code?: string): string {
  if (!code) return '操作失败';
  if (ERR_MSG[code]) return ERR_MSG[code];
  if (code.startsWith('bad_troops')) return '出征兵力不合法';
  if (code.startsWith('requires_building')) return '缺少训练所需建筑';
  if (code.startsWith('insufficient_troops')) return '兵力不足';
  if (code.startsWith('unknown_unit')) return '未知兵种';
  if (code.startsWith('unknown_building')) return '未知建筑';
  if (code.startsWith('insufficient:')) {
    const r = code.split(':')[1];
    return `${resInfo(r).name ?? r}不足`;
  }
  if (code.startsWith('unknown_')) return '目标不存在';
  // 未知错误码不原样回显（防注入 / 防泄漏内部细节）
  return '操作失败';
}

export function formName(f: string): string {
  return { melee: '近战', ranged: '远程' }[f] ?? f;
}
export function tribeName(t: string): string {
  return { romans: '罗马', gauls: '高卢', teutons: '条顿' }[t] ?? t;
}

export const TRIBES = [
  { key: 'romans', name: '罗马', desc: '均衡全能，后期强力' },
  { key: 'gauls', name: '高卢', desc: '防守与速度见长' },
  { key: 'teutons', name: '条顿', desc: '便宜量大，掠夺凶猛' },
];
