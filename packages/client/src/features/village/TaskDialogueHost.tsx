/**
 * 自动任务对话宿主。
 *
 * 主线自动激活、支线接取后的对话不应依赖玩家当前是否打开任务页，
 * 因此由 App 常驻挂载；任务快照带回 pendingDialogues 后只弹一次。
 */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { me, req } from '../../api.js';
import { hasModalKey, openModal, playerTaskState } from '../../app/store.js';
import { Btn } from '../../ui/index.js';
import { Modal } from '../../ui/Modal.js';
import { nextDialogueSegment, visibleDialogueSegments } from './task-dialogue-flow.js';

const shown = new Set<string>();

function taskName(state: any, taskCode: string): string {
  const all = [
    ...(state?.active ?? []),
    ...(state?.offered ?? []),
    ...(state?.offeredSide ?? []),
    ...(state?.global?.active ?? []),
    ...(state?.global?.offered ?? []),
    ...(state?.global?.offeredSide ?? []),
    ...(state?.villages ?? []).flatMap((v: any) => [
      ...(v?.active ?? []), ...(v?.offered ?? []), ...(v?.offeredSide ?? []),
    ]),
  ];
  return all.find((item: any) => item?.code === taskCode)?.name ?? taskCode;
}

function PendingDialogueModal({ pending, close }: { pending: any; close: () => void }) {
  const dialogue = pending.dialogue;
  const segments = visibleDialogueSegments(dialogue);
  const [segmentIndex, setSegmentIndex] = useState(0);
  const consumed = useRef(false);
  const current = segments[segmentIndex] ?? dialogue;
  const closeSession = useCallback(() => {
    if (consumed.current) return;
    consumed.current = true;
    close();
    void req('task.ConsumeDialogue', { dialogueId: pending.id });
  }, [close, pending.id]);
  const advanceSegment = useCallback(() => {
    const next = nextDialogueSegment(segmentIndex, segments.length);
    if (next == null) closeSession();
    else setSegmentIndex(next);
  }, [closeSession, segmentIndex, segments.length]);
  const title = current?.npcName || '任务对话';
  return (
    <Modal title={title} sub={taskName(playerTaskState.value, pending.taskCode)} onClose={closeSession}>
      <div class="dialogue-session">
        <div class="dialogue-npc-text">{current?.npcText ?? ''}</div>
        {(current?.replies ?? []).length > 0 && (
          <div class="dialogue-replies" aria-label="玩家回复">
            {(current.replies ?? []).map((reply: any) => (
              <Btn key={reply.key} variant={reply.key === 'leave' ? 'ghost' : 'primary'} onClick={advanceSegment}>
                {reply.label}
              </Btn>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

export function TaskDialogueHost() {
  const state = playerTaskState.value;
  const pending = (state?.pendingDialogues ?? []) as any[];
  const signature = pending
    .map((item) => `${item?.id ?? ''}:${item?.dialogue?.npcName ?? ''}:${item?.dialogue?.npcText ?? ''}`)
    .join('|');

  useEffect(() => {
    // 一次只打开一个 session；关闭或最后一段显式结束后整体消费，避免多个弹窗叠加。
    const item = pending.find((candidate) => {
      const dialogue = candidate?.dialogue;
      return candidate?.id && visibleDialogueSegments(dialogue).length > 0
        && !shown.has(candidate.id)
        && !hasModalKey(`task-auto-dialogue-${candidate.id}`);
    });
    if (!item) return;
    shown.add(item.id);
    openModal(
      (close) => <PendingDialogueModal pending={item} close={close} />,
      `task-auto-dialogue-${item.id}`,
    );
    // signature 让 GM 热重载后仍可让原本空白的 pending 记录弹出。
    void signature;
  }, [signature]);

  // 订阅任务快照；当前操作村名变化时也让服务端模板重新渲染。
  void me?.villageId;
  return null;
}
