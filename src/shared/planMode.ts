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

1. **只输出计划，不产生副作用**。会产生产出的工具本轮**不下发**：不要 generate_video、不要 create_file、不要 edit_artifact / edit_artifact_batch、不要 inspect_artifact——先让用户看清你打算怎么做。
   **只读工具照常可用**（web_search / open_page / read_artifact）：写计划前该查的事实要查，别凭记忆编参数。
2. **用户催也不改**。"直接做/别废话/快点"这类话不改变本轮模式——那是让你**把执行本身规划出来**，不是让你开始执行。只有用户明确说"开始吧/执行"才算确认（那时系统会自动切到执行模式，你不用自己判断）。
3. 计划要**具体到可执行**：每一步写清"用什么工具、对什么内容做什么"，不要写"分析需求"这类空话。
4. 用有序列表，3–7 步为宜。每步一行，必要时给关键参数（如视频时长、文件名、格式）。
5. 结尾加一句「确认后我就开始执行」——不要问"你希望我怎么做"这类把球踢回去的问题。
6. 如果任务本身很简单（一步就能做完），直接说"这个任务不需要分步，我可以直接做"，并给出你要做的唯一动作。

## 两类未知，处理方式不同（重要）

- **可查到的事实**（价格、版本号、某网站有没有某个功能、某个数据的具体数值）→ **先自己去查**，
  用 web_search / open_page 查完再写计划。不要拿这些去问用户——那是把该你干的活推给用户。
- **用户的偏好与取舍**（要 6 秒还是 15 秒、竖屏还是横屏、表格里要不要包含某一类、更看重速度还是画质）
  → **这些才值得问**。有 request_user_input 工具时用它一次问清 1–3 个关键取舍；没有就用一句话直问。
  不回答也能做的话，给出你推荐的默认值并说明，而不是反复追问。

## 不要用 update_plan

update_plan 是"动手期间报进度"的工具，与计划模式是两件事——本轮它不下发。
计划直接写在回复正文里，不要试图调 update_plan。

## 定稿时用 <proposed_plan> 块包起来

只有**方案已经定稿、可以直接照做**时才这样输出，格式必须逐字如下（开标签独占一行、内容换行起、闭标签独占一行）：

<proposed_plan>
## 标题
一句话概述。

## 步骤
1. 具体动作（用什么工具、对什么内容、关键参数）
2. …

## 假设
- 我替你定的默认值，以及为什么
</proposed_plan>

标签名不要翻译、不要改名、不要换成全角括号——界面按这两个字符串识别方案块。
不确定、还在问用户、或任务简单到不需要分步时，**不要**输出这个块，正常写就行。

计划应包含（信息足够时）：
- 产出物是什么（视频 / 表格 / 网页 / 文档 / 一段回答）
- 需要先查什么资料（要不要联网搜索、查什么关键词）
- 关键参数（时长、数量、文件名、格式）
- 可能的风险或需要用户拍板的取舍`;

/**
 * `<proposed_plan>` 块契约。**标签字面量必须逐字保持**（含尖括号、不翻译、不改名）——
 * 渲染端按这两个字符串切块，改名或换成全角就切不开了。对齐 Codex plan.md 的
 * "Keep the tags exactly as ... do not translate or rename them, even if the user is writing in another language"。
 */
export const PLAN_BLOCK_OPEN = "<proposed_plan>";
export const PLAN_BLOCK_CLOSE = "</proposed_plan>";

/**
 * 从回复里切出计划块内容。无块 / 标签不闭合时返回 undefined。
 *
 * **不返回半截内容**：标签没闭合说明模型还在流式输出或写坏了，把中间一段当计划渲染，
 * 会让用户看到残缺方案并据此点「继续执行」。宁可退回纯文本渲染，等完整了再切。
 * 多个块只取第一个——Codex 规定一轮最多一个 `<proposed_plan>`。
 */
export function extractProposedPlan(text: string): string | undefined {
  const body = String(text || "");
  const start = body.indexOf(PLAN_BLOCK_OPEN);
  if (start < 0) return undefined;
  const contentStart = start + PLAN_BLOCK_OPEN.length;
  const end = body.indexOf(PLAN_BLOCK_CLOSE, contentStart);
  if (end < 0) return undefined;
  const inner = body.slice(contentStart, end).trim();
  return inner || undefined;
}

/** 计划确认后追加的提示词：声明上一轮的清单就是待执行的方案。 */
export const PLAN_EXECUTION_PROMPT = `# 计划已确认，开始执行

