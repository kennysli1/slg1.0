/**
 * 自动任务对话宿主。
 *
 * 主线自动激活、支线接取后的对话不应依赖玩家当前是否打开任务页，
 * 因此由 App 常驻挂载；任务快照带回 pendingDialogues 后只弹一次。
 */
import { useEffect } from 'preact/hooks';
import { me, req } from '../../api.js';
import { hasModalKey, openModal, playerTaskState } from '../../app/store.js';
import { Modal } from '../../ui/Modal.js';

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
  const title = dialogue?.npcName || '任务对话';
  const finish = () => {
    close();
    void req('task.ConsumeDialogue', { dialogueId: pending.id });
  };
  return (
    <Modal title={title} sub={taskName(playerTaskState.value, pending.taskCode)} onClose={finish}>
      <div class="dialogue-session">
        <div class="dialogue-npc-text">{dialogue?.npcText ?? ''}</div>
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
    // 一次只打开一段，关闭并消费后刷新会带回下一段，避免多个弹窗叠在一起。
    const item = pending.find((candidate) => {
      const dialogue = candidate?.dialogue;
      return candidate?.id && dialogue && (dialogue.npcName || dialogue.npcText)
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
