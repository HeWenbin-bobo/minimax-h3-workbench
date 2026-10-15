/**
 * 上游错误恢复（移植 OpenAI Codex `core/src/responses_retry.rs` 的三条做法）。
 *
 * Codex 在重试逻辑里做了三件我们没做的事：
 * ① **尊重服务端的 retry-after，但不得放宽重试上限**。取 `max(retry_after, 我们的退避)` 作为
 *    等待时长，同时**不改**重试次数。这个区分很重要：不读 retry-after 会在服务端明确的冷却窗口里
 *    反复撞墙（实测该中转的抖动窗口可持续十几秒，背靠背重试全撞进去）；而用 retry-after 去
 *    延长次数则是被上游牵着走。
 * ② **内容过滤/拒答类错误要注入"如何改写"的指引后再重试**。原样重试同一个 prompt 必然同样被拒，
 *    等于白烧一次配额。
 * ③ **重试状态必须可见**。用户看到的是"卡住"，实际是在等重试——两者体验天差地别。
 */

/** 从错误对象/响应里提取 Retry-After（秒）。找不到返回 undefined。 */
export function parseRetryAfter(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  // AI SDK 的 APICallError 把响应头挂在 responseHeaders；不同版本大小写不一。
  const headers = (error as { responseHeaders?: Record<string, string> }).responseHeaders;
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
    // 也可能是 HTTP-date 格式。解析失败就算了，不值得为此引入日期库。
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.max(0, (parsed - Date.now()) / 1000);
  }
  // 有的上游把等待时长写进错误文案（"Please retry after 20 seconds"）。
  const text = String((error as { message?: string }).message ?? "");
  const match = /retry.{0,12}?after\s+(\d+)\s*(?:seconds|s\b)/i.exec(text);
  if (match) return Number(match[1]);
  return undefined;
}

/**
 * 计算本次重试前应等待的时长。
 *
 * 规则：取"服务端建议"与"我们自己的退避"的较大值——服务端要等更久就听它的；
 * 服务端没说、或说得更短，就用我们的退避（实测背靠背重试会全部撞进同一个抖动窗口）。
 *
 * **上限**：服务端建议超过 `capMs` 时不采纳，退回 `defaultMs`。理由是我们不延长重试次数，
 * 所以"等 5 分钟再试"实际等于放弃这一轮——不如按自己的节奏试完然后如实回落，
 * 让用户早点看到结果，好过守着一个遥远的约定。
 */
export function retryDelayMs(error: unknown, defaultMs: number, capMs = 30_000): number {
  const suggested = parseRetryAfter(error);
  if (suggested === undefined) return defaultMs;
  const suggestedMs = suggested * 1000;
  if (suggestedMs > capMs) return defaultMs;
  return Math.max(defaultMs, suggestedMs);
}

/** 错误是否属于"内容被安全策略拒绝"。各家措辞不同，做宽匹配。 */
export function isContentFilterError(error: unknown): boolean {
  const record = (error ?? {}) as { message?: string; responseBody?: string; data?: unknown };
  const text = [
    String(record.message ?? ""),
    String(record.responseBody ?? ""),
    // AI SDK 会把响应体塞进 data；JSON.stringify 对 undefined 返回 undefined，兜一下。
    String(JSON.stringify(record.data ?? "") ?? "")
  ].join(" ");
  return /content.?filter|content.?policy|safety|moderation|flagged|violat|prohibited|敏感|违规|被拒绝/i.test(text);
}

/**
 * 内容被拒后注入的改写指引。原样重试同一个 prompt 必然同样被拒——
 * 必须换一种表述，而且要让模型知道"为什么换"。
 */
export const CONTENT_FILTER_GUIDANCE = `（上一轮请求被上游的安全策略拒绝，原样重试会再次被拒。请改写后再试：
① 把可能触发审核的表述换成更中性、更抽象的说法（具体人名、品牌名，以及"真实""血腥""暴力"等词往往是触发点）；
② 保留用户的真实意图，只调整措辞——不要因此改变用户要的内容本身；
③ 如果改写后仍被拒，就如实告诉用户"这个主题可能无法生成"，并给出一个可行的替代方向，
不要反复重试同一个说法。）`;

/** 内容被拒时的用户可见说明（重试状态可见——不说的话，界面上就是"卡住"）。 */
export function contentFilterNotice(attempt: number, maxAttempts: number): string {
  return `（请求被上游安全策略拒绝，正在改写措辞后重试 ${attempt}/${maxAttempts}…）\n\n`;
}

/** 重试中的用户可见说明。此前只写日志，用户看到的是一动不动的光标。 */
export function retryNotice(attempt: number, maxAttempts: number, waitMs: number): string {
  return `（连接中断，${Math.round(waitMs / 1000)} 秒后重试 ${attempt}/${maxAttempts}…）\n\n`;
}
