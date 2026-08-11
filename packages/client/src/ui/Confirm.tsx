/**
 * 危险操作二次确认。设计系统规定：拆除/解散/放弃这类不可逆操作一律用它，
 * **禁止 window.confirm**（原生弹窗会打断沉浸感，且样式无法统一）。
 *
 * 用法：
 * ```ts
 * if (!await confirmDanger({ title: '拆除学院', body: '…后果说明…' })) return;
 * ```
 */
import { openModal, closeModal } from '../app/store.js';
import { Modal } from './Modal.js';
import { Btn } from './Btn.js';
import type { ComponentChildren } from 'preact';

export interface ConfirmOptions {
  title: string;
  /** 说清后果——玩家该知道自己在放弃什么 */
  body: ComponentChildren;
  confirmText?: string;
  cancelText?: string;
}

export function confirmDanger(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean, close: () => void) => {
      if (settled) return;
      settled = true;
      resolve(v);
      close();
    };

    openModal((close) => (
      <Modal
        title={opts.title}
        onClose={() => done(false, close)}
        foot={<>
          <Btn onClick={() => done(false, close)}>{opts.cancelText ?? '取消'}</Btn>
          <Btn variant="danger" onClick={() => done(true, close)}>{opts.confirmText ?? '确认'}</Btn>
        </>}
      >
        <p class="confirm-body">{opts.body}</p>
      </Modal>
    ));
  });
}

/** 供无法拿到 close 回调的场景手动收尾（一般用不到）。 */
export { closeModal as closeConfirm };
