/**
 * 接取对话的段落推进规则。
 *
 * 接取对话的第一段若仍有「接受任务」回复，关闭/选择「离开」只应关闭
 * 对话，不能提前展示“接受后”段落（S3 的 s3_accept 第 2 段即此情形）。
 * 任务已经接受，或当前段没有接受回复时，关闭才按普通多段对话推进。
 */
export function shouldAdvanceDialogueOnClose(
  segment: { replies?: Array<{ key?: string }> } | undefined,
  accepted: boolean,
): boolean {
  if (accepted) return true;
  return !(segment?.replies ?? []).some((reply) => reply.key === 'accept');
}
