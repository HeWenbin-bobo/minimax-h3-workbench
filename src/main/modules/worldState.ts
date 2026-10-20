import type { ChatMessage } from "../../shared/types";

/**
 * 世界状态注入（移植 OpenAI Codex `core/src/context/world_state/mod.rs` 的 section 模型）。
 *
 * 问题：有些事实每轮都成立（今天几号、能不能联网、能产出什么文件），但它们**会变**
 * （用户关掉了联网、跨天了、上下文快满了），模型必须拿到**当前**事实才不犯错。
 *
 * **两个移植时踩到的坑（都已修正，读代码看不出来、实测才现形）**：
 *
 * 1. **载体必须是"对话片段"，不能是 system prompt**。真实 key A/B 实测（probe-time-channel /
 *    probe-time-fullprompt）：环境事实拼进 system prompt 时，模型会**直接无视**——问"今天几号"，
 *    它答"我无法得知今天的日期"，哪怕日期就写在 system 里。测过的 6 种 system 通道
 *    （末尾追加 / 开头 / 第二条 system 消息 / developer 角色）**全部失败**；
 *    而作为 **user 消息片段**注入则 100% 生效（4 种位置均通过）。Codex 正是把 world state
 *    作为**对话片段**注入的。故 `injectWorldState` 把事实拼成一条 user 消息附在历史末尾。
 *
 * 2. **每个 section 每轮都必须出现**。因为片段拼在**每轮重建**的请求里（历史尾部的 user 消息
 *    是每轮临时拼的，不落盘），"没变就不发"会让模型从第 2 轮起再也看不到任何环境事实。
 *    所以 `diffWorldState` 每轮渲染全部 section；差异只用于**节流正文刷新**。
 */

export type SectionId = "current_time" | "network_access" | "artifacts" | "video_backends" | "context_budget";

/** section 的中文名。注入文本是给模型读的中文事实，不能把内部 id 直接拼进去。 */
const SECTION_LABELS: Record<SectionId, string> = {
  current_time: "当前时间",
  network_access: "联网状态",
  artifacts: "产物能力",
  video_backends: "视频生成后端",
  context_budget: "上下文余量"
};

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
   * 本会话**已经产出**的文件名（含扩展名）。
   *
   * 为什么要注入：渲染端传给模型的 history 只有 `{ role, content }`，**工具结果不跨轮保留**。
   * 不给清单的话，用户第二轮说"把刚才那个页面改一下"，模型只能猜文件名——
   * 猜错就报"找不到产物"或重复生成一份。这是本轮多个"名字解析"补丁的共同根因。
   * 只放文件名（不放路径），上限 20 条，避免把世界状态撑大。
   */
  artifactFiles?: string[];
  /**
   * 剩余上下文预算（对齐 Codex `TokenBudgetRemainingContext` / `ContextWindowTokenStatus`）。
   * 缺省表示拿不到可信数字——此时**不注入**该 section，而不是注入"未知"。
   *
   * 为什么值得告诉模型：长任务里模型不知道自己快没空间了，会持续展开新工作，
   * 结果被压缩/截断打断在半路。提前告知剩余量，它才会主动收尾。
   */
  contextBudget?: { remainingTokens: number; modelLimitTokens: number };
  /**
   * 本轮**真的可用**的视频生成后端（已配好凭据的那些）。
   *
   * 为什么必须给模型看：`generate_video` 现在要求先问用户"用哪个后端"，
   * 而模型看不到「连接设置」——不告诉它，它会把没配密钥的选项摆给用户，选了必然失败。
   * 空数组 = 一个都没有（此时应让用户先去配置，而不是硬生成）。
   * 计划模式下不注入（本轮不产视频）。
   */
  videoBackends?: Array<{ kind: string; label: string; note?: string }>;
  /** 注入时刻。测试注入固定值，避免断言随真实时间漂移。 */
  now?: Date;
}

/**
 * ISO 风格时间戳 → 中文可读时刻（含星期）。模型对绝对日期才有用，故不带时区缩写歧义。
 *
 * **必须显式换算到 UTC+8，不能用 `date.getHours()`**：后者取的是**本机时区**，
 * 而文案固定写「北京时间」。本机不在 UTC+8 时（海外用户、改过系统时区、
 * CI/容器里 UTC），模型会拿到错的时间却被告知这是北京时间——
 * 它据此回答"最新/今年/上个月"这类问题，一错就是一整天。
 * 用 `getTime() + 8h` 再读 UTC 字段，得到与宿主时区无关的固定结果。
 */
