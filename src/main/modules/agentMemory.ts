import type { GenerationTask } from "../../shared/types";

/**
 * 智能体历史感知：从既有任务记录提炼用户的常用偏好，注入 agent 的系统提示词。
 * 零新增持久化——数据源就是 orchestrator 已在内存里的任务列表。
 *
 * 只提炼"可复用的创作偏好"（时长/数量/后端/主题词），不搬运任务内容本身：
 * 系统提示词每轮都发，必须短；任务描述属于用户数据，不该常驻提示词。
 */
export function buildAgentMemoryHint(tasks: GenerationTask[]): string {
  const real = tasks.filter((t) => t.status !== "draft" && t.prompt?.trim());
  if (real.length < 3) return ""; // 样本太少不提炼，避免把偶然当习惯

  const lines: string[] = [];
  const topMode = (values: Array<string | undefined>, unit: string) => {
    const counts = new Map<string, number>();
    for (const value of values) {
      // **空串必须跳过**，不能当成一个取值参与统计。
      // `String(t.request?.duration ?? "")` 会给"没有这个字段"的任务塞一个 `""`，
      // 而它与真实值平票时，Map 里**先插入**的那个胜出——于是缺字段的任务排在前面时，
      // `best` 拿到空串、`best ? …` 判假，整条「常用时长 / 常用数量」提示**静默消失**。
      // 实测（probe-memory2）：同样的 4 条任务，只是缺字段的排在前后不同，
      // 提示就时有时无。用户看不到任何线索说"你的习惯没被采用"。
      if (value == null || value === "") continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    // 平票时按字典序定序：`sort` 对平票元素保留插入顺序，结果会随任务顺序变化，
    // 同一批任务在列表重排后给出的"习惯"会莫名其妙地换一个。
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const [best, n] = ranked[0] ?? [];
    return best ? `（${n}/${real.length} 条任务为 ${best}${unit}）` : "";
  };

  // 用 `Number.isFinite` 而不是 `?? ""`：字段可能是 `undefined`、也可能是脏数据。
  // 缺字段时必须传 `undefined`（而不是空串），交给 topMode 跳过。
  const durations = real.map((t) => (Number.isFinite(t.request?.duration) ? String(t.request!.duration) : undefined));
  const durationHint = topMode(durations, " 秒");
  if (durationHint) lines.push(`常用时长${durationHint}`);

  const counts = real.map((t) => (Number.isFinite(t.request?.count) ? String(t.request!.count) : undefined));
  const countHint = topMode(counts, " 路");
  if (countHint) lines.push(`常用数量${countHint}`);

  const backends = real.map((t) => t.backend);
  const backendHint = topMode(backends, "");
  if (backendHint) lines.push(`常用后端${backendHint}`);

  // 主题词：高频二词组合（朴素 bigram，够用且零依赖）。
  const stop = new Set(["的", "了", "在", "是", "一", "个", "镜头", "画面", "缓慢", "逐渐", "视频", "生成", "风格", "高清"]);
  const bigrams = new Map<string, number>();
  for (const task of real.slice(0, 60)) {
    const words = task.prompt.replace(/[，。！？、\s]+/g, " ").split(" ").filter((w) => w.length >= 2 && w.length <= 6 && !stop.has(w));
    for (let i = 0; i < words.length - 1; i++) {
      const key = `${words[i]}${words[i + 1]}`;
      bigrams.set(key, (bigrams.get(key) ?? 0) + 1);
    }
  }
  const themes = [...bigrams.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w);
  if (themes.length > 0) lines.push(`常见主题：${themes.join("、")}`);

  if (lines.length === 0) return "";
  return `\n\n（参考：用户历史使用习惯——${lines.join("；")}。用户未明确指定时可按习惯给默认值，但用户明确说了的参数永远优先。）`;
}
