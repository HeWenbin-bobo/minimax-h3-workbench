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
  | { ok: false; reason: "empty-old" | "not-found" | "ambiguous"; count: number; lines: number[] };

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
  return { ok: false, reason: "not-found", count: 0, lines: [] };
}

/**
 * 带行号地切一段出来（读文件工具用）。
 *
 * 为什么要行号：模型据"第 42 行"能补出唯一上下文，而按字符偏移它算不准。
 * 越界一律夹紧而不是报错——模型给个大概范围时要能拿到东西，拿不到才是死路。
 *
 * @param startLine 1 起算，缺省 1
 * @param endLine   含端点，缺省到文件末尾
 */
export function sliceWithLineNumbers(text: string, startLine?: number, endLine?: number): { body: string; totalLines: number; from: number; to: number } {
  const lines = text.split("\n");
  const total = lines.length;
  const from = Math.max(1, Math.min(Math.floor(startLine ?? 1) || 1, total));
  const to = Math.max(from, Math.min(Math.floor(endLine ?? total) || total, total));
  const body = lines
    .slice(from - 1, to)
    .map((line, i) => `${String(from + i).padStart(5, " ")}| ${line}`)
    .join("\n");
  return { body, totalLines: total, from, to };
}
