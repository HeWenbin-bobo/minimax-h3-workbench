import type { PromptFragment } from "../../shared/agentPrompt";

/**
 * 世界状态注入（移植 OpenAI Codex `core/src/context/world_state/mod.rs` 的 section 模型）。
 *
 * 问题：有些事实每轮都成立（今天几号、能不能联网、能产出什么文件），但它们**会变**
 * （用户关掉了联网、跨天了、上下文快满了），模型必须拿到**当前**事实才不犯错。
 *
 * **关键差异（这是移植时踩到的坑，已修正）**：Codex 的 world state 片段是追加进
 * **持久历史**的——历史会累积，所以"没变就不发"能省 token，且旧片段仍在历史里可见。
 * 但本应用的载体是**每轮由 buildSystemPrompt 重新拼的 system prompt**：上一轮的正文不会保留。
 * 若沿用 Codex 的"没变就不发"，模型从第 2 轮起就再也看不到任何环境事实
 * （实测请求体捕获到：第 1 轮 system 含全部标记，第 2 轮一个都没有）。
 *
 * 所以这里的规则是：**每个 section 每轮都必须渲染进 system prompt**。
 * 节流（`shouldReinject`）只决定"正文要不要刷新"，不决定"要不要出现"：
 * 被节流时沿用上一轮的正文（保持 system 前缀稳定、利于上游前缀缓存），到该刷新时再换新值。
 */

export type SectionId = "current_time" | "network_access" | "artifacts" | "context_budget";

export interface WorldSection {
  id: SectionId;
  /** 注入给模型的正文（自带 `# 标题` 小节头）。 */
  render: () => string;
  /**
   * 内容变了也未必值得立刻刷新正文（节流）。返回 false 表示"这次变化先不刷新，沿用旧正文"
   * （对齐 Codex `time_reminder.rs` 的 `next_reinject_after`）。**注意：只影响正文是否刷新，
   * 不影响该 section 是否出现——每个 section 每轮都必须在场（载体是每轮重建的 system prompt）。**
   */
  shouldReinject?: (previous: string, next: string) => boolean;
}

export interface SectionSnapshot {
  id: SectionId;
  /** 上次注入的正文。与当前 render() 不同即视为变化。 */
  content: string;
}

/** 每个会话一份快照。主进程内存态：重启后丢基线，下一轮一律按新正文渲染（最多多花一次 token）。 */
export type WorldStateSnapshot = SectionSnapshot[];

export interface WorldStateInput {
  /**
   * 本轮真实生效的联网开关。**必须传真实值**——开关关掉了却在提示词里说"你可以联网"，
   * 模型会去调一个已被摘掉的工具，然后为"我调不了工具"道歉（CLAUDE.md 记过同类事故）。
   */
  webSearch: boolean;
  browserSearch: boolean;
  /** 是否配置了搜索 API。仅影响措辞：免 key 抓取要提前告知稳定性更差。 */
  searchApiReady: boolean;
  /** 产物能力：本轮可用的 kind 列表。计划模式下 create_file/generate_video 被摘掉，这里要如实反映。 */
  artifactKinds: string[];
  /**
   * 剩余上下文预算（对齐 Codex `TokenBudgetRemainingContext` / `ContextWindowTokenStatus`）。
   * 缺省表示拿不到可信数字——此时**不注入**该 section，而不是注入"未知"。
   *
   * 为什么值得告诉模型：长任务里模型不知道自己快没空间了，会持续展开新工作，
   * 结果被压缩/截断打断在半路。提前告知剩余量，它才会主动收尾。
   */
  contextBudget?: { remainingTokens: number; modelLimitTokens: number };
  /** 注入时刻。测试注入固定值，避免断言随真实时间漂移。 */
  now?: Date;
}

