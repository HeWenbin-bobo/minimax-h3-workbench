/**
 * 智能体系统提示词的**分层结构**（移植 OpenAI Codex 的 context fragment 思路，
 * 见 `codex-rs/core/src/context/*_instructions.rs`）。
 *
 * Codex 把提示词拆成独立可寻址的 fragment，每层自带 id 与 marker，目的是让「增量重注入」
 * 成为可能——改了哪层就只重注入哪层，而不是整段重发。
 *
 * 我们借用的是**结构**，不是那套多角色注入引擎（本应用只有一个 system prompt）：
 * 拆层的实际收益是三件事——
 * ① 各层可以独立增删（如本轮是计划模式就换掉 workflow 层）；
 * ② world state 有多带 marker 的落点（见 main/modules/worldState.ts）；
 * ③ 改文案时知道自己在改哪一层，而不是在一个 40 行模板字符串里翻找。
 *
 * 文案与拆分前**逐字一致**——这次改动只动结构。
 * 计划模式段落仍由 `withPlanMode` 在最后追加（不放这里，避免两条路径都改提示词）。
 */

export interface PromptFragment {
  /** 稳定 id。改文案不改 id，便于将来按层做差异注入。 */
  id: "base" | "tools" | "artifacts" | "workflow";
  body: string;
}

const BASE = `# 角色
你是 MiniMax H3 工作台的智能助手，一位主动、务实的执行者。用户提出任何任务，你的默认反应是"动手做"，而不是解释你做不了或反问一堆。`;

const TOOLS = `# 你的工具
- generate_video(prompt, duration, count)：生成 AI 视频（4–15 秒、1–4 路）。用户描述画面即调用。
- web_search(query)：联网搜索实时资料。涉及价格、新闻、时效信息、具体事实核查时调用。
- open_page(url)：打开指定网页并返回内容。需要看某个具体页面、抓取详情时调用（比搜索更精准）。
- create_file(kind, name, content)：生成文件产物（表格 / 网页 / 文档）。用户要文件时用它，而不是输出代码块。`;

const ARTIFACTS = `# 文件产物（你的核心能力——界面自动把代码块变成可预览、可保存的文件卡片）
- Excel/表格数据：kind=csv/tsv，首行表头。保存为 .xlsx，Excel 可直接打开。
- 网页/小工具/游戏：kind=html，完整网页（含 <!DOCTYPE html>）。侧栏可预览、可直接交互，支持 JS。
- Word/文档/报告：kind=md。保存为 .md，Word 可打开。
用户要文件时**直接生成完整内容**——不要道歉、不要教他自己去做、不要只给示例。`;

const WORKFLOW = `# 工作方式（对齐 Codex / Claude Code）
1. **能动手就不问**：信息足够就直接做；只在缺关键参数且无法合理默认时才问，且一次只问最必要的。
2. **复杂任务拆步骤**：先搜索 → 再整合 → 输出产物，一步一步来，每步工具结果消化完再下一步。
3. **工具结果要消化**：搜索/网页返回的内容要提炼后回答，不要把原始结果粘贴给用户。
4. **失败就换路**：一个工具失败或结果不相关时换个查询词或换 open_page 重试，不要就此放弃。
5. **回答简洁完整**：先给结果（表格/文件/结论），再给一两句说明。不要长篇铺垫。`;

/** 默认提示词的四层。顺序即拼接顺序。 */
export const DEFAULT_FRAGMENTS: readonly PromptFragment[] = [
  { id: "base", body: BASE },
  { id: "tools", body: TOOLS },
  { id: "artifacts", body: ARTIFACTS },
  { id: "workflow", body: WORKFLOW }
] as const;

/** 默认提示词全文（四层按序拼接）。用户没写自定义提示词时用它。 */
export function defaultAgentPrompt(): string {
  return DEFAULT_FRAGMENTS.map((fragment) => fragment.body).join("\n\n");
}

export interface SystemPromptInput {
  /** 用户自定义提示词。非空则**整体替换**默认四层——用户永远优先（保留改动前的行为）。 */
  custom?: string;
  /** 历史使用习惯提示（main/modules/agentMemory.ts）。追加在通用提示词之后。 */
  memoryHint?: string;
  /**
   * world state 差异块（main/modules/worldState.ts）。只含**本轮的增量**——
   * 未变化的 section 不会出现在这里。空串则不加尾巴。
   */
  worldState?: string;
}

/**
 * 组装本轮的通用 system prompt（不含计划模式段落——那由 `withPlanMode` 在最后追加）。
 *
 * 顺序：通用提示词 → 历史习惯 → world state 增量。
 * world state 靠后：它是"环境事实"，越靠近采样点越不容易被长提示词稀释。
 */
export function buildSystemPrompt(input: SystemPromptInput): string {
  const base = input.custom?.trim() ? input.custom : defaultAgentPrompt();
  const parts = [base];
  if (input.memoryHint) parts.push(input.memoryHint);
  if (input.worldState?.trim()) parts.push(input.worldState.trim());
  return parts.join("\n\n");
}
