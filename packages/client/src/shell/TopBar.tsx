/** 顶栏：徽标 + 玩家/村庄切换 + 资源条。 */
import { me, selectVillage } from '../api.js';
import { sessionVersion, showToast } from '../app/store.js';
import { refreshAll } from '../app/refresh.js';
import { errText } from '../shared/ui/text.js';
import { Icon } from '../ui/index.js';
import { ResourceBar } from './ResourceBar.js';

export function TopBar() {
  sessionVersion.value; // 切村/登录后重渲
  const villages = me?.villages ?? [];

  async function onPick(e: Event) {
    const sel = e.currentTarget as HTMLSelectElement;
    const id = sel.value;
    if (!id || id === me?.villageId) return;
    const r = await selectVillage(id);
    if (!r.ok) {
      showToast(`切换村庄失败：${errText(r.error)}`, 'bad');
      sel.value = me?.villageId ?? '';
      return;
    }
    sessionVersion.value++;
    await refreshAll();
  }

  const current = villages.find((v) => v.id === me?.villageId);

  return (
    <header class="topbar">
      <div class="brand">
        <Icon icon="ui_logo" label="世界之王" size="md" />
        <div>
          <div class="brand-title">世界之王</div>
          <div class="brand-sub">
            <span>{me?.name}</span>
            {villages.length > 1 ? (
              <select class="village-pick" value={me?.villageId} onChange={onPick} title="切换当前操作的村庄">
                {villages.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}{v.isCapital ? '（主城）' : ''} ({v.q},{v.r})
                  </option>
                ))}
              </select>
            ) : (
              <span>{current?.name ?? `(${me?.q},${me?.r})`}</span>
            )}
          </div>
        </div>
      </div>
      <ResourceBar />
    </header>
  );
}