function formatClock(date: Date): string {
  const beijing = new Date(date.getTime() + 8 * 60 * 60 * 1_000);
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][beijing.getUTCDay()];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${beijing.getUTCFullYear()}年${beijing.getUTCMonth() + 1}月${beijing.getUTCDate()}日 ${weekday} ${pad(beijing.getUTCHours())}:${pad(beijing.getUTCMinutes())}`;
}

/** 从渲染文本里取出日期部分（"2026年3月14日"）。用于判断是否跨天。 */
function datePartOf(rendered: string): string {
  return /(\d{4}年\d{1,2}月\d{1,2}日)/.exec(rendered)?.[1] ?? rendered.slice(0, 12);
}

/**
 * 从渲染文本里取出**完整时刻**（北京时间，UTC+8），用于算出"这次注入已经过去多久"。
 *
 * 格式固定由 `formatClock` 产生：`2026年10月18日 周日 09:00（北京时间）…`。
 * 解析失败返回 undefined（调用方按"该刷新"处理，宁可多注入一次）。
 */
function clockOf(rendered: string): Date | undefined {
  const match = /(\d{4})年(\d{1,2})月(\d{1,2})日\s*周[一二三四五六日]\s*(\d{1,2}):(\d{2})/.exec(rendered);
  if (!match) return undefined;
  const [, year, month, day, hour, minute] = match;
  // 文案固定写"北京时间"，与 formatClock 一样按 UTC+8 反解（不能按本机时区）。
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 8, Number(minute));
  return new Date(utc);
}

/**
 * 时间正文多久必须刷新一次。
 *
 * 早先的节流规则是"**跨天**才刷新"，理由是"分钟级变化每轮都触发，等于节流形同虚设"。
 * 但那条规则带来一个更糟的后果：同一会话里过了六个小时，模型仍被告知"现在是 09:00"
 * （实测 probe-time-stale：09:00 首次注入 → 15:30 第二轮拿到的还是 09:00）。
 * 用户问"现在几点""离八点还有多久"会得到**确定性的错答案**，
 * 而且这个错误随会话时长累积、越聊越离谱。
 *
 * 取 15 分钟：相比"每轮都变"（几秒一次）已足够节流，又保证模型看到的时间
 * 最多落后一刻钟——对"现在几点/今天还剩多久"这类问题足够准。
 * 对齐 Codex `time_reminder.rs` 的做法（按时间阈值重注入，而不是按天）。
 */
const TIME_REINJECT_AFTER_MS = 15 * 60 * 1_000;

/**
 * 当前时间。模型不知道今天是哪天——问"最新的 iPhone 是哪款"时它会凭训练截止日臆造，
 * 报出一个几年前的型号（Codex 为此专门做了 time_reminder 通道）。
 */
function timeSection(now: Date): WorldSection {
  return {
    id: "current_time",
    render: () => `# 当前时间\n${formatClock(now)}（北京时间）。涉及"最新/今年/上个月"的时效问题请以此为准。`,
    // 节流规则：**跨天必刷新；同一天内超过 15 分钟也要刷新**。
    //
    // 注意：节流只决定正文要不要刷新，**不决定要不要出现**（每轮都必须在场，见文件头）。
    shouldReinject: (previous, next) => {
      if (datePartOf(previous) !== datePartOf(next)) return true;
      const previousClock = clockOf(previous);
      const nextClock = clockOf(next);
      // 任一侧解析不出来 → 当作需要刷新（宁可多发一次，也不要让时间永久停在旧值）。
      if (!previousClock || !nextClock) return true;
      return nextClock.getTime() - previousClock.getTime() >= TIME_REINJECT_AFTER_MS;
    }
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

/**
 * 可用的视频生成后端（对齐「先问用户用哪个方式生成」这条要求）。
 *
 * 为什么必须注入：模型现在要在调用 `generate_video` 之前先问用户"用哪个后端"，
 * 而它**看不到**「连接设置」——不知道哪些后端配好了凭据。
 * 不告诉它，它会把没配密钥的云端选项摆给用户选，用户选完必然失败
 * （"未保存瞬映卡密"/"请先保存 API Key"），白走一轮还显得软件很傻。
 */
