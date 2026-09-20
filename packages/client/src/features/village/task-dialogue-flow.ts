export interface TaskDialogueSegment {
  npcName?: string;
  npcText?: string;
  replies?: Array<{ key: string; label: string }>;
  [key: string]: unknown;
}

/** 对话只有显式文本、对象名或回复时才算可展示段落。 */
export function visibleDialogueSegments(dialogue: any): TaskDialogueSegment[] {
  const source = Array.isArray(dialogue?.segments) && dialogue.segments.length
    ? dialogue.segments
    : [dialogue];
  return source.filter((item: TaskDialogueSegment | null | undefined) => Boolean(
    item && (item.npcName || item.npcText || (item.replies?.length ?? 0) > 0),
  )) as TaskDialogueSegment[];
}

/** 返回下一段索引；null 表示当前段已是最后一段，应结束整个 session。 */
export function nextDialogueSegment(index: number, segmentCount: number): number | null {
  return index < segmentCount - 1 ? index + 1 : null;
}

export type AcceptReplyIntent = 'close' | 'accept' | 'advance';

/** leave 永远关闭；accept 只在尚未接取时触发一次服务端接取。 */
export function acceptReplyIntent(replyKey: string, accepted: boolean): AcceptReplyIntent {
  if (replyKey === 'leave') return 'close';
  if (replyKey === 'accept' && !accepted) return 'accept';
  return 'advance';
}

export type TaskDialogueReplyIntent = AcceptReplyIntent | 'sanctum_activate';

/**
 * 接取对话的少量“领域确认”回复。
 *
 * s23 的第二段并不是任务接取，也不是普通段落推进：玩家已经在第一段明确接取
 * 了任务，只有再点击配置中心中的 `awaken` 回复才允许请求 Sanctum owner 开启/加入
 * 活动。把这一层判断留在纯状态机里，能保证 X、Esc、遮罩和 `leave` 永远不会产生
 * 副作用，也让关闭后重新打开该对话时仍使用同一条受控路径。
 */
export function taskDialogueReplyIntent(
  taskCode: string,
  trigger: string,
  replyKey: string,
  accepted: boolean,
): TaskDialogueReplyIntent {
  if (taskCode === 's23' && trigger === 'sanctum_awaken' && replyKey === 'awaken') return 'sanctum_activate';
  return acceptReplyIntent(replyKey, accepted);
}

export type DeliverReplyIntent = 'close' | 'claim' | 'advance' | 'ignore';

/** 首次 take 才结算；领取后的回复只推进，领取前的异常回复不能绕过确认。 */
export function deliverReplyIntent(replyKey: string, claimed: boolean): DeliverReplyIntent {
  if (replyKey === 'leave') return 'close';
  if (claimed) return 'advance';
  if (replyKey === 'take') return 'claim';
  return 'ignore';
}
