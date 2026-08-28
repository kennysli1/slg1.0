/**
 * 王国页持续上下文：当前操作村与它的库存。
 *
 * 这里不拥有村庄状态，也不复制切村 action；切村仍由 VillageSwitcher
 * 复用现有 switchVillage 链路，资源仍由 VillageResourceLedger 读取。
 */
import { VillageResourceLedger } from './VillageResourceLedger.js';
import { VillageSwitcher } from './VillageSwitcher.js';

export function VillageCommandDock() {
  return (
    <section class="village-command-dock" aria-label="王国当前操作村上下文">
      <div class="village-command-dock__eyebrow">王国 · 当前操作</div>
      <div class="village-command-dock__village">
        <VillageSwitcher />
      </div>
      <div class="village-command-dock__resources">
        <VillageResourceLedger embedded />
      </div>
    </section>
  );
}
