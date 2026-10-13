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
      if (value == null) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const [best, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
    return best ? `（${n}/${real.length} 条任务为 ${best}${unit}）` : "";
  };

  const durations = real.map((t) => String(t.request?.duration ?? ""));
  const durationHint = topMode(durations, " 秒");
  if (durationHint) lines.push(`常用时长${durationHint}`);

  const counts = real.map((t) => String(t.request?.count ?? ""));
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