function videoBackendsSection(input: WorldStateInput): WorldSection {
  const backends = input.videoBackends ?? [];
  const body = backends.length === 0
    ? `**现在没有任何可用的视频生成后端**。不要调用 generate_video；请先告诉用户去「连接设置」配置（本机 ComfyUI 地址、SSH 主机，或保存云端密钥/卡密）。`
    : `可用（调用 generate_video 前先问用户选哪个）：
${backends.map((entry) => `- \`${entry.kind}\`：${entry.label}${entry.note ? ` — ${entry.note}` : ""}`).join("\n")}
${
  backends.length === 1
    ? `\n**只有一个可用**：不用给用户列选项，一句话说明"这轮只能走${backends[0].label}"即可，然后问时长与数量。`
    : `\n**用户没指定时不要自己挑**——不同后端的花费差别很大（本机不额外计费；云 API 按秒扣费；RB 扣卡密次数）。`
}`;
  return {
    id: "video_backends",
    render: () => `# 视频生成后端\n${body}`
  };
}

function artifactsSection(input: WorldStateInput): WorldSection {
  const kinds = input.artifactKinds.length > 0
    ? `可用类型：${input.artifactKinds.join(" / ")}。`
    : `**本轮不可用**（当前为计划模式：只出方案、不产出文件）。`;
  // **必须列出本会话已产出的文件名**（实测缺口）：传给模型的 history 只有
  // `{ role, content }`（见 shared/types.ts 的 ChatMessage）——**工具结果不跨轮保留**。
  // 用户第二轮说"把刚才那个页面改一下"时，模型手里没有任何文件名，只能猜；
  // 猜错就报"找不到产物"，或者重新 create_file 生成一份重复的。
  // 这一轮为它加的那些"名字回落 / 无扩展名补全"都是在给这个缺口打补丁；
  // 直接把清单摆在环境事实里，模型就不用猜了。
  const files = (input.artifactFiles ?? []).slice(0, 20);
  const fileList = files.length > 0
    ? `\n本会话已产出的文件：${files.join("、")}（用 read_artifact / edit_artifact / inspect_artifact 时直接引用这些名字）。`
    : "";
  return {
    id: "artifacts",
    render: () => `# 产物能力\n${kinds}${fileList}`
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
  // 后端清单插在**产物能力之后、上下文余量之前**：它和"能产出什么"同属能力事实，
  // 而余量是每轮都会变的数字，放最后更不扰动前缀。
  // 只在本轮真的可能生成视频时出现（计划模式不产视频，问了也没用）。
  if (input.videoBackends) sections.push(videoBackendsSection(input));
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
  // 文案用**中文小节名**而不是内部 id：这段是给模型读的中文环境事实，
  // 冒出 `current_time` / `context_budget` 这类标识符既是噪声，也和其余中文文案不一致。
  if (previous) {
    for (const entry of previous) {
      if (sections.some((section) => section.id === entry.id)) continue;
      blocks.push(`（「${SECTION_LABELS[entry.id] ?? "该说明"}」已不再适用，先前关于它的内容作废）`);
    }
  }

  return { text: blocks.join("\n\n"), snapshot };
}

/**
 * 把环境事实注入待发送历史。
 *
 * **必须作为一条 user 消息**（不能拼进 system prompt）——真实 key A/B 实测：拼进 system 时
 * 模型直接无视（问日期答"我无法得知"，哪怕日期就在 system 里）；作为 user 片段则每次都生效。
 * 见文件头注释。
 *
 * 位置：追加在末尾。实测 user 通道的多种位置（末条之前 / 末条之后 / 独立一条）都生效，
 * 取"追加到末尾"最简单，且天然是"最新的环境事实"，不会被后续对话覆盖成旧值。
 *
 * @param messages 待发送历史（不改原数组）
 * @param worldStateText `diffWorldState().text`。空串时原样返回，不产生多余消息。
 */
export function injectWorldState(messages: ChatMessage[], worldStateText: string): ChatMessage[] {
  if (!worldStateText.trim()) return messages;
  return [...messages, { role: "user", content: worldStateText }];
}
