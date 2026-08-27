import { dataVersion, kingdomState, playerTaskState, tab, taskStates, tick } from '../../app/store.js';
import { me } from '../../api.js';
import { Panel, Tag, Btn } from '../../ui/index.js';
import { TaskCard } from './TaskBar.js';

function taskRank(task: any): number {
  if (task.ready) return 0;
  if (task.type === 'main') return 1;
  if (task.type === 'side') return 2;
  return 3;
}

function currentTask(): any | null {
  const villageId = me?.villageId;
  const player = playerTaskState.value;
  const local = player?.villages?.find((v: any) => v.villageId === villageId)?.active
    ?? taskStates.value[villageId ?? '']?.active
    ?? [];
  const all = [...(player?.global?.active ?? []), ...local];
  const unique = new Map<string, any>();
  for (const task of all) {
    if (task?.code && !unique.has(task.code)) unique.set(task.code, task);
  }
  return [...unique.values()].sort((a, b) => taskRank(a) - taskRank(b))[0] ?? null;
}

function taskTag(task: any) {
  if (task.type === 'main') return <Tag kind="gold">主线</Tag>;
  if (task.type === 'side') return <Tag kind="ember">支线</Tag>;
  return <Tag kind="jade">日常</Tag>;
}

/** 王国页首屏的单任务聚焦区；任务仍可从此处进入原有任务簿。 */
export function VillageTaskSummary() {
  dataVersion.value;
  playerTaskState.value;
  taskStates.value;
  kingdomState.value;
  tick.value;

  const task = currentTask();

  return (
    <section class="vil-current-task" aria-label="当前任务">
      <Panel variant="gold" corners pad class="vil-current-task-panel">
        <div class="vil-current-task-head">
          <div>
            <span class="vil-eyebrow">王国事务 · 当前任务</span>
            {task ? (
              <div class="vil-current-task-title">
                <h1>{task.name}</h1>
                {taskTag(task)}
                {task.scope === 'global' && <Tag kind="steel">全局</Tag>}
              </div>
            ) : (
              <h1>当前没有待处理事务</h1>
            )}
          </div>
          <button class="vil-current-task-link" type="button" onClick={() => { tab.value = 'tasks'; }}>
            任务簿 <span aria-hidden="true">↗</span>
          </button>
        </div>

        {task ? (
          <div class="vil-current-task-body">
            <TaskCard task={task} hideHeader />
          </div>
        ) : (
          <div class="vil-current-task-empty">
            <span>去任务簿查看新的主线、支线和日常委托。</span>
            <Btn size="sm" variant="ghost" onClick={() => { tab.value = 'tasks'; }}>查看任务</Btn>
          </div>
        )}
      </Panel>
    </section>
  );
}
