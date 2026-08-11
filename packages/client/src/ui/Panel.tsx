/** 面板与段落标题：暗石面 + 鎏金描边，可选四角浮雕装饰。 */
import type { ComponentChildren, JSX } from 'preact';

interface PanelProps extends Omit<JSX.IntrinsicElements['div'], 'class'> {
  children: ComponentChildren;
  /** flat=浅阴影，sunken=内凹，gold=鎏金强调，danger=危险 */
  variant?: 'default' | 'flat' | 'sunken' | 'gold' | 'danger';
  /** 是否画四角浮雕（重点面板才用，用多了会吵） */
  corners?: boolean;
  /** 是否自带内边距 */
  pad?: boolean;
  class?: string;
}

export function Panel({ children, variant = 'default', corners, pad, class: cls = '', ...rest }: PanelProps) {
  const mod = variant === 'default' ? '' : ` panel--${variant}`;
  return (
    <div class={`panel${mod}${pad ? ' panel-pad' : ''} ${cls}`} {...rest}>
      {corners && (
        <span class="frame-corners" aria-hidden="true">
          <i class="tl" /><i class="tr" /><i class="bl" /><i class="br" />
        </span>
      )}
      {children}
    </div>
  );
}

interface SectionHeadProps {
  children: ComponentChildren;
  sub?: ComponentChildren;
  actions?: ComponentChildren;
}

/** 段落标题：左侧鎏金竖条 + 副标题 + 右侧操作区。 */
export function SectionHead({ children, sub, actions }: SectionHeadProps) {
  return (
    <div class="section-head">
      <span>{children}</span>
      {sub != null && <small>{sub}</small>}
      {actions != null && <span class="head-actions">{actions}</span>}
    </div>
  );
}

export function Divider({ ornate }: { ornate?: boolean }) {
  return <div class={ornate ? 'divider' : 'divider divider--line'} aria-hidden="true" />;
}

/** 空态占位。 */
export function Empty({ icon, title, children }: { icon?: string; title: string; children?: ComponentChildren }) {
  return (
    <div class="empty">
      {icon && <div class="empty-icon">{icon}</div>}
      <h4>{title}</h4>
      {children && <p>{children}</p>}
    </div>
  );
}
