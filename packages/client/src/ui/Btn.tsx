/** 按钮：鎏金主按钮 / 石质次按钮 / 危险按钮。 */
import type { ComponentChildren, JSX } from 'preact';

interface BtnProps extends Omit<JSX.IntrinsicElements['button'], 'class' | 'size'> {
  children: ComponentChildren;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
  class?: string;
}

export function Btn({
  children, variant = 'default', size = 'md', block, class: cls = '', ...rest
}: BtnProps) {
  const v = variant === 'default' ? '' : ` btn--${variant}`;
  const s = size === 'md' ? '' : ` btn--${size}`;
  return (
    <button type="button" class={`btn${v}${s}${block ? ' btn--block' : ''} ${cls}`} {...rest}>
      {children}
    </button>
  );
}

export function Tag({ children, kind, title }: {
  children: ComponentChildren;
  kind?: 'gold' | 'jade' | 'ember' | 'crimson' | 'steel';
  title?: string;
}) {
  return <span class={`tag${kind ? ` tag--${kind}` : ''}`} title={title}>{children}</span>;
}
