/** 常驻战场 HUD：玩家身份、当前村庄与资源概况。 */
import { me, clearSession } from '../api.js';
import { sessionVersion } from '../app/store.js';
import { Icon } from '../ui/index.js';
import { ResourceBar } from './ResourceBar.js';

export function TopBar() {
  sessionVersion.value;
  function onLogout() {
    if (!window.confirm('确定退出登录？退出后可重新登录或注册新账号。')) return;
    clearSession();
    window.location.reload();
  }

  return (
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"><Icon icon="ui_logo" label="" decorative size="md" /></span>
        <div class="brand-copy">
          <div class="brand-title">世界之王</div>
          <div class="brand-sub">
            <span title={me?.name}>{me?.name}</span>
            <button class="logout-btn" type="button" onClick={onLogout} title="退出登录 / 切换账号">退出</button>
          </div>
        </div>
      </div>
      <ResourceBar />
    </header>
  );
}
