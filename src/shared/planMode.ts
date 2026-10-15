/**
 * 计划模式（对齐 Codex 的协作模式思路，按「无 shell / 无文件编辑」的宿主裁剪）。
 *
 * 解决的问题：复杂任务直接开做，模型容易在第 2 步就跑偏——多步工具调用期间用户
 * 只能干等，做出来的东西未必是他要的。
 *
 * 与 Codex 的差异：Codex 的 plan 是**协作模式**（collaboration_mode），带一整套
 * 审批与工具裁剪；我们不做审批流——只做「先出计划、用户点继续」这一层，
 * 因为我们的工具没有破坏性（不写用户文件、不跑 shell），不需要审批闸门。
 *
 * 放 shared：提示词给主进程用，`looksLikePlan` 给渲染端用（决定「继续执行」按钮
 * 亮不亮）。纯数据与纯函数，无 Electron / Node 依赖。
 */

/** 计划模式注入的提示词。告诉模型本轮的产出必须是一份计划，而不是动手做。 */
export const PLAN_MODE_PROMPT = `# 本轮是「计划模式」

用户要求你先给方案、暂不执行。请遵守：

1. **只输出计划，不调用任何工具**。不要 generate_video、不要 create_file、不要 web_search——先让用户看清你打算怎么做。
2. 计划要**具体到可执行**：每一步写清"用什么工具、对什么内容做什么"，不要写"分析需求"这类空话。
3. 用有序列表，3–7 步为宜。每步一行，必要时给关键参数（如视频时长、文件名、格式）。
4. 结尾加一句「确认后我就开始执行」——不要问"你希望我怎么做"这类把球踢回去的问题。
5. 如果任务本身很简单（一步就能做完），直接说"这个任务不需要分步，我可以直接做"，并给出你要做的唯一动作。

计划应包含（信息足够时）：
- 产出物是什么（视频 / 表格 / 网页 / 文档 / 一段回答）
- 需要先查什么资料（要不要联网搜索、查什么关键词）
- 关键参数（时长、数量、文件名、格式）
- 可能的风险或需要用户拍板的取舍`;

/** 计划确认后追加的提示词：声明上一轮的清单就是待执行的方案。 */
export const PLAN_EXECUTION_PROMPT = `# 计划已确认，开始执行

用户已确认你上一轮给出的计划。现在按该计划逐步执行：该调工具就调，该出产物就出。不要再复述计划，直接动手，最后简要说明完成了什么。`;

/** 计划模式下禁用（不下发）的工具名。这两个是"产生副作用"的工具。 */
export const PLAN_MODE_BLOCKED_TOOLS = ["generate_video", "create_file"] as const;

/** 计划模式下的工具说明：只列出工具供参考，明确说明本轮不要调用。 */
export const PLAN_MODE_TOOL_NOTE = `# 可用工具（本轮仅供参考，不要实际调用）
- web_search(query)：联网查资料
- open_page(url)：打开具体网页看正文
- generate_video(prompt, duration, count)：生成 AI 视频（4–15 秒、1–4 路）
- create_file(kind, name, content)：生成文件产物（表格 / 网页 / 文档）`;

/** 本次发送要带哪种计划语义。undefined = 普通对话（零改动）。 */
export type PlanMode = "plan" | "execute" | undefined;

/**
 * 把计划模式段落拼进系统提示词。mode 为 undefined 时原样返回（普通对话零改动）。
 * 放在用户自定义提示词**之后**——计划约束是本轮的强规则，不该被覆盖。
 */
export function withPlanMode(base: string, mode?: PlanMode): string {
  if (!mode) return base;
  const section = mode === "plan" ? `${PLAN_MODE_PROMPT}\n\n${PLAN_MODE_TOOL_NOTE}` : PLAN_EXECUTION_PROMPT;
  return base ? `${base}\n\n${section}` : section;
}

/**
 * 计划是否"看起来像一份计划"。
 * 用途：模型有时会无视约束直接动手（调了工具/出了产物）。渲染端据此决定要不要
 * 把「继续执行」按钮亮出来——只有拿到像样的计划才值得让用户确认。
 *
 * 判据从宽：有序列表 ≥2 项，或出现"计划/确认后"等标志词。宁可宽松，
 * 也不要因为格式不完全符合而挡住用户（模型措辞千变万化）。
 */
export function looksLikePlan(text: string): boolean {
  const body = String(text || "");
  if (body.length < 30) return false;
  // 中文习惯用"1."但序号后可能是全角句点/顿号，也可能带空格；从宽匹配。
  const orderedItems = (body.match(/^\s*\d+\s*[.、)]\s*\S/gm) || []).length;
  if (orderedItems >= 2) return true;
  return /确认后|开始执行|执行计划|以下是计划|计划如下/.test(body);
}
