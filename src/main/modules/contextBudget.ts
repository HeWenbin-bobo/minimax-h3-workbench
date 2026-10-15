/**
 * 上下文预算记账：移植 OpenAI Codex `AutoCompactWindow` 的核心思路。
 *
 * Codex 解决的问题：压缩后上下文被重置，token 用量掉一截再重新长起来。若阈值一直是
 * "占满 X% 就压"，压缩完可能立刻又逼近阈值——因为分不清"这些 token 是压缩前的祖先历史"
 * 还是"本窗口新长出来的"。
 *
 * 解法（Codex 的 BodyAfterPrefix 模式）：每压一次开一个新窗口，记一个基线
 * prefill_input_tokens（压缩后首次请求的输入 token 数），之后只有"超出基线的增量"
 * 才计入限额。系统提示词与首轮上下文不反复占用预算。
 */

/** 单个会话的上下文窗口状态。windowNumber 用于 UI 展示"已压缩 N 次"。 */
export interface ContextWindowState {
  windowNumber: number;
  /**
   * 基线：当前窗口的输入 token 起点。对齐 Codex 的 prefill_input_tokens。
   * 首个服务端 usage 到达后锁定，之后估算不再覆盖（Codex 同名语义）。
   */
  baselineInputTokens?: number;
  /** 基线来源。server 锁定后估算不可覆盖；estimated 之间可互相刷新。 */
  baselineSource: "server" | "estimated" | "none";
  /** 上游明确报过上下文超窗：模型表窗口估小了，下一轮无条件压缩。 */
  forceCompact?: boolean;
}

export function createContextWindowState(): ContextWindowState {
  return { windowNumber: 0, baselineSource: "none" };
}

/**
 * 估算文本 token 数。中文约 1.6 字符/token，英文约 4 字符/token——
 * 按字符类型分别计，比一律除以 4 准（中文会被严重低估）。
 * 只用于"拿不到服务端 usage"时的回落，不追求精确。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[㐀-鿿　-〿＀-￯]/g) || []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk / 1.6 + rest / 4);
}

/** 消息列表的估算总量（含角色开销的粗算，每条消息 +4 token）。 */
export function estimateMessagesTokens(messages: Array<{ content: string }>): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0);
}

/**
 * 上一次服务端样本：服务端回报的输入 token 数，以及当时的消息条数。
 * 编排层记录，用于把后续新增的消息量叠加到真实基线上。
 */
export interface ContextSample {
  serverInputTokens: number;
  messageCount: number;
}

/**
 * 当前活动上下文的 token 数。移植 Codex `get_total_token_usage` 的思路
 * （history.rs:939-956）：以**服务端实测值为锚**，再加"采样之后新增的消息"的估算量。
 *
 * 这样做的理由：纯估算在中文/代码混合时误差可达数倍，而服务端每次都给真实数字。
 * 但服务端数字只覆盖它看到的那一轮，新加的消息得自己估。
 *
 * 回落链：无样本 / 消息变少（用户删了会话内容）→ 全量估算。
 */
export function activeContextTokens(
  messages: Array<{ content: string }>,
  sample?: ContextSample
): number {
  if (!sample || messages.length < sample.messageCount) return estimateMessagesTokens(messages);
  const added = estimateMessagesTokens(messages.slice(sample.messageCount));
  return sample.serverInputTokens + added;
}

/**
 * 当前窗口的增长量（BodyAfterPrefix 语义）：只算基线之后的增量。
 * 无基线时退回总量——等价于 Codex 的 `window.prefill_input_tokens.unwrap_or(active_context_tokens)`。
 */
export function growthTokens(activeInputTokens: number, state: ContextWindowState): number {
  const baseline = state.baselineInputTokens ?? activeInputTokens;
  return Math.max(0, activeInputTokens - baseline);
}

/**
 * 计入限额的 token 量。移植 Codex 的 `AutoCompactTokenLimitScope` 双模式
 * （protocol/src/config_types.rs:49-55，其中 `Total` 是 `#[default]`）：
 *
 * - **首个窗口（windowNumber === 0，还没压过）→ Total**：整段历史都算。这是默认模式，
 *   也是"历史一开始就很大"能被拦住的唯一路径。
 * - **压缩过的窗口 → BodyAfterPrefix**：只算基线之后的增量，避免压缩完立刻又触发（抖动）。
 *
 * 漏掉 Total 会让"从未压缩过 + 历史已超窗口"的会话永远不触发——
 * 因为基线默认等于当前量、增长恒为 0（实测探针抓到的就是这个 bug）。
 */
