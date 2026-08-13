/** Keep the whole modal layer above sticky app chrome; nested dialogs rise as a unit. */
export function modalLayerZ(index: number): string {
  return `calc(var(--z-scrim) + ${Math.max(0, index) * 20})`;
}
