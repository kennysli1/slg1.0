/** 属性格：图标 + 名称 + 数值。兵种/建筑详情统一用它，避免各页自己拼小字行。 */
import type { ComponentChildren } from 'preact';
import { Icon } from './Icon.js';

export function StatGrid({ children }: { children: ComponentChildren }) {
  return <div class="stats">{children}</div>;
}

export function Stat({ icon, label, value, title }: {
  icon?: string;
  label: string;
  value: ComponentChildren;
  title?: string;
}) {
  return (
    <div class="stat" title={title ?? label}>
      {icon && <Icon icon={icon} label={label} size="xs" />}
      <div>
        <div class="stat-label">{label}</div>
        <div class="stat-value">{value}</div>
      </div>
    </div>
  );
}
