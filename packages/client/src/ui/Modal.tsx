/** 无障碍弹层：限制焦点、关闭后恢复焦点，并安全处理多层弹窗。 */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { modals, closeModal, toasts } from '../app/store.js';
import { modalLayerZ } from './modal-layer.js';

interface ModalProps {
  title: ComponentChildren;
  sub?: ComponentChildren;
  icon?: ComponentChildren;
  onClose: () => void;
  children: ComponentChildren;
  foot?: ComponentChildren;
  wide?: boolean;
}
const focusable = 'a[href], area[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let modalSequence = 0;
const mountedModals: number[] = [];

export function Modal({ title, sub, icon, onClose, children, foot, wide }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const modalId = useRef(++modalSequence);
  const titleId = `modal-title-${modalId.current}`;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    mountedModals.push(modalId.current);
    const dialog = dialogRef.current;
    const focusInitial = () => (dialog?.querySelector<HTMLElement>('[data-modal-initial-focus]') ?? dialog?.querySelector<HTMLElement>('.modal-close') ?? dialog)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (mountedModals.at(-1) !== modalId.current) return;
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab' || !dialog) return;
      const targets = [...dialog.querySelectorAll<HTMLElement>(focusable)].filter((target) => !target.hasAttribute('disabled'));
      if (!targets.length) { event.preventDefault(); dialog.focus(); return; }
      const first = targets[0]; const last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.body.classList.add('modal-open');
    const frame = window.requestAnimationFrame(focusInitial);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKeyDown);
      const index = mountedModals.lastIndexOf(modalId.current);
      if (index >= 0) mountedModals.splice(index, 1);
      if (!mountedModals.length) document.body.classList.remove('modal-open');
      previous?.focus();
    };
  }, [onClose]);
  return (
    <>
      <div class="scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        class={`panel panel--gold modal${wide ? ' modal--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div class="modal-head">
          {icon && <span aria-hidden="true">{icon}</span>}
          <div>
            <div class="modal-title" id={titleId}>{title}</div>
            {sub != null && <div class="modal-sub">{sub}</div>}
          </div>
          <button type="button" class="modal-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div class="modal-body">{children}</div>
        {foot != null && <div class="modal-foot">{foot}</div>}
      </div>
    </>
  );
}

export function ModalHost() {
  const list = modals.value;
  if (!list.length) return null;
  return (
    <>
      {list.map((modal, index) => (
        <div
          key={modal.id}
          class="modal-layer"
          style={{
            zIndex: modalLayerZ(index),
            '--modal-scrim-z': `calc(var(--z-scrim) + ${index * 20})`,
            '--modal-dialog-z': `calc(var(--z-modal) + ${index * 20})`,
          }}
        >
          {modal.render(() => closeModal(modal.id))}
        </div>
      ))}
    </>
  );
}

export function ToastHost() {
  const list = toasts.value;
  if (!list.length) return null;
  return (
    <div class="toast-host" aria-live="polite" aria-atomic="true">
      {list.map((toast) => (
        <div
          key={toast.id}
          class={`toast${toast.kind === 'bad' ? ' toast--bad' : toast.kind === 'ok' ? ' toast--ok' : ''}`}
        >
          {toast.msg}
        </div>
      ))}
    </div>
  );
}