export function scopeTokens(activeInputTokens: number, state: ContextWindowState): number {
  return state.windowNumber === 0 ? activeInputTokens : growthTokens(activeInputTokens, state);
}

/**
 * 记录基线。服务端 usage 优先：一旦被服务端值锁定，后续估算不得覆盖
 * （Codex 的单测 `tracks_prefill_and_window_boundaries` 正是断言这一点）。
 * 估算值之间允许互相刷新——Codex 的 set_estimated_prefill 只对 ServerObserved 早退。
 */
export function recordBaseline(
  state: ContextWindowState,
  inputTokens: number,
  source: "server" | "estimated"
): ContextWindowState {
  if (state.baselineSource === "server") return state;
  return { ...state, baselineInputTokens: Math.max(0, inputTokens), baselineSource: source };
}

/**
 * 开新窗口：窗口号 +1。
 *
 * 注意与 Codex 的差异：Codex 的 `advance()`（auto_compact_window.rs:77-85）**不清 prefill**，
 * 而是等下一个服务端样本经 ensure_server_observed_prefill_from_usage 覆盖。
 * 我们这里显式清空——因为没有消息复用的保底路径，清空后由下一轮估算/usage 立即重建，
 * 语义等价且状态更可预测（避免拿着上一窗口的陈旧基线算新窗口的增长）。
 */
export function advanceWindow(state: ContextWindowState): ContextWindowState {
  return { ...state, windowNumber: state.windowNumber + 1, baselineInputTokens: undefined, baselineSource: "none", forceCompact: false };
}

/** 上游报上下文超窗（Codex 的 ContextWindowExceeded）：置位后下一轮无条件压缩。
 *  这是模型表窗口估小了时的唯一补救路径——本地算不出真实窗口，只能等上游拒绝。 */
export function markWindowExceeded(state: ContextWindowState): ContextWindowState {
  return { ...state, forceCompact: true };
}

/** 上游错误文案里是否在报"上下文超窗"。各家措辞不同，做宽匹配但排除限流/鉴权类错误。 */
export function looksLikeContextOverflow(message: string): boolean {
  const text = String(message || "").toLowerCase();
  if (/rate.?limit|quota|invalid.?api.?key|unauthorized|401|403/.test(text)) return false;
  return /context.?(length|window)|too.?(long|many tokens)|maximum.?(context|token)|exceeded.{0,20}(context|token)|token.{0,20}(limit|exceeded)|上下文.{0,6}(超|过|长)|超出.{0,6}(上下文|token)/.test(text);
}

export interface CompactDecision {
  compact: boolean;
  reason: "scope" | "hard-window" | "none";
  /** 当前增长占限额的百分比，供 UI 展示（超 100 表示已越界）。 */
  percent: number;
}

/**
 * 双阈值判定，对齐 Codex `context_window_token_status`（context_window.rs:96-117）：
 * ① 增长量触达"压缩限额"（模型窗口 × 百分比）+ buffer → scope
 * ② 总量触达模型硬窗口 → hard-window（必须压，否则请求会被上游拒绝）
 *
 * 与 Codex 的差异：Codex 用 fallback_buffer_tokens 预留"模型自觉收尾"的空间，
 * 我们没有 fallback prompt 机制，故 buffer 默认为 0（保留参数以备后续接入）。
 */
export function shouldCompact(params: {
  activeInputTokens: number;
  state: ContextWindowState;
  modelLimitTokens: number;
  compactAtPercent?: number;
  bufferTokens?: number;
}): CompactDecision {
  const { activeInputTokens, state, modelLimitTokens } = params;
  const compactAtPercent = params.compactAtPercent ?? 80;
  const bufferTokens = params.bufferTokens ?? 0;

  // 上游已经明确报过超窗：不再相信本地估算，无条件压缩（最优先）。
  if (state.forceCompact) return { compact: true, reason: "hard-window", percent: 100 };

  if (modelLimitTokens <= 0) return { compact: false, reason: "none", percent: 0 };

  const scoped = scopeTokens(activeInputTokens, state);
  const scopeLimit = Math.floor((modelLimitTokens * compactAtPercent) / 100);
  const bufferedLimit = scopeLimit + bufferTokens;
  const percent = scopeLimit > 0 ? Math.round((scoped / scopeLimit) * 100) : 0;

  // 硬窗口优先：即便计入量还小，总量越界也必须压。
  if (activeInputTokens >= modelLimitTokens) return { compact: true, reason: "hard-window", percent };
  if (scoped >= bufferedLimit) return { compact: true, reason: "scope", percent };
  return { compact: false, reason: "none", percent };
}