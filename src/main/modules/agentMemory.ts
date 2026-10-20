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
  // **入参来自任务记录，类型没有保证**（实测：`backend` 是数字时直接抛
  // `a[0].localeCompare is not a function`，而本函数跑在"构建系统提示词"的热路径上——
  // 一个脏任务记录就能让**整轮对话**抛错）。这里统一收敛成字符串：
  // 非字符串先 `String()`，空串跳过；排序与展示都只处理字符串。
  const topMode = (values: Array<unknown>, unit: string) => {
    const counts = new Map<string, number>();
    for (const raw of values) {
      // **空串必须跳过**，不能当成一个取值参与统计。
      // `String(t.request?.duration ?? "")` 会给"没有这个字段"的任务塞一个 `""`，
      // 而它与真实值平票时，Map 里**先插入**的那个胜出——于是缺字段的任务排在前面时，
      // `best` 拿到空串、`best ? …` 判假，整条「常用时长 / 常用数量」提示**静默消失**。
      // 实测（probe-memory2）：同样的 4 条任务，只是缺字段的排在前后不同，
      // 提示就时有时无。用户看不到任何线索说"你的习惯没被采用"。
      if (raw == null) continue;
      const value = typeof raw === "string" ? raw : String(raw);
      if (!value) continue;
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
    // **英文标点也要当分隔符**（实测 2026-10-21）：`generate_video` 的工具描述写着
    // 「画面感强的英文 prompt 效果更好」，真实提示词大量是英文、用逗号分隔短语。
    // 旧正则只认中文标点与空白，`lake,` 于是成了 5 个字符的"词"（刚好通过长度过滤），
    // bigram 产出 `overlake,`、`moonlitlake,` 这类无意义串——而这段会被注入**每一轮**
    // 的系统提示词，一旦凑够 3 次重复就长期污染上下文。
    const words = task.prompt
      .replace(/[,，.。!！?？;；:：、"'“”‘’()（）[\]【】{}｛｝<>《》/\\|@#$%^&*+=~`]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2 && w.length <= 6 && !stop.has(w));
    for (let i = 0; i < words.length - 1; i += 1) {
      // 中文词组直接相连（「赛博朋克」+「城市」→「赛博朋克城市」读得通）；
      // 英文相邻词用空格还原（`fairy over` 比 `fairyover` 可读，也不会让模型
      // 把两个词当成一个生造词）。
      const ascii = /^[\x20-\x7e]+$/.test(words[i]) && /^[\x20-\x7e]+$/.test(words[i + 1]);
      const key = ascii ? `${words[i]} ${words[i + 1]}` : `${words[i]}${words[i + 1]}`;
      bigrams.set(key, (bigrams.get(key) ?? 0) + 1);
    }
  }
  const themes = [...bigrams.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w);
  if (themes.length > 0) lines.push(`常见主题：${themes.join("、")}`);

  if (lines.length === 0) return "";
  // **必须给"生成后端"单独开例外**（实测矛盾，2026-10-21）：
  // 这句"未明确指定时可按习惯给默认值"会与后端闸门直接打架——
  // 闸门要求"多个后端可用时必须先问用户"，而这里在鼓励它照习惯填。
  // 模型同时收到两条指令时行为不可预测（真机见过它照习惯直接用本机开跑）。
  // 时长/数量/主题按习惯取默认值没问题，**后端不行**：不同后端的花费差一个数量级。
  return `\n\n（参考：用户历史使用习惯——${lines.join("；")}。用户未明确指定时可按习惯给默认值，但用户明确说了的参数永远优先。**例外：用哪个后端生成必须问用户**——本机不额外计费、云端按秒计费、RB 扣卡密次数，花费差别很大，不能按习惯替他挑。）`;
}
