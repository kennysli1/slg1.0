/** Art icon with an intentional decorative mode and a text fallback for missing art. */
import { useState } from 'preact/hooks';

export type IconSize = '2xs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
const px: Record<IconSize, number> = { '2xs': 14, xs: 18, sm: 26, md: 44, lg: 68, xl: 96, '2xl': 132 };
export function artPath(base: string): string { return `/art/${base}.webp`; }

interface IconProps { icon?: string | null; label: string; size?: IconSize; fallbackIcon?: string; class?: string; title?: string; /** Set for imagery repeated next to visible text. */ decorative?: boolean; }

export function Icon({ icon, label, size = 'md', fallbackIcon, class: className = '', title, decorative = false }: IconProps) {
  const [stage, setStage] = useState<0 | 1 | 2>(0);
  const sizePx = px[size];
  const src = stage === 0 ? icon : stage === 1 ? fallbackIcon : null;
  const accessibleTitle = decorative ? undefined : title ?? label;
  if (!icon || !src) return <span class={`icon-fallback icon-${size} ${className}`} style={{ width: sizePx, height: sizePx }} role={decorative ? undefined : 'img'} aria-label={decorative ? undefined : label} aria-hidden={decorative || undefined} title={accessibleTitle}>{decorative ? null : label.slice(0, 4)}</span>;
  return <img class={`icon icon-${size} ${className}`} src={artPath(src)} alt={decorative ? '' : label} aria-hidden={decorative || undefined} title={accessibleTitle} width={sizePx} height={sizePx} loading="lazy" decoding="async" draggable={false} onError={() => setStage((current) => current === 0 && fallbackIcon ? 1 : 2)} />;
}

interface PlateProps extends IconProps { plate?: 'stone' | 'bare' | 'gold' | 'round'; lvl?: number | null; maxed?: boolean; }
export function IconPlate({ plate = 'stone', lvl, maxed, ...rest }: PlateProps) {
  const modifier = plate === 'bare' ? ' iconplate--bare' : plate === 'gold' ? ' iconplate--gold' : plate === 'round' ? ' iconplate--round' : '';
  return <span class={`iconplate${modifier}`}><Icon {...rest} />{lvl != null && <span class={`lvl iconplate-lvl${maxed ? ' lvl--max' : ''}`}>Lv{lvl}</span>}</span>;
}
