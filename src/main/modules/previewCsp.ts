/**
 * 产物预览的**独立 CSP**（注入到 served HTML 里）。
 *
 * 背景（实测确认）：产物预览此前走 `srcDoc`，而 srcdoc iframe 会**继承宿主 CSP**
 * （宿主是 `script-src 'self'`，无 `unsafe-inline`）→ 预览页的内联 `<script>` 被拦掉，
 * 游戏/小工具脚本根本不运行。改为 `h3preview:` 协议按 URL 加载后，预览页**用自己的策略**、
 * 不继承宿主——但"没有策略"意味着脚本能跑的同时也能任意外发网络。
 *
 * 这里补上那一层：内联脚本照常跑（否则游戏动不了），但**网络出口一律封死**。
 *
 * 对齐 Codex 的"证据分级"原则：工具产出/网页正文一律当**不可信内容**处理——
 * 产物 HTML 由模型生成，不应拥有把用户数据发出去的能力。
 *
 * 取舍（有意为之）：
 * - `script-src 'unsafe-inline'` 而非 nonce：产物是任意生成内容，加 nonce 要重写每个
 *   `<script>` 标签（脆弱且需 HTML 解析）。该策略只作用在 sandbox 不透明源的 iframe 内，
 *   拿不到宿主 DOM 与 window.h3.* 的 IPC 面，`unsafe-inline` 的代价被这个边界兜住。
 * - `default-src 'none'` + 逐项放行本地来源：比"只拦 connect-src"更严——只拦 connect 的话，
 *   `<img src="https://…">` 这类信标仍能把数据带出去。
 * - 已知上限：`worker-src` 未放行（blob worker 会被拦）；`localStorage` 在不透明源下本就不可用。
 *   这两条是本就如此，不是本次收紧引入的。
 */

/** 预览内容的策略。逐项显式列出，不用通配。 */
export const PREVIEW_CSP = [
  // 默认全禁，再逐项放行——比"默认放行 + 拦几项"安全得多（漏一项就是一条出口）。
  "default-src 'none'",
  // 脚本只能内联（游戏/小工具都是单文件），不能加载任何外部脚本。
  "script-src 'unsafe-inline'",
  // 样式同理：产物里大量内联 style 与 <style>。
  "style-src 'unsafe-inline'",
  // 图片/音视频只允许内嵌数据与内存对象（canvas 导出、生成音频），不允许外部 URL。
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  // 网络出口全封：fetch / XHR / WebSocket / EventSource 一律拒绝。
  "connect-src 'none'",
  // 表单外发与 <base> 改写：同样封死（二者都是常被忽略的出口）。
  "form-action 'none'",
  "base-uri 'none'"
].join("; ");

/**
 * 把预览 CSP 注入产物 HTML。
 *
 * 注入点尽量靠前——meta CSP 只对**其后**解析的内容生效，放在结尾等于没放。
 */
export function injectPreviewCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;
  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + meta + html.slice(at);
  }
  // 没有 <head> 但有 <html>：插在 <html> 之后，浏览器会把它收进隐式 head。
  const root = /<html[^>]*>/i.exec(html);
  if (root) {
    const at = root.index + root[0].length;
    return html.slice(0, at) + meta + html.slice(at);
  }
  // 连根标签都没有（模型只给了片段）：直接前置，仍早于任何内容被解析。
  return meta + html;
}
