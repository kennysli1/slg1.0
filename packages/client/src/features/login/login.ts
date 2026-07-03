/** 登录/注册界面。 */
import { art } from '../../shared/ui/widgets.js';
import { errText, TRIBES } from '../../shared/ui/text.js';
import { login, register } from '../../api.js';

let loginMode: 'login' | 'register' = 'register';
let pickedTribe = 'romans';

/** 渲染登录页。onSuccess 在登录/注册成功后调用（进入游戏）。 */
export function renderLogin(app: HTMLElement, onSuccess: () => void, msg = '') {
  const tribeBtns = TRIBES.map((t) =>
    `<button class="tribe ${pickedTribe === t.key ? 'picked' : ''}" data-tribe="${t.key}">
      <b>${t.name}</b><small>${t.desc}</small></button>`).join('');
  app.innerHTML = `
    <div class="login">
      <div class="login-logo">${art('ui_logo', 'King of World', 'lg')}</div>
      <h1>世界之王</h1>
      <p class="login-sub">罗马·高卢·条顿 — 在同一张地图上称雄</p>
      <div class="logintabs">
        <button class="${loginMode === 'register' ? 'on' : ''}" id="toReg">注册</button>
        <button class="${loginMode === 'login' ? 'on' : ''}" id="toLogin">登录</button>
      </div>
      <input id="name" placeholder="用户名（≤16字）" maxlength="16" />
      <input id="pwd" type="password" placeholder="密码（≥4位）" />
      ${loginMode === 'register' ? `<div class="field-label">选择部族</div><div class="tribes">${tribeBtns}</div>` : ''}
      <button id="goBtn" class="btn-primary">${loginMode === 'register' ? '注册并进入' : '登录'}</button>
      <div class="loginmsg">${msg}</div>
    </div>`;

  const rerender = (m = '') => renderLogin(app, onSuccess, m);
  document.getElementById('toReg')!.onclick = () => { loginMode = 'register'; rerender(); };
  document.getElementById('toLogin')!.onclick = () => { loginMode = 'login'; rerender(); };
  document.querySelectorAll<HTMLButtonElement>('[data-tribe]').forEach((b) =>
    b.onclick = () => { pickedTribe = b.dataset.tribe!; rerender(); });

  const go = async () => {
    const name = (document.getElementById('name') as HTMLInputElement).value.trim();
    const pwd = (document.getElementById('pwd') as HTMLInputElement).value;
    if (!name || !pwd) return rerender('请输入用户名和密码');
    const res = loginMode === 'register' ? await register(name, pwd, pickedTribe) : await login(name, pwd);
    if (res.ok) onSuccess();
    else rerender(errText(res.error));
  };
  document.getElementById('goBtn')!.onclick = go;
  document.getElementById('pwd')!.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') go(); });
}
