/**
 * 产物局部编辑（移植 OpenAI Codex `apply_patch` 的核心约束：**必须精确、必须唯一**）。
 *
 * 为什么需要（实测真机，鹈鹕骑自行车案例）：模型为改一行（`M.identity` → `M.ident`）
 * 把 40KB 的文件**整份重写**了一次，结果新文件里**仍然留着那一处**——原文件 2 处、
 * 所谓"修好版"还有 1 处。整份重写有两个固有代价：
 * ① 输出 40KB 只为改 3 个字符，白烧 token 且更容易在重排中引入新 bug；
 * ② 模型无从核对"我到底改成没有"，只能凭记忆断言。
 *
 * Codex 的 `apply_patch` 用"上下文匹配"解决这件事；这里取它的两条硬约束：
 * - **精确匹配**（不做模糊/正则），模型写什么就找什么；
 * - **必须唯一**，命中 0 处或多处都拒绝写入，并把候选位置报回去让它补充上下文。
 *
 * 多出来的那点严格是有意的：静默改错地方比报错难查得多。
 */

/** 一次编辑的结果。失败时带足够信息让模型自己修正（不抛异常，让工具层决定怎么措辞）。 */
export type EditOutcome =
  | { ok: true; text: string; line: number }
  | {
      ok: false;
      reason: "empty-old" | "not-found" | "ambiguous";
      count: number;
      lines: number[];
      /** `not-found` 时给出的"最接近的行"（行号 + 原文），让模型能直接抄准确片段。 */
      hints?: Array<{ line: number; text: string }>;
    };

/** 1 起算的行号。用于把"命中多处"翻译成模型能直接用的坐标。 */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/** 找出 needle 在 haystack 里的全部起始位置。 */
function occurrences(haystack: string, needle: string): number[] {
  const hits: number[] = [];
  if (!needle) return hits;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return hits;
    hits.push(at);
    // 从下一个字符继续：允许模式自身重叠（例如 "aa" 在 "aaa" 里命中 2 次），
    // 否则"到底有几处"会被低估，进而放行一次本该被拒绝的歧义编辑。
    from = at + 1;
  }
}

/** 行尾归一：Windows 上模型给的 oldText 可能是 `\r\n`，而文件里是 `\n`。 */
function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * 找不到原文时，挑几条**最接近的行**给模型看。
 *
 * 为什么需要（实测真机）：模型猜错 oldText（缩进差一点、少个分号）时只收到一句"找不到"，
 * 它只能再读一次 400 行、再猜一次——单轮里重复了 4 次，20 步预算就这样烧光。
 * 给出候选行，它就能直接照抄准确片段，一轮收敛。
 *
 * 做法：从 oldText 里取最长的几个"有辨识度片段"（标识符/字符串），
 * 找包含它们的行；按命中长度降序取前 3 条。找不到任何线索就返回空数组。
 */