用户已确认你上一轮给出的计划。现在按该计划逐步执行：该调工具就调，该出产物就出。不要再复述计划，直接动手，最后简要说明完成了什么。`;

/**
 * 计划模式下**不下发**的工具名。判据是"会不会产生副作用/改动产物"：
 * - `generate_video` / `create_file`：会真的花钱、落盘；
 * - `edit_artifact` / `edit_artifact_batch`：会改写已有产物；
 * - `inspect_artifact`：本身只读，但它服务于"刚生成的产物"——本轮不产文件，留着只会让模型以为有东西可查；
 * - `update_plan`：语义是"动手期间报进度"，与"本轮只出方案"冲突（会分散注意力）。
 *
 * 保留的是**只读**工具：`web_search` / `open_page` / `read_artifact`，
 * 以及 `request_user_input`（计划里该问清的取舍就该问）。
 * 实际裁在 `main/modules/llmService.ts` 的工具表；这份清单供提示词与测试共用。
 */
export const PLAN_MODE_BLOCKED_TOOLS = ["generate_video", "create_file", "edit_artifact", "edit_artifact_batch", "inspect_artifact", "update_plan"] as const;

/** 计划模式下**仍然可用**的只读工具（写进提示词，避免模型以为一律不能调）。 */
export const PLAN_MODE_READONLY_TOOLS = ["web_search", "open_page", "read_artifact", "request_user_input"] as const;

/**
 * 计划模式下的工具说明：写清"哪些还在、哪些没了"，不让模型对着提示词猜边界。
 *
 * 旧版这里写的是「本轮仅供参考，不要实际调用」，同时上面第 1 条又说「不调用任何工具」——
 * 而工具表里 web_search / open_page / read_artifact 其实**是下发**的。
 * 提示词与工具表互相打架时，模型只能二选一：要么该查的不查（凭记忆编参数），
 * 要么查了以后以为自己违规、在计划里道歉。两边必须是同一套边界。
 *
 * 末尾关于 update_plan 的说明仍然必要：它**本身无害**（纯展示），
 * 但语义是"动手期间报进度"——留着会让模型去更新清单而不是写方案。
 *
 * **web_search 另有一层开关**（实测同类不一致）：用户关掉「联网」时它根本不下发
 * （`chatAgent` 的 `enableWebSearch`）。说明里若照旧写"可用"，模型会去调一个不存在的工具，
 * 然后为"我调不了搜索"道歉。故这个说明做成函数，按本轮**真实**可用集合生成。
 */
export function planModeToolNote(available: { webSearch: boolean }): string {
  const readonly: string[] = [];
  if (available.webSearch) readonly.push("- web_search(query)：联网查资料");
  readonly.push("- open_page(url)：打开具体网页看正文");
  readonly.push("- read_artifact(name, …)：读回本会话已有的产物");
  readonly.push("- request_user_input(questions)：问清 1–3 个关键取舍（用户不答就按最佳判断写进「假设」）");
  const webNote = available.webSearch
    ? ""
    : "\n（本轮用户关闭了「联网」，web_search 不下发；涉及实时信息时在计划里说明「需要联网核实」，不要假装查过。）";
  return `# 可用工具（本轮只有这些）
