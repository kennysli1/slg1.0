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
  training_not_found: '该训练队列已完成或已取消',
  training_building_not_found: '训练建筑选择已失效，请刷新后重试',
  invalid_training_building: '所选建筑不能训练该兵种',
  queue_full: '当前队列已满，请稍后添加',
  requires_not_met: '前置建筑不满足，尚未解锁',
  max_level: '已达最高等级',
  spend_failed: '资源不足',
  slot_empty: '该建筑槽位为空',
  slot_busy: '该建筑正在建造或升级',
  still_constructing: '建筑尚未完成',
  building_damaged: '建筑已受损，请先修复后再升级',
  not_damaged: '该建筑没有可修复的损坏等级',
  no_free_slot: '该区域没有空槽',
  max_count: '该建筑已达到本村建造上限',
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
  village_name_empty: '村庄名称不能为空',
  village_name_too_long: '村庄名称不能超过24个字符',
  not_logged_in: '请重新登录',
  network_error: '网络连接异常',
  insufficient_population: '人口不足，无法训练',
  // 训练/动员相关
  mobilize_cap_exceeded: '已达本族动员上限（士兵占总人口比例超限），无法继续训练',
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
  found_inflight_limit: '已有拓荒队伍在途',
  tile_occupied: '目标地块已被占用',
  too_close_to_village: '距离其他村庄过近',
  village_creation_failed: '建村失败：目标地块冲突，请稍后重试',
  out_of_map: '超出地图范围',
  no_settlers: '拓荒者不足',
  no_settler_unit: '当前部族没有拓荒者',
  cargo_exceeds_carry: '货物超过部队负重',
  empty_cargo: '请填写运输货物',
  transfer_no_cargo: '地图转移不能携带物资，请使用贸易中心转移资源',
  transfer_target_unavailable: '目标不在贸易中心半径内，或不是己方/盟友村庄',
  invalid_transfer_resource: '资源转移只支持木材、泥土、铁和粮食',
  same_village: '不能运往出发村本身',
  no_center: '所选村庄没有贸易中心，无法派出贡献商队',
  insufficient_routes: '所选村庄没有足够的空闲贸易路线，暂时不能运输',
  insufficient_resources: '所选村庄资源不足，无法运输这批贡献',
  alliance_hall_required: '联盟大厅不存在或暂时无法连接',
  alliance_disconnected: '联盟大厅失联，暂时不能贡献资源',
  alliance_delivery_mismatch: '贡献商队数据异常，请刷新后重试',
  building_in_progress: '联盟建筑正在建造中，完成前不能更改规划',
  tech_in_progress: '联盟科技正在研发中，完成前不能更改规划',
  building_already_planned: '联盟建筑已有规划，请先更改规划或等待资源到位',
  tech_already_planned: '联盟科技已有规划，请先更改规划或等待科技点到位',
  not_own_village: '只能运往自己的村庄',
  declare_war_required: '该玩家目前为中立，必须确认宣战后才能掠夺或攻城',
  allied_target: '盟军村庄不能掠夺或攻城，请改用增援',
  hostile_target: '敌对村庄不能执行增援',
  scout_units_only: '侦察行军只能携带侦察兵或冒险者',
  incoming_not_found: '该来袭预警已消失或敌军行军已经结束',
  incoming_not_visible: '来袭军已离开当前视野，无法继续派出侦察兵',
  not_enemy_village: '侦察目标必须是其他玩家的村庄',
  cannot_abandon_capital: '不能放弃主城',
  abandon_locked: '新建分城冷却中，暂不可放弃',
  village_not_owned: '不是你的村庄',
  // 宝物相关
  army_not_returned: '军队尚未归村，无法领取',
  carry_cap_exceeded: '携带宝物超出兵力上限',
  pending_not_found: '该战报已不存在或已被处理',
  pending_expired: '该战报已超时遗弃',
  no_room: '宝物栏已满，无法替换入栏',
  treasure_slots_full: '宝库已满，无法收获炼化宝物',
  alchemy_not_built: '尚未建成炼金炉',
  alchemy_slot_occupied: '该炼金炉槽位已有宝物',
  alchemy_slot_invalid: '炼金炉槽位无效',
  alchemy_quality_mismatch: '炼金炉中的宝物品质必须相同',
  alchemy_not_ready: '炼化尚未完成',
  alchemy_in_progress: '炼金炉正在炼化',
  alchemy_result_pending: '请先收获炼化结果',
  alchemy_no_target: '没有可炼化出的更高品质宝物',
  alchemy_no_input: '炼金炉需要三个相同品质的宝物',
  no_reserve_room: '备用宝物栏没有空位',
  no_main_room: '主宝物栏没有空位',
  not_in_reserve: '该宝物不在备用栏',
  invalid_location: '宝物栏位置不合法',
  merc_capacity_exceeded: '佣兵统御容量不足',
  quest_cooldown: '该任务仍在冷却中',
  abandon_cooldown: '任务刚被放弃，请等待冷却结束',
  not_active: '该任务已不在进行中，请刷新任务列表',
  not_ready: '任务尚未达到领取条件',
  delivery_in_progress: '奖励正在领取，请勿重复操作',
  qualifying_flag_not_stored: '合格军旗尚未入库，暂时无法领取奖励',
  reward_preview_failed: '奖励预览暂时不可用，请稍后重试',
  delivery_failed: '奖励结算失败，任务仍可重新领取',
  recovery_cooldown: '战败恢复仍在冷却中',
  march_points_exhausted: '行军点已用完；升级集结点可提高同时在外行动的军队数量',
  already_stopped: '该部队已经停止待命',
  not_stopped: '该部队当前不处于停止状态',
  not_stoppable: '该部队当前无法停止',
  not_recallable: '该部队当前无法撤回',
  already_returning: '该部队已经在返程中',
  in_combat: '部队交战中，无法下达该命令',
  use_garrison_commands: '驻扎军请使用驻扎指令',
  use_recall_garrison: '驻扎军请使用召回指令',
  garrison_not_found: '这支驻扎军已不存在或不归你指挥',
  war_plan_not_found: '联盟军事目标不存在',
  war_plan_closed: '联盟军事目标已关闭',
  deadline_too_soon: '倒计时至少需要 10 秒',
  cannot_arrive_before_deadline: '倒计时太短，军队无法及时到达目标',
  war_or_leader_required: '只有盟主或战争专家可以操作联盟战事',
  war_deadline_passed: '倒计时已结束，不能再取消行动',
  war_not_dispatched: '全部兵力尚未派出，暂时不能执行全员撤回',
  war_recall_window_expired: '全员撤回窗口已过（派出后 90 秒）',
  garrison_player_target_forbidden: '驻扎军不能续行至玩家控制的格子',
  invalid_continuation_mode: '该目标不支持此行军模式，请重新选择',
  same_tile: '目标不能是部队当前所在格',
  target_unexplored: '目标仍未探索；只能派军执行探索行军',
  target_already_explored: '该格已被探索，请改用驻扎、掠夺或攻城命令',
  explore_too_deep: '目标未探索深度超过集结点允许范围；升级集结点后再试',
  vision_unavailable: '无法确认地图视野，请稍后重试',
  insufficient_reputation: '声望不足，无法购买该王国服务',
  council_level_too_low: '议会厅等级不足',
  kingdom_service_not_found: '王国服务不存在或配置已更新',
  kingdom_attack_target_required: '请先选择王国军队的攻击目标',
  cannot_attack_kingdom_landmark: '王国军队不会攻击王都或封地',
  kingdom_attack_target_unavailable: '该目标不接受王国代打服务',
  kingdom_task_not_submittable: '当前没有可上贡的王国任务',
  kingdom_task_not_ready: '王国任务目标尚未完成',
  kingdom_task_expired: '王国任务已经过期',
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
