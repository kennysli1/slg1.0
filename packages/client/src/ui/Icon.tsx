/**
 * 美术图标。约定：配置只给「基名」，这里拼成 /art/<基名>.png。
 * 加载失败自动退化为文字徽标，保证美术未就位时也不出破图。
 */
import { useState } from 'preact/hooks';

export type IconSize = '2xs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';

const PX: Record<IconSize, number> = {
  '2xs': 14, xs: 18, sm: 26, md: 44, lg: 68, xl: 96, '2xl': 132,
};

/** 美术资源统一走 WebP（同画质比 PNG 小 4~6 倍）。只有 PWA 图标另存 PNG。 */
export function artPath(base: string): string { return `/art/${base}.webp`; }

interface IconProps {
  icon?: string | null;
  label: string;
  size?: IconSize;
  /** 首选图缺失时的备用基名（如高卢兵种回退罗马美术）。 */
  fallbackIcon?: string;
  class?: string;
  title?: string;
}

export function Icon({ icon, label, size = 'md', fallbackIcon, class: cls = '', title }: IconProps) {
  const [stage, setStage] = useState<0 | 1 | 2>(0);
  const px = PX[size];

  const src = stage === 0 ? icon : stage === 1 ? fallbackIcon : null;
  if (!icon || src == null) {
    return (
      <span
        class={`icon-fallback icon-${size} ${cls}`}
        style={{ width: px, height: px }}
        title={title ?? label}
      >{label.slice(0, 4)}</span>
    );
  }

  return (
    <img
      class={`icon icon-${size} ${cls}`}
      src={artPath(src)}
      alt={label}
      title={title}
      width={px}
      height={px}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setStage((s) => (s === 0 && fallbackIcon ? 1 : 2))}
    />
  );
}

interface PlateProps extends IconProps {
  /** 底座样式：石板（默认）/ 无底座 / 鎏金描边 / 圆形 */
  plate?: 'stone' | 'bare' | 'gold' | 'round';
  /** 右上角等级徽章 */
  lvl?: number | null;
  maxed?: boolean;
}

/** 带凹陷石板底座的图标（建筑/兵种/宝物统一用它，观感成套）。 */
export function IconPlate({ plate = 'stone', lvl, maxed, ...rest }: PlateProps) {
  const mod = plate === 'bare' ? ' iconplate--bare'
    : plate === 'gold' ? ' iconplate--gold'
      : plate === 'round' ? ' iconplate--round' : '';
  return (
    <span class={`iconplate${mod}`}>
      <Icon {...rest} />
      {lvl != null && <span class={`lvl iconplate-lvl${maxed ? ' lvl--max' : ''}`}>Lv{lvl}</span>}
    </span>
  );
}
