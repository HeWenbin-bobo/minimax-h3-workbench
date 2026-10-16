import type { PromptFragment } from "../../shared/agentPrompt";

/**
 * 世界状态**差异注入**（移植 OpenAI Codex `core/src/context/world_state/mod.rs`）。
 *
 * 问题：有些事实每轮都成立（今天几号、能不能联网、能产出什么文件），把它们塞进静态提示词
 * 会重复发送、浪费 token；但它们**会变**（用户关掉了联网、跨天了），不重注入模型就拿着过期事实做事。
 *
 * Codex 的解法是"只注入差异"：每个 section 渲染成两半——
 * 人类可读的 `render()`，以及用于在历史里反查该 section 是否已存在的标记 `marker`。
 * 每轮拿当前状态与快照比：
 * - 变了 → 注入新内容 + REPLACEMENT 提示（"以下取代先前的同一小节"）
 * - 消失 → 注入 REMOVAL 提示（"不再适用，不要再用"）
 * - 没变 → 什么都不发
 *
 * `PreviousSectionState::Unknown` 的处理：如果历史里能认出该 section 的标记，但进程内没有快照
 * （主进程重启过），**按"已存在"处理**。否则会把全部内容重发一遍，正是差异注入要避免的浪费。
 */

export type SectionId = "current_time" | "network_access" | "artifacts" | "context_budget";

export interface WorldSection {
  id: SectionId;
  /** 注入给模型的正文（不含包裹——包裹由 withFragment 负责）。 */
  render: () => string;
  /**
   * 该 section 在历史里出现时携带的标记（对齐 Codex `fragment.marker`）。
   * 与 render 分开：正文会随事实变化，标记必须稳定，否则下一轮反查找不到。
   */
  marker: string;
  /**
   * 内容变了也未必值得立刻重注入（节流）。返回 false 表示"这次变化先不发"
   * （对齐 Codex `time_reminder.rs` 的 `next_reinject_after`）。
   */
  shouldReinject?: (previous: string, next: string) => boolean;
}

export interface SectionSnapshot {
  id: SectionId;
  /** 上次注入的正文。与当前 render() 不同即视为变化。 */
  content: string;
}

/** 每个会话一份快照。主进程内存态：重启后丢基线，退化为"按历史标记判断"（安全降级，只多花一次 token）。 */
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
    marker: "# 当前时间",
    render: () => `# 当前时间\n${formatClock(now)}（北京时间）。涉及"最新/今年/上个月"的时效问题请以此为准。`,
    // 节流规则：**跨天必重注入，同一天内不重注入**。
    //
    // 对齐 Codex `time_reminder.rs` 的 `next_reinject_after`——它按时间阈值重注入，
    // 而不是"注入一次后永不再发"。此前写成恒 false 是个真 bug：会话跨过午夜后，
    // 模型会一直拿着昨天的日期，而提示词还明确告诉它"时效问题以此为准"——
    // 比不给时间更糟（给了错的时间还让它相信）。
    //
    // 只比日期不比分钟：分钟级变化每轮都会触发，等于把差异注入退化回"每轮全发"。
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
    marker: "# 联网状态",
    render: () => `# 联网状态\n${body}`
  };
}

function artifactsSection(input: WorldStateInput): WorldSection {
  const body = input.artifactKinds.length > 0
    ? `可用类型：${input.artifactKinds.join(" / ")}。`
    : `**本轮不可用**（当前为计划模式：只出方案、不产出文件）。`;
  return {
    id: "artifacts",
    marker: "# 产物能力",
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
 * 节流（关键，否则每轮都变、每轮都注入）：只在**跨过档位**时重注入。
 * 按剩余百分比分档：充裕 / 偏紧 / 紧张 / 告急。同档内变化不打扰模型。
 */
function contextBudgetSection(input: WorldStateInput): WorldSection {
  const budget = input.contextBudget;
  return {
    id: "context_budget",
    marker: "# 上下文余量",
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

/** 用标记包裹正文。标记必须与 `WorldSection.marker` 一致，否则下一轮反查不到。 */
export function withFragment(section: WorldSection): string {
  return `${section.marker}\n${section.render()}`;
}

export interface WorldStateDiff {
  /** 要追加到 system prompt 的增量块。无变化时为空串。 */
  text: string;
  /** 本轮结束后的快照，调用方负责存回。 */
  snapshot: WorldStateSnapshot;
}

/**
 * 计算本轮要注入的增量。
 *
 * @param previous 上一个快照。undefined 表示进程内没有基线（重启后）。
 * @param historyText 历史消息拼接文本，用于无快照时反查 section 是否已出现过
 *                    （对齐 Codex 的 `PreviousSectionState::Unknown`）。
 */
export function diffWorldState(
  sections: WorldSection[],
  previous: WorldStateSnapshot | undefined,
  historyText: string
): WorldStateDiff {
  const notices: string[] = [];
  const snapshot: WorldStateSnapshot = [];

  for (const section of sections) {
    const content = section.render();
    snapshot.push({ id: section.id, content });

    const prior = previous?.find((entry) => entry.id === section.id);

    if (prior) {
      if (prior.content === content) continue; // 没变：不发（差异注入的全部意义）
      // 变了，但该 section 声明了不重注入（如时间节流）：保留旧内容当基线，不打扰模型。
      if (section.shouldReinject && !section.shouldReinject(prior.content, content)) {
        snapshot[snapshot.length - 1] = { id: section.id, content: prior.content };
        continue;
      }
      // 变了 → 替换通知。Codex 用显式的 REPLACEMENT 措辞，否则模型会把新旧两份都当真。
      notices.push(`（${section.marker}已变化，以下内容取代此前的同一小节）\n${withFragment(section)}`);
      continue;
    }

    // 无快照：进程重启过。若历史里已能认出该标记，按"已存在"处理——当作基线已发送过，本轮不重发。
    if (historyText.includes(section.marker)) continue;
    notices.push(withFragment(section));
  }

  // 消失的 section：上一轮有、这一轮不在候选集里。
  if (previous) {
    for (const entry of previous) {
      if (sections.some((section) => section.id === entry.id)) continue;
      notices.push(`（${entry.id} 已不再适用，先前关于它的说明作废）`);
    }
  }

  return { text: notices.join("\n\n"), snapshot };
}

/** 历史消息拼成反查文本。两侧都查：交接摘要（role=user）也可能带着上一窗口的标记。 */
export function historyTextOf(messages: Array<{ role: string; content: string }>): string {
  return messages.map((message) => message.content ?? "").join("\n");
}
