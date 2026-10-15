/**
 * 模型上下文窗口对照表。
 *
 * 用途：压缩触发判定需要知道"模型的硬窗口有多大"。上游不提供这个信息
 * （OpenAI 兼容的 /models 只给 id），故按模型名前缀查表，查不到取默认值。
 *
 * ⚠️ 表中的数值是**领域估计，非实测**。它们的唯一作用是把压缩阈值锚定在正确的数量级上，
 * 不用于任何精确计算。若某模型因此压缩过早/过晚，改这里即可。
 *
 * 保守取向：宁可估小不可估大——估大了压缩太晚，请求会被上游拒绝（用户看到报错）；
 * 估小了只是压缩偏早，代价仅是一次摘要开销。
 */

/** 查不到时的默认窗口，取主流国产模型的下限区间。 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** 前缀匹配表。取最长前缀命中，避免 glm-4.6 被 glm- 抢先匹配。 */
const WINDOW_TABLE: Array<{ prefix: string; window: number }> = [
  { prefix: "minimax", window: 192_000 },
  { prefix: "abab", window: 192_000 },
  { prefix: "glm-4.6", window: 200_000 },
  { prefix: "glm-", window: 128_000 },
  { prefix: "deepseek", window: 64_000 },
  { prefix: "qwen", window: 128_000 },
  { prefix: "kimi", window: 128_000 },
  { prefix: "claude", window: 200_000 },
  { prefix: "gpt-5", window: 400_000 },
  { prefix: "gpt-4", window: 128_000 }
];

/** 按模型名推断上下文窗口。大小写不敏感。 */
export function contextWindowFor(model: string): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  const lower = model.toLowerCase();
  let best: { prefix: string; window: number } | undefined;
  for (const entry of WINDOW_TABLE) {
    if (lower.startsWith(entry.prefix) && (!best || entry.prefix.length > best.prefix.length)) best = entry;
  }
  return best?.window ?? DEFAULT_CONTEXT_WINDOW;
}
