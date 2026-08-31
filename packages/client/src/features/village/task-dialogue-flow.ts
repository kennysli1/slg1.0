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

export type DeliverReplyIntent = 'close' | 'claim' | 'advance' | 'ignore';

/** 首次 take 才结算；领取后的回复只推进，领取前的异常回复不能绕过确认。 */
export function deliverReplyIntent(replyKey: string, claimed: boolean): DeliverReplyIntent {
  if (replyKey === 'leave') return 'close';
  if (claimed) return 'advance';
  if (replyKey === 'take') return 'claim';
  return 'ignore';
}
