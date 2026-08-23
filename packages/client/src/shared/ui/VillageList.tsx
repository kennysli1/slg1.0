import { useState } from 'preact/hooks';
import { me, applyMe, req } from '../../api.js';
import { switchVillage } from '../../app/refresh.js';
import { act } from '../../app/refresh.js';
import { dataVersion, openModal, sessionVersion, villageSwitching, showToast } from '../../app/store.js';
import { Btn, Modal, Panel } from '../../ui/index.js';
import type { MeVillage } from '../../api.js';

function RenameVillageModal({ village, close }: { village: MeVillage; close: () => void }) {
  const [name, setName] = useState(village.name);
  const [saving, setSaving] = useState(false);
  const trimmed = name.trim();

  async function save() {
    if (!trimmed || saving) return;
    setSaving(true);
    const ok = await act(req('RenameVillage', { villageId: village.id, name: trimmed }), {
      okToast: '村庄名称已修改',
      onOk: (payload) => applyMe((payload as any).player, true),
    });
    setSaving(false);
    if (ok) {
      close();
      sessionVersion.value++;
    }
  }

  return (
    <Modal
      title="修改村庄名"
      sub={`X ${village.q} · Y ${village.r}`}
      onClose={saving ? () => {} : close}
      foot={
        <>
          <Btn variant="ghost" disabled={saving} onClick={close}>取消</Btn>
          <Btn variant="primary" disabled={saving || !trimmed} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</Btn>
        </>
      }
    >
      <label class="field-label" for="village-name-input">村庄名称</label>
      <input
        id="village-name-input"
        class="village-name-input"
        type="text"
        value={name}
        maxLength={24}
        data-modal-initial-focus
        onInput={(event) => setName((event.currentTarget as HTMLInputElement).value)}
        onKeyDown={(event) => { if (event.key === 'Enter') void save(); }}
      />
      <p class="village-name-hint">名称会同步到村庄列表和地图。</p>
    </Modal>
  );
}

/** 村庄工作区切换器：村庄、军队、科技页共用，明确当前数据所属村庄。 */
export function VillageList() {
  sessionVersion.value;
  dataVersion.value;
  const switching = villageSwitching.value;
  // 即使当前只有一座村庄也显示列表：玩家需要明确知道这些页面按村庄
  // 隔离，拓荒出第二座村庄后可直接在同一位置切换。旧版会在 <=1 座时
  // 整块隐藏，导致新账号误以为村庄切换没有落地；没有 villages 数组时
  // 用当前村庄兼容旧登录响应。
  const villages = me?.villages?.length
    ? me.villages
    : me
      ? [{ id: me.villageId, q: me.q, r: me.r, name: '当前村庄', isCapital: true }]
      : [];
  if (villages.length === 0) return null;

  async function pick(villageId: string) {
    if (switching || !villageId || villageId === me?.villageId) return;
    const result = await switchVillage(villageId);
    if (!result.ok) {
      showToast('切换村庄失败，请稍后重试', 'bad');
      return;
    }
  }

  function rename(village: MeVillage) {
    openModal((close) => <RenameVillageModal village={village} close={close} />, `rename-village-${village.id}`);
  }

  return (
    <Panel variant="flat" pad class="village-list-panel">
      <div class="village-list-title">我的村庄</div>
      <div class="village-list" role="list" aria-label="切换村庄">
        {villages.map((village) => (
          <div
            key={village.id}
            role="listitem"
            tabIndex={0}
            class={`village-list-item${village.id === me?.villageId ? ' active' : ''}${switching ? ' is-switching' : ''}`}
            onClick={() => void pick(village.id)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                void pick(village.id);
              }
            }}
          >
            <button
              type="button"
              class="village-list-select"
              aria-current={village.id === me?.villageId ? 'page' : undefined}
              onClick={(event) => { event.stopPropagation(); void pick(village.id); }}
            >
              <span class="village-list-name">{village.name}{village.isCapital ? '（主城）' : ''}</span>
              <span class="village-list-coords">X {village.q} · Y {village.r}</span>
            </button>
            <div class="village-list-actions">
              <Btn
                size="sm"
                variant="ghost"
                class="village-list-rename"
                disabled={!!switching}
                onClick={(event) => { event.stopPropagation(); rename(village); }}
              >修改名称</Btn>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
