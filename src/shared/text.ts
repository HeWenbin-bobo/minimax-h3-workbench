/**
 * 按"字符数"截断字符串，但**不切断 UTF-16 代理对**。
 *
 * 为什么需要：JS 的 `String#slice` 以 UTF-16 码元为单位。emoji（😀）、部分生僻汉字
 * 与符号占**两个**码元，切点落在中间会留下一个孤立代理项——渲染出来是 `�`。
 * 实测：`"😀😀😀".slice(0, 3)` → `"😀�"`。
 *
 * 这些截断点分散在会话标题、任务标签、工具摘要、压缩摘要与附件正文里；
 * 前几处只是界面难看，**压缩摘要与附件正文会被发回模型**，
 * 孤立代理项还会让模型读到坏字符。
 *
 * 只调整切点，不用 `Array.from` 拆数组——后者对 10 万字符的附件会多分配一整份。
 */
export function sliceSafe(text: string, max: number): string {
  if (max <= 0) return "";
  if (!text || text.length <= max) return text;
  // 切点前一个码元若是高代理项，说明正好落在代理对中间：退一位。
  const code = text.charCodeAt(max - 1);
  const cut = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return text.slice(0, cut);
}
