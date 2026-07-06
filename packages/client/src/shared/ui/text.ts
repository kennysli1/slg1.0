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
  requires_not_met: '前置建筑不满足，尚未解锁',
  max_level: '已达最高等级',
  spend_failed: '资源不足',
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
};

/** 把服务器错误码翻译成中文，处理带后缀的码（insufficient:wood、insufficient_troops:xx）。 */
export function errText(code?: string): string {
  if (!code) return '操作失败';
  if (ERR_MSG[code]) return ERR_MSG[code];
  if (code.startsWith('bad_troops')) return '出征兵力不合法';
  if (code.startsWith('requires_building')) return '缺少训练所需建筑';
  if (code.startsWith('insufficient_troops')) return '兵力不足';
  if (code.startsWith('insufficient:')) {
    const r = code.split(':')[1];
    return `${resInfo(r).name ?? r}不足`;
  }
  if (code.startsWith('unknown_')) return '目标不存在';
  return code;
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