${readonly.join("\n")}
${webNote}
以下工具**本轮不下发**，因为它们会产生副作用或与"只出方案"冲突：
generate_video、create_file、edit_artifact、edit_artifact_batch、inspect_artifact、update_plan。
计划直接写在回复正文里，不要试图调 update_plan。`;
}

/** 默认（联网可用）的工具说明。保留给测试与"不关心开关"的调用方。 */
export const PLAN_MODE_TOOL_NOTE = planModeToolNote({ webSearch: true });

/** 本次发送要带哪种计划语义。undefined = 普通对话（零改动）。 */
export type PlanMode = "plan" | "execute" | undefined;

/**
 * 把计划模式段落拼进系统提示词。mode 为 undefined 时原样返回（普通对话零改动）。
 * 放在用户自定义提示词**之后**——计划约束是本轮的强规则，不该被覆盖。
 *
 * @param available 本轮**真实**可用的只读工具（决定"可用工具"那段怎么写）。
 */
export function withPlanMode(
  base: string,
  mode?: PlanMode,
  available: { webSearch: boolean } = { webSearch: true }
): string {
  if (!mode) return base;
  const note = mode === "plan" ? planModeToolNote(available) : "";
  const section = mode === "plan" ? `${PLAN_MODE_PROMPT}\n\n${note}` : PLAN_EXECUTION_PROMPT;
  return base ? `${base}\n\n${section}` : section;
}

/**
 * 计划是否"看起来像一份计划"。
 * 用途：模型有时会无视约束直接动手（调了工具/出了产物）。渲染端据此决定要不要
 * 把「继续执行」按钮亮出来——只有拿到像样的计划才值得让用户确认。
 *
 * 判据从宽：出现 `<proposed_plan>` 块（最强信号）→ 有序列表 ≥2 项 → 标志词。
 * 宁可宽松，也不要因为格式不完全符合而挡住用户（模型措辞千变万化）。
 */
export function looksLikePlan(text: string): boolean {
  const body = String(text || "");
  // 计划块是显式契约，优先判定——但它要求内容非空（空块不该亮按钮）。
  if (extractProposedPlan(body)) return true;
  if (body.length < 30) return false;
  // 中文习惯用"1."但序号后可能是全角句点/顿号，也可能带空格；从宽匹配。
  const orderedItems = (body.match(/^\s*\d+\s*[.、)]\s*\S/gm) || []).length;
  if (orderedItems >= 2) return true;
  return /确认后|开始执行|执行计划|以下是计划|计划如下/.test(body);
}

export interface PlanStepLike {
  step: string;
  status: "pending" | "in_progress" | "completed";
}

/**
 * 收尾时把"没走完的步骤"收拾干净。
 *
 * 真机实测（2026-10-21，deepseek-v4.1-flash，国产 CPU 对比表任务）：
 * 模型用 `update_plan` 列了 4 步，然后连做 **46 次工具调用**、真把 xlsx 交付了，
 * 但**再没调过一次 `update_plan`**——清单从头到尾停在 `0/4`，四步全是「○ 未开始」。
 * 用户看到的是"AI 说做完了、进度条说一步没开始"，比不显示清单更糟：
 * 他会以为任务半途而废，或者以为清单坏了。
 *
 * 这与 CLAUDE.md 那条规律一致：**文字约定约束不住模型**（工具描述里写了
 * "每完成一步就更新一次状态"，真机照样不照做）。所以要在机制上兜底。
 *
 * 判据刻意保守——只在**确实干成了事**时才收尾：
 * - 本轮产出了任务或文件（`produced`）→ 把 `pending` / `in_progress` 一律标完成；
 * - 什么都没产出 → **只**把 `in_progress` 退回 `pending`（"正在做"但不能假装做完）。
 *   收尾仍停在 `in_progress` 是错的：那一轮已经结束了，界面上却还挂着"进行中"。
 *
 * 纯函数：不读时钟、不碰 IO，便于单测。
 *
 * @param plan 本轮的步骤清单（没有清单时传空数组，返回空数组）
 * @param produced 本轮是否真的产出了东西（建了任务 / 落了文件 / 改了文件）
 * @returns 新数组（不改入参）；不需要变化时**原样返回同一引用**，让调用方能靠 `!==` 跳过推送
 */
export function settleStalePlan<T extends PlanStepLike>(plan: readonly T[], produced: boolean): readonly T[] {
  if (plan.length === 0) return plan;
  // 已经全部完成：不必推送（避免多一次无意义的 UI 刷新）
  if (plan.every((entry) => entry.status === "completed")) return plan;
  const next = plan.map((entry) => {
    if (produced) return entry.status === "completed" ? entry : { ...entry, status: "completed" as const };
    // 没产出：只把"进行中"退回"未开始"，绝不假报完成
    return entry.status === "in_progress" ? { ...entry, status: "pending" as const } : entry;
  });
  // 一个字段都没变时返回原引用
  const changed = next.some((entry, index) => entry.status !== plan[index].status);
  return changed ? next : plan;
}
