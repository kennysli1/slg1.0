/** HTML-safe 转义工具：防 XSS 注入，在动态 innerHTML 拼接前调用。纯函数，无浏览器依赖。 */

/**
 * 将任意值转义为 HTML 安全字符串，适用于 textContent 以外的 innerHTML 插值位置。
 * 处理五种字符：& < > " '
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 属性值转义（HTML 属性双引号内使用），与 escapeHtml 等价。 */
export function escapeAttr(value: unknown): string {
  return escapeHtml(value);
}
