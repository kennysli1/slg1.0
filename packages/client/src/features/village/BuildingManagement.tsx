import { act } from '../../app/refresh.js';
import { req } from '../../api.js';
import { Btn, SecondaryActions, confirmDanger } from '../../ui/index.js';

/** 所有建筑详情弹窗共用的折叠管理区；拆除入口不再显示在建筑卡片上。 */
export function BuildingManagement({ slotId, name, onClose }: { slotId: string; name: string; onClose: () => void }) {
  const demolish = async () => {
    const ok = await confirmDanger({
      title: `拆除${name}`,
      body: '整栋建筑会被完全拆除，不消耗也不返还资源；拆除开始后不可取消，期间不提供任何加成。',
      confirmText: '确认拆除',
    });
    if (!ok) return;
    await act(req('DemolishBuilding', { slotId }), { okToast: '拆除已开始' });
    onClose();
  };

  return (
    <SecondaryActions label="建筑管理" hint="拆除与移除">
      <p class="secondary-actions__hint">仅在确定不再需要这栋建筑时操作；拆除期间建筑不会提供任何加成。</p>
      <Btn variant="danger" size="sm" onClick={() => void demolish()}>拆除建筑</Btn>
    </SecondaryActions>
  );
}
