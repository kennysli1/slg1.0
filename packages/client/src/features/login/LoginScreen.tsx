/** 登录 / 注册：全屏史诗背景 + 鎏金卡片 + 部族选择（带兵种立绘）。 */
import { useState } from 'preact/hooks';
import { login, register } from '../../api.js';
import { errText, TRIBES } from '../../shared/ui/text.js';
import { Icon, Btn, Panel } from '../../ui/index.js';

/** 部族的代表兵种立绘与配色，让选择不再只是三行文字。 */
const TRIBE_ART: Record<string, { icon: string; traits: string[] }> = {
  romans: { icon: 'unit_legionnaire', traits: ['均衡全能', '后期强力', '攻守兼备'] },
  gauls: { icon: 'unit_phalanx', traits: ['防守稳健', '行军迅捷', '易于守成'] },
  teutons: { icon: 'unit_clubswinger', traits: ['造价低廉', '掠夺凶猛', '前期压制'] },
};

const SERVERS = [
  { id: 'main', name: '主服', description: '正式世界 · 8080', port: '8080' },
  { id: 'test-01', name: 'AI 测试服 01', description: '独立测试世界 · 8081', port: '8081' },
] as const;

function serverUrl(port: string): string {
  const url = new URL(window.location.href);
  url.port = port;
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function LoginScreen({ booting, notice, onSuccess }: {
  booting: boolean;
  notice: string;
  onSuccess: () => void;
}) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [pwd, setPwd] = useState('');
  const [tribe, setTribe] = useState('romans');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const currentServerId = window.location.port === '8081' ? 'test-01' : 'main';

  async function submit() {
    if (busy || booting) return;
    const n = name.trim();
    if (!n || !pwd) { setMsg('请输入用户名和密码'); return; }
    setBusy(true);
    setMsg('');
    const res = mode === 'register' ? await register(n, pwd, tribe) : await login(n, pwd);
    setBusy(false);
    if (res.ok) onSuccess();
    else setMsg(errText(res.error));
  }

  const shown = msg || notice;

  return (
    <div class="login-screen">
      <div class="login-bg" />
      <div class="login-vignette" />

      <Panel variant="gold" corners class="login-card">
        <div class="login-crest">
          <Icon icon="ui_logo" label="世界之王" size="xl" />
        </div>
        <h1 class="login-title">世界之王</h1>
        <p class="login-tagline">罗马 · 高卢 · 条顿 —— 在同一张地图上称雄</p>

        <section class="server-pick" aria-labelledby="server-pick-title">
          <div class="field-label" id="server-pick-title">选择服务器</div>
          <div class="server-grid">
            {SERVERS.map((server) => {
              const selected = server.id === currentServerId;
              return (
                <a
                  key={server.id}
                  class={`server-card server-card--${server.id}${selected ? ' picked' : ''}`}
                  href={serverUrl(server.port)}
                  aria-current={selected ? 'page' : undefined}
                  onClick={(event) => { if (selected) event.preventDefault(); }}
                >
                  <span class="server-card-status">{selected ? '当前' : '前往'}</span>
                  <b>{server.name}</b>
                  <small>{server.description}</small>
                </a>
              );
            })}
          </div>
        </section>

        <div class="login-tabs" role="tablist">
          <button role="tab" aria-selected={mode === 'login'} class={mode === 'login' ? 'on' : ''} onClick={() => { setMode('login'); setMsg(''); }}>登录</button>
          <button role="tab" aria-selected={mode === 'register'} class={mode === 'register' ? 'on' : ''} onClick={() => { setMode('register'); setMsg(''); }}>注册</button>
        </div>

        <div class="login-fields">
          <input
            type="text" placeholder="用户名（≤16 字）" maxLength={16}
            value={name} autocomplete="username"
            onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
          />
          <input
            type="password" placeholder="密码（≥4 位）"
            value={pwd} autocomplete={mode === 'register' ? 'new-password' : 'current-password'}
            onInput={(e) => setPwd((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => { if ((e as KeyboardEvent).key === 'Enter') void submit(); }}
          />
        </div>

        {mode === 'register' && (
          <div class="tribe-pick">
            <div class="field-label">选择部族<small>（决定兵种与风格，创建后不可更改）</small></div>
            <div class="tribe-grid">
              {TRIBES.map((t) => {
                const art = TRIBE_ART[t.key];
                return (
                  <button
                    key={t.key}
                    class={`tribe-card${tribe === t.key ? ' picked' : ''}`}
                    onClick={() => setTribe(t.key)}
                    aria-pressed={tribe === t.key}
                  >
                    <Icon icon={art?.icon} label={t.name} size="lg" />
                    <b>{t.name}</b>
                    <small>{t.desc}</small>
                    <span class="tribe-traits">{art?.traits.map((x) => <i key={x}>{x}</i>)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <Btn variant="primary" size="lg" block disabled={busy || booting} onClick={submit}>
          {booting ? '连接服务器中…' : busy ? '请稍候…' : mode === 'register' ? '注册并进入' : '进入世界'}
        </Btn>

        {shown && <div class={`login-msg${msg ? ' bad' : ''}`}>{shown}</div>}
      </Panel>
    </div>
  );
}