/** ISO 风格时间戳 → 中文可读时刻（含星期）。模型对绝对日期才有用，故不带时区缩写歧义。 */
function formatClock(date: Date): string {
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${weekday} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 从渲染文本里取出日期部分（"2026年3月14日"）。用于判断是否跨天。 */
function datePartOf(rendered: string): string {
  return /(\d{4}年\d{1,2}月\d{1,2}日)/.exec(rendered)?.[1] ?? rendered.slice(0, 12);
}

/**
 * 当前时间。模型不知道今天是哪天——问"最新的 iPhone 是哪款"时它会凭训练截止日臆造，
 * 报出一个几年前的型号（Codex 为此专门做了 time_reminder 通道）。
 */
function timeSection(now: Date): WorldSection {
  return {
    id: "current_time",
    render: () => `# 当前时间\n${formatClock(now)}（北京时间）。涉及"最新/今年/上个月"的时效问题请以此为准。`,
    // 节流规则：**跨天必刷新正文，同一天内沿用旧正文**。
    //
    // 对齐 Codex `time_reminder.rs` 的 `next_reinject_after`——它按时间阈值重注入。
    // 注意：节流只决定正文要不要刷新，**不决定要不要出现**（每轮都必须在场，见文件头）。
    // 只比日期不比分钟：分钟级变化每轮都会触发，等于把节流形同虚设。
    shouldReinject: (previous, next) => datePartOf(previous) !== datePartOf(next)
  };
}

function networkSection(input: WorldStateInput): WorldSection {
  const modes: string[] = [];
  if (input.browserSearch) modes.push("浏览器渲染（应用自带 Chromium 真实打开搜索页，结果最稳）");
  if (input.webSearch) modes.push(input.searchApiReady ? "搜索 API" : "免 key 抓取 Bing/搜狗（未配置搜索 API，稳定性一般）");
  const body = modes.length > 0
    ? `可用。当前走：${modes.join("；")}。凡涉及实时信息（价格、新闻、版本号、时效事实）都必须先搜索核实，不要凭记忆作答。`
    : `**本轮不可用**（用户关闭了「联网」与「浏览器搜索」）。不要调用 web_search；涉及实时信息时如实说明你无法联网核实，不要凭记忆编造具体数字或日期。`;
  return {
    id: "network_access",
    render: () => `# 联网状态\n${body}`
  };
}

function artifactsSection(input: WorldStateInput): WorldSection {
  const body = input.artifactKinds.length > 0
    ? `可用类型：${input.artifactKinds.join(" / ")}。`
    : `**本轮不可用**（当前为计划模式：只出方案、不产出文件）。`;
  return {
    id: "artifacts",
    render: () => `# 产物能力\n${body}`
  };
}

/**
 * 剩余上下文预算（对齐 Codex `TokenBudgetRemainingContext`）。
 *
 * 为什么值得注入：长任务里模型不知道自己快没空间了，会持续展开新工作，
 * 然后被压缩/截断打断在半路——用户看到的是"做一半停了"。提前告知剩余量，
 * 模型才会主动收尾（先交付已完成的、把大任务拆小）。
 *
 * 节流（关键，否则每轮正文都变、扰动 system 前缀）：只在**跨过档位**时刷新正文。
 * 按剩余百分比分档：充裕 / 偏紧 / 紧张 / 告急。同档内沿用旧正文（但 section 仍在场）。
 */
function contextBudgetSection(input: WorldStateInput): WorldSection {
  const budget = input.contextBudget;
  return {
    id: "context_budget",
    render: () => {
      if (!budget || budget.modelLimitTokens <= 0) return "";
      const remaining = Math.max(0, budget.remainingTokens);
      const percent = Math.round((remaining / budget.modelLimitTokens) * 100);
      // 措辞按紧张程度递进：越少越明确要求收尾。
      const advice = percent <= 10
        ? "空间告急：**立刻收尾**——把已经完成的部分交付掉（该出文件就出文件），不要再展开新工作，并如实告诉用户还有哪些没做完。"
        : percent <= 25
          ? "空间偏紧：优先把当前这件事做完并交付，不要再开始新的大任务。"
          : percent <= 50
            ? "空间尚可：正常推进，但避免一次规划过多步骤。"
            : "空间充裕：正常推进。";
      return `# 上下文余量\n本窗口剩余约 ${percent}%（约 ${remaining} token，窗口上限 ${budget.modelLimitTokens}）。${advice}`;
    },
    // 只在**跨档**时重注入：同档内的数字波动不值得每轮打扰模型。
    shouldReinject: (previous, next) => budgetTier(previous) !== budgetTier(next)
  };
}

/**
 * 把渲染文本映射到"建议档位"（0=充裕 1=尚可 2=偏紧 3=告急）。
 *
 * 注意必须比档位、不能比原始百分比：42% → 38% 若按数字比就是"变了"，
 * 于是每轮都重注入，节流形同虚设（初版就是这个错）。
 * 边界与 advice 的 50/25/10 保持一致，保证"档位没变 ⇒ 建议措辞也没变"。
 */
function budgetTier(rendered: string): number {
  const match = /剩余约\s*(\d+)%/.exec(rendered);
  if (!match) return -1; // 取不到（空串/格式变了）→ 视为变化，宁可多发一次
  const percent = Number(match[1]);
  if (percent <= 10) return 3;
  if (percent <= 25) return 2;
  if (percent <= 50) return 1;
  return 0;
}

/**
 * 本轮候选 section 集合。顺序即注入顺序（时间在前：它是后续判断的坐标系）。
 * 导出便于测试直接断言单个 section 的正文。
 *
 * 余量 section 仅在拿得到可信数字时才加入——拿不到就不注入，不写"未知"（那是噪声）。
 */
export function buildSections(input: WorldStateInput): WorldSection[] {
  const sections = [timeSection(input.now ?? new Date()), networkSection(input), artifactsSection(input)];
  if (input.contextBudget && input.contextBudget.modelLimitTokens > 0) sections.push(contextBudgetSection(input));
  return sections;
}

export interface WorldStateDiff {
  /** 本轮的**完整**环境事实块（每个 section 都在），直接拼进 system prompt。 */
  text: string;
  /** 本轮结束后的快照，调用方负责存回。 */
  snapshot: WorldStateSnapshot;
}

/**
 * 渲染本轮要注入 system prompt 的完整环境事实块。
 *
 * 与 Codex 的关键差异（务必记住）：Codex 把片段追加进**持久历史**，故"没变就不发"安全；
 * 我们的载体是**每轮重建的 system prompt**，不发就等于永久丢失。所以这里**每个 section 每轮都渲染**，
 * 差异只体现在"正文要不要刷新"上：
 * - 首次 / 变化且未被节流 → 用新正文
 * - 变化但被节流（时间同天、余量同档）→ 沿用上一轮正文，保持 system 前缀稳定（利于上游前缀缓存）
 *
 * @param previous 上一轮快照。undefined 表示进程内无基线（重启/首轮），此时一律用新正文。
 */
export function diffWorldState(
  sections: WorldSection[],
  previous: WorldStateSnapshot | undefined
): WorldStateDiff {
  const blocks: string[] = [];
  const snapshot: WorldStateSnapshot = [];

  for (const section of sections) {
    const content = section.render();
    const prior = previous?.find((entry) => entry.id === section.id);
    // 节流：变了但声明"先别刷新"（时间同天 / 余量同档）→ 沿用旧正文。
    // 沿用而非跳过：正文必须在场，只是保持稳定，避免每轮扰动 system 前缀。
    if (prior && prior.content !== content && section.shouldReinject && !section.shouldReinject(prior.content, content)) {
      snapshot.push({ id: section.id, content: prior.content });
      blocks.push(prior.content);
      continue;
    }
    snapshot.push({ id: section.id, content });
    blocks.push(content);
  }

  // 消失的 section：上一轮有、这一轮不在候选集里。显式作废，避免模型凭上一轮印象继续用。
  if (previous) {
    for (const entry of previous) {
      if (sections.some((section) => section.id === entry.id)) continue;
      blocks.push(`（${entry.id} 已不再适用，先前关于它的说明作废）`);
    }
  }

  return { text: blocks.join("\n\n"), snapshot };
}
