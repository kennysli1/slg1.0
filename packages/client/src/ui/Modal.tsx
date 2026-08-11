/**
 * 弹层：桌面居中对话框、手机贴底抽屉（同一组件，靠 CSS 切换）。
 * 用 store 的 modals 信号做栈，任何地方都能 openModal(...) 打开，不必层层传 props。
 */
import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { modals, closeModal, toasts } from '../app/store.js';

interface ModalProps {
  title: ComponentChildren;
  sub?: ComponentChildren;
  /** 标题左侧的图标节点（通常是 <IconPlate>） */
  icon?: ComponentChildren;
  onClose: () => void;
  children: ComponentChildren;
  /** 底部固定操作区 */
  foot?: ComponentChildren;
  wide?: boolean;
}

export function Modal({ title, sub, icon, onClose, children, foot, wide }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div class="scrim" onClick={onClose} />
      <div class={`panel panel--gold modal${wide ? ' modal--wide' : ''}`} role="dialog" aria-modal="true">
        <div class="modal-head">
          {icon}
          <div>
            <div class="modal-title">{title}</div>
            {sub != null && <div class="modal-sub">{sub}</div>}
          </div>
          <button class="modal-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div class="modal-body">{children}</div>
        {foot != null && <div class="modal-foot">{foot}</div>}
      </div>
    </>
  );
}

/** 弹层宿主：挂在 App 根部，渲染整个弹层栈。 */
export function ModalHost() {
  const list = modals.value;
  if (!list.length) return null;
  return <>{list.map((m) => <div key={m.id}>{m.render(() => closeModal(m.id))}</div>)}</>;
}

/** Toast 宿主。 */
export function ToastHost() {
  const list = toasts.value;
  if (!list.length) return null;
  return (
    <div class="toast-host" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} class={`toast${t.kind === 'bad' ? ' toast--bad' : t.kind === 'ok' ? ' toast--ok' : ''}`}>
          {t.msg}
        </div>
      ))}
    </div>
  );
}