function closestLines(text: string, needle: string, limit = 3): Array<{ line: number; text: string }> {
  // 取 oldText 里较长的词（标识符、函数名通常最有辨识度），过短的词噪声太大。
  const tokens = (needle.match(/[A-Za-z_$][\w$.]{3,}|[^\s'"`]{6,}/g) ?? [])
    .sort((a, b) => b.length - a.length)
    .slice(0, 4);
  if (tokens.length === 0) return [];
  const lines = text.split("\n");
  const scored: Array<{ line: number; text: string; score: number }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    let score = 0;
    for (const token of tokens) if (lines[i].includes(token)) score += token.length;
    if (score > 0) scored.push({ line: i + 1, text: lines[i].trim(), score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ line, text: body }) => ({ line, text: body }));
}

/**
 * 按上下文精确替换一次。
 *
 * 匹配顺序：
 * 1. 原样精确匹配；
 * 2. 原样失败时，退一步做**行尾归一**后再匹配（模型常混用 CRLF/LF），
 *    归一后命中就写回归一后的文本——生成型产物统一成 `\n` 无副作用。
 *
 * 命中 0 处 → `not-found`；命中多处 → `ambiguous`（附全部行号，模型据此补上下文）。
 */
export function applyExactEdit(text: string, oldText: string, newText: string): EditOutcome {
  const needle = String(oldText ?? "");
  if (!needle) return { ok: false, reason: "empty-old", count: 0, lines: [] };
  const replacement = String(newText ?? "");

  const direct = occurrences(text, needle);
  if (direct.length === 1) {
    const at = direct[0];
    return { ok: true, text: text.slice(0, at) + replacement + text.slice(at + needle.length), line: lineOf(text, at) };
  }
  if (direct.length > 1) {
    return { ok: false, reason: "ambiguous", count: direct.length, lines: direct.map((at) => lineOf(text, at)) };
  }

  // 行尾归一后再试一次。
  const normalizedText = normalizeEol(text);
  const normalizedNeedle = normalizeEol(needle);
  const hits = occurrences(normalizedText, normalizedNeedle);
  if (hits.length === 1) {
    const at = hits[0];
    return {
      ok: true,
      text: normalizedText.slice(0, at) + normalizeEol(replacement) + normalizedText.slice(at + normalizedNeedle.length),
      line: lineOf(normalizedText, at)
    };
  }
  if (hits.length > 1) {
    return { ok: false, reason: "ambiguous", count: hits.length, lines: hits.map((at) => lineOf(normalizedText, at)) };
  }
  // 找不到时给出**最接近的几行**：只回一句"找不到"，模型只能再读一次文件、再猜一次
  // （真机上它这样重复了 4 次，20 步预算全烧在这上面）。
  return { ok: false, reason: "not-found", count: 0, lines: [], hints: closestLines(normalizedText, normalizedNeedle) };
}

/**
 * 一次调用里应用**多处**编辑，全部成功才写盘。
 *
 * 为什么需要（实测真机）：模型一次要修 5 处 bug，`edit_artifact` 一次只改一处，
 * 于是消耗 5 步工具预算；叠加 `stepCountIs(10)` 后任务直接被打断（真机那一轮就停在这里）。
 * Codex 的 `apply_patch` 本身就是"一次提交多个 hunk"，我们照此补齐。
 *
 * **原子性**：任意一处失败就整体不写，并把失败的是第几处报回去。
 * 半途写盘会让文件停在"改了一半"的状态，模型再基于它继续改只会越改越乱。
 *
 * 顺序应用：后一处基于**前一处已改过**的文本匹配——这样模型可以把相邻改动拆成多条，
 * 不必为了避开互相干扰而手工合并。
 */
export type BatchEditOutcome =
  | { ok: true; text: string; lines: number[] }
  | {
      ok: false;
      index: number;
      reason: "empty-old" | "not-found" | "ambiguous";
      count: number;
      lines: number[];
      /** `not-found` 时附带的"最接近的行"，让模型直接照抄而不是反复重读。 */
      hints?: Array<{ line: number; text: string }>;
    };

export function applyExactEdits(text: string, edits: readonly { oldText: string; newText: string }[]): BatchEditOutcome {
  let current = text;
  const lines: number[] = [];
  for (let index = 0; index < edits.length; index += 1) {
    const outcome = applyExactEdit(current, edits[index].oldText, edits[index].newText);
    // 必须把 hints 一并转发：漏了它，批量版就退化成"只说找不到"，
    // 模型照样得反复重读（单测「批量版也会把候选行带出来」锁住这一点）。
    if (!outcome.ok) return { ok: false, index, reason: outcome.reason, count: outcome.count, lines: outcome.lines, hints: outcome.hints };
    current = outcome.text;
    lines.push(outcome.line);
  }
  return { ok: true, text: current, lines };
}

/**
 * 一次读回的最大行数。**必须有默认上限**（实测真机踩到）：模型不带 startLine/endLine
 * 读一个 1651 行的页面时，工具把**全文**塞回上下文，它紧接着又读了一遍——
 * 两次全量读回 ≈ 几十 KB 白烧，还挤掉了后面的修改步骤。
 * 工具描述里写了"一次别读整个文件"，但提示词不是护栏，代码才是。
 */
export const MAX_READ_LINES = 400;

/**
 * 带行号地切一段出来（读文件工具用）。
 *
 * 为什么要行号：模型据"第 42 行"能补出唯一上下文，而按字符偏移它算不准。
 * 越界一律夹紧而不是报错——模型给个大概范围时要能拿到东西，拿不到才是死路。
 *
 * **未指定 endLine 时最多返回 MAX_READ_LINES 行**，并在 `truncated` 里说明还剩多少行，
 * 让模型知道该用范围继续读，而不是以为文件就这么长。
 *
 * @param startLine 1 起算，缺省 1
 * @param endLine   含端点，缺省到 startLine + MAX_READ_LINES - 1
 */
export function sliceWithLineNumbers(text: string, startLine?: number, endLine?: number): { body: string; totalLines: number; from: number; to: number; truncated: boolean } {
  const lines = text.split("\n");
  const total = lines.length;
  const from = Math.max(1, Math.min(Math.floor(startLine ?? 1) || 1, total));
  // 有显式 endLine 时尊重它（但也夹到文件末尾）；没给就按默认上限截断。
  const requested = endLine === undefined ? from + MAX_READ_LINES - 1 : Math.floor(endLine) || total;
  const to = Math.max(from, Math.min(requested, total));
  const body = lines
    .slice(from - 1, to)
    .map((line, i) => `${String(from + i).padStart(5, " ")}| ${line}`)
    .join("\n");
  return { body, totalLines: total, from, to, truncated: to < total };
}
