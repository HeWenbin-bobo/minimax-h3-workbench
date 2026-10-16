/**
 * 上下文压缩：移植 OpenAI Codex 的 checkpoint 摘要机制。
 *
 * 两段提示词逐字取自 codex-rs/prompts/templates/compact/（Apache-2.0），
 * 未做改写——Codex 用它们跑生产，措辞是被验证过的。
 *
 * 保留策略对齐 codex-rs/core/src/compact.rs 的 build_compacted_history_with_limit：
 * 反向遍历用户消息、按 token 预算从最近往前保留、超预算截断而非丢弃、摘要置末。
 */

import type { ChatMessage } from "../../shared/types";
import { estimateTokens } from "./contextBudget";
import type { LlmServiceOptions } from "./llmService";
import { resolveChatPath } from "./llmService";

/** 摘要提示词。原文：codex-rs/prompts/templates/compact/prompt.md */
export const SUMMARIZATION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

/**
 * 摘要回注时前缀的固定话术。原文：codex-rs/prompts/templates/compact/summary_prefix.md
 * 作用：让接手模型知道"这是前任的交接摘要"，从而在其上继续而非重做。
 */
export const SUMMARY_PREFIX = `Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:`;

/** 摘要不可用时的占位。对齐 Codex 的 "(no summary available)"。 */
const NO_SUMMARY_PLACEHOLDER = "（无可用摘要：压缩时未能生成摘要，此前对话细节已丢失）";

/** 用户消息保留预算，对齐 Codex 的 COMPACT_USER_MESSAGE_MAX_TOKENS。 */
export const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;

/** 摘要内容是否为空（含只有前缀没正文的情况）。 */
export function isSummaryMessage(content: string): boolean {
  return content.startsWith(SUMMARY_PREFIX);
}

/**
 * 截断文本到大致 token 预算（按比例切字符）。
 * Codex 用 tokenizer 精确截断；我们不引入 tokenizer 依赖，按估算比例切。
 */
function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  const total = estimateTokens(text);
  if (total <= maxTokens) return text;
  const ratio = maxTokens / total;
  const cut = Math.max(1, Math.floor(text.length * ratio));
  return `${text.slice(0, cut)}…（已截断）`;
}

/**
 * 构造压缩后的消息列表。对齐 Codex `build_compacted_history_with_limit`：
 *
 * 1. **反向遍历**用户消息：优先保最近，预算耗尽即停（不再回填更老的）
 * 2. 超预算的单条**截断**而非丢弃——它仍带上下文
 * 3. **只保留真实用户消息**：助手回复与工具步骤全部丢弃（信息已进摘要）
 * 4. 摘要作为最后一条 `role: "user"` 消息追加，与 Codex 的 CompactionSummary 一致
 *    （Codex 也把摘要编码成 user 角色，markers 为空即无包装）
 */
export function buildCompactedHistory(
  messages: ChatMessage[],
  summary: string,
  maxUserTokens = COMPACT_USER_MESSAGE_MAX_TOKENS
): ChatMessage[] {
  // 排除既有摘要消息，避免"摘要的摘要"层层堆叠（对齐 Codex 的 is_summary_message 过滤）。
  const userMessages = messages.filter((message) => message.role === "user" && !isSummaryMessage(message.content));

  const selected: ChatMessage[] = [];
  let remaining = maxUserTokens;
  for (const message of [...userMessages].reverse()) {
    if (remaining <= 0) break;
    const tokens = estimateTokens(message.content);
    if (tokens <= remaining) {
      // 图片附件一并保留（Codex 在超预算时才丢非文本 part，预算内整体保留）。
      selected.push(message);
      remaining -= tokens;
      continue;
    }
    selected.push({ role: "user", content: truncateToTokens(message.content, remaining) });
    break; // 超预算即停，不再回填更老的
  }
  selected.reverse();

  const body = summary.trim() ? `${SUMMARY_PREFIX}\n\n${summary.trim()}` : NO_SUMMARY_PLACEHOLDER;
  return [...selected, { role: "user", content: body }];
}

/** 摘要请求超时。压缩本身可能很慢（要把整段历史读进去），给足 90 秒。 */
const SUMMARIZE_TIMEOUT_MS = 90_000;

/**
 * 调模型生成交接摘要。非流式——压缩是后台动作，不需要逐字展示。
 *
 * 与 Codex 的差异：Codex 把摘要提示词作为一条普通 user 消息追加进历史再发请求
 * （compact.rs:118-153），我们直接发「历史 + 提示词」的完整消息列表，语义等价。
 *
 * **任何失败都只返回空串**，由调用方走占位摘要——压缩失败绝不能阻断用户对话
 * （Codex 亦然：失败后保留已完成的轮次并继续）。
 */
export async function summarizeHistory(
  options: LlmServiceOptions,
  messages: ChatMessage[],
  signal?: AbortSignal
): Promise<string> {
  if (messages.length === 0) return "";
  try {
    const base = options.baseUrl.replace(/\/+$/, "");
    const response = await fetch(`${base}${resolveChatPath(base)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: options.model,
        messages: [...messages, { role: "user", content: SUMMARIZATION_PROMPT }],
        stream: false,
        // 输出上限必须自己设（CLAUDE.md 纪律）：不设就用上游默认（实测该中转约 4096 token），
        // 大上下文的交接摘要可能被静默截断——而截断的摘要 = 丢信息，且用户毫不知情。
        // 摘要本身不该很长，8000 足够容纳一份完整交接，又给足余量。
        max_tokens: 8_000
      }),
      signal: signal ?? AbortSignal.timeout(SUMMARIZE_TIMEOUT_MS)
    });
    if (!response.ok) return "";
    const payload = (await response.json().catch(() => ({}))) as {
      choices?: Array<{ message?: { content?: string } }>;
      content?: string;
    };
    const text = payload.choices?.[0]?.message?.content ?? payload.content ?? "";
    return typeof text === "string" ? text.trim() : "";
  } catch {
    return "";
  }
}
