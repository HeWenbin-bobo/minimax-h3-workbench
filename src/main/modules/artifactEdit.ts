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
import { sliceSafe } from "../../shared/text";

/** 一次编辑的结果。失败时带足够信息让模型自己修正（不抛异常，让工具层决定怎么措辞）。 */
export type EditOutcome =
  | {
      ok: true;
      text: string;
      line: number;
      /**
       * oldText 原本带着 `read_artifact` 的行号前缀（`   42| …`），已被自动剥掉。
       * 调用方应当告诉模型这一点，否则它不知道"我抄错了却没报错"是怎么发生的。
       */
      strippedGutter?: boolean;
    }
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

/**
 * 歧义时最多报几条行号。
 *
 * 调用方（`main.ts`）只取前 6 条拼进错误信息，其余没人用。不设上限的话，
 * 一个过短的 oldText（`}` / `return`）在一个 600KB 的文件里能命中几万处，
 * 光是构造这个数组就是几十万个数字——而模型只看到 6 个。
 */
const MAX_REPORTED_LINES = 20;

/**
 * 把一组**升序**偏移批量翻译成行号，只扫描一遍文本。
 *
 * 旧实现是 `indexes.map((at) => lineOf(text, at))`——每处命中都从头数一遍换行，
 * 复杂度 = 命中数 × 文件长度。实测（600KB 产物、模式 `}`）：
 * **命中 40,000 次时主进程被同步阻塞 8.2 秒**，整个窗口卡死（渲染进程等 IPC 回包），
 * 用户看到的是"软件没反应了"。模型给出一个过短的 oldText 就会触发，
 * 而这恰恰是它最常犯的错（`oldText` 太短 → 命中多处 → 正好走这条路径）。
 *
 * @param indexes 必须升序（`occurrences` 的返回值就是）。
 */
function linesOf(text: string, indexes: readonly number[]): number[] {
  const out: number[] = [];
  let line = 1;
  let cursor = 0;
  for (const index of indexes) {
    if (out.length >= MAX_REPORTED_LINES) break;
    // 只补扫"上一次游标到本次命中"这一段，总量与文件长度线性。
    for (let i = cursor; i < index && i < text.length; i += 1) {
      if (text.charCodeAt(i) === 10) line += 1;
    }
    if (index > cursor) cursor = index;
    out.push(line);
  }
  return out;
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
    let firstHitAt = -1;
    for (const token of tokens) {
      const at = lines[i].indexOf(token);
      if (at === -1) continue;
      score += token.length;
      if (firstHitAt === -1 || at < firstHitAt) firstHitAt = at;
    }
    // **候选行必须围绕命中的词截，不能取行首**（实测复现）：压缩过的产物 HTML
    // 一行几十万字符，行首 160 字全是 `x`。模型收到"跟它最接近的行是：xxx…"，
    // 里面根本没有它要找的标识符——提示等于没给，它只能再读一遍再猜一遍。
    if (score > 0) scored.push({ line: i + 1, text: excerptAround(lines[i], firstHitAt, 240), score });
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
    return { ok: false, reason: "ambiguous", count: direct.length, lines: linesOf(text, direct) };
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
    return { ok: false, reason: "ambiguous", count: hits.length, lines: linesOf(normalizedText, hits) };
  }

  // 第三次尝试：剥掉 `read_artifact` 的**行号前缀**再匹配。
  //
  // 为什么需要（实测复现）：`read_artifact` 返回的是 `    42| const a = 1;` 这种带行号的文本，
  // 而模型照着抄进 oldText 时，很自然地连着 `42| ` 一起复制（它看到的就是这段）。
  // 那不是文件里的内容，精确匹配必然失败 → 模型只能再读一遍、再猜一遍。
  // 这是我们**自己的输出格式**给它挖的坑，理应在这里替它剥掉。
  //
  // 只在"至少一半的行都带行号前缀"时才剥：单看第一行不足以判断——
  // 产物里本来就可能出现 `1| ` 这样的文本（ASCII 表格、竖线分隔的笔记）。
  const degutter = (value: string): string | undefined => {
    const lines = value.split("\n");
    const withGutter = lines.filter((line) => /^\s*\d+\| ?/.test(line)).length;
    if (withGutter === 0 || withGutter * 2 < lines.length) return undefined;
    return lines.map((line) => line.replace(/^\s*\d+\| ?/, "")).join("\n");
  };
  const degutterNeedle = degutter(normalizedNeedle);
  if (degutterNeedle !== undefined && degutterNeedle !== normalizedNeedle) {
    const strippedHits = occurrences(normalizedText, degutterNeedle);
    if (strippedHits.length === 1) {
      const at = strippedHits[0];
      return {
        ok: true,
        text: normalizedText.slice(0, at) + normalizeEol(replacement) + normalizedText.slice(at + degutterNeedle.length),
        line: lineOf(normalizedText, at),
        strippedGutter: true
      };
    }
    if (strippedHits.length > 1) {
      return { ok: false, reason: "ambiguous", count: strippedHits.length, lines: linesOf(normalizedText, strippedHits) };
    }
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
 * 一次读回的**字符**上限。
 *
 * 为什么只限行数不够（实测：真实产物 1757 行、最长单行 169 字符，没触发；
 * 但压缩过的 HTML / 超宽 CSV 可以是**一行几十万字符**）：
 * 400 行 × 单行 5000 字符 = 200 万字符 ≈ 57 万 token，一次就把上下文读爆。
 * 行数只是"看起来合理"的护栏，**字面量才是真正决定占用的那个量**。
 */
export const MAX_READ_CHARS = 60_000;

/**
 * 带行号地切一段出来（读文件工具用）。
 *
 * 为什么要行号：模型据"第 42 行"能补出唯一上下文，而按字符偏移它算不准。
 * 越界一律夹紧而不是报错——模型给个大概范围时要能拿到东西，拿不到才是死路。
 *
 * **两道上限**：未指定 endLine 时最多 `MAX_READ_LINES` 行（行数护栏）；
 * 渲染出来超过 `MAX_READ_CHARS` 字符时再按字符截（真正决定 token 占用的量）。
 * 两种截断都通过 `truncated` / `charCapped` 如实报出，让模型知道该用范围或 keyword 继续读。
 *
 * @param startLine 1 起算，缺省 1
 * @param endLine   含端点，缺省到 startLine + MAX_READ_LINES - 1
 */
export function sliceWithLineNumbers(text: string, startLine?: number, endLine?: number): { body: string; totalLines: number; from: number; to: number; truncated: boolean; charCapped: boolean; reversed: boolean } {
  const lines = text.split("\n");
  const total = lines.length;
  const from = Math.max(1, Math.min(Math.floor(startLine ?? 1) || 1, total));
  // 有显式 endLine 时尊重它（但也夹到文件末尾）；没给就按默认上限截断。
  const requested = endLine === undefined ? from + MAX_READ_LINES - 1 : Math.floor(endLine) || total;
  // **范围写反**（endLine < startLine）要如实标出：夹紧后只会返回一行，
  // 而 `truncated` 分会说"还有 N 行没显示"——那 N 行其实在范围**之前**。
  // 模型据此会以为自己没读到文件结尾，于是反复换范围重读（实测：8–3 回一行 + "还有 2 行没显示"）。
  const reversed = endLine !== undefined && Number.isFinite(Math.floor(endLine)) && Math.floor(endLine) < from;
  const to = Math.max(from, Math.min(requested, total));
  const body = lines
    .slice(from - 1, to)
    .map((line, i) => `${String(from + i).padStart(5, " ")}| ${line}`)
    .join("\n");
  // 字符上限：压缩过的 HTML 可能是"一行几十万字符"，只限行数挡不住。
  if (body.length > MAX_READ_CHARS) {
    // 用 sliceSafe 语义：裸 slice 会切开 emoji 的代理对，留下渲染成 � 的坏字符。
    return { body: sliceSafe(body, MAX_READ_CHARS), totalLines: total, from, to, truncated: to < total, charCapped: true, reversed };
  }
  return { body, totalLines: total, from, to, truncated: to < total, charCapped: false, reversed };
}

/**
 * 按关键词在文件里定位，返回命中行（行号 + 原文）与前后文。
 *
 * 为什么需要（实测真机）：模型要改某个函数，但不知道它在哪里，于是把 2118 行的文件
 * 按 400 行一段**连读 5 次**（步骤条上 5 行"读取文件完成（共 2118 行）"），
 * 光找位置就吃掉 5 步。给它"搜一下"的能力，一步就能定位。
 *
 * 匹配是**字面量**（大小写敏感），不做正则：模型给的多半是标识符原文，
 * 正则元字符反而会让它写出匹配不到的模式。
 *
 * **也要按字符截断**（实测复现）：压缩过的产物 HTML 常常是**一行几十万字符**，
 * 关键词又正好落在那一行里——`context` 带出的"前后各 2 行"其实就是整行全文。
 * 实测 600KB 文件里 locate 一个标识符，返回 600,034 字符（= 10 × `MAX_READ_CHARS`），
 * 一次就把上下文烧掉约 15 万 token。`sliceWithLineNumbers` 早有这道闸门，
 * 这里漏了（同一类上限写两处、只改一处）。
 *
 * @param limit 最多返回几条命中
 * @param context 每条命中额外带前后各几行
 */
export function findMatchingLines(
  text: string,
  keyword: string,
  limit = 20,
  context = 2
): { matches: Array<{ line: number; text: string }>; total: number; body: string; charCapped: boolean; lineCapped: boolean; caseOnly: number } {
  const needle = String(keyword ?? "");
  const lines = text.split("\n");
  if (!needle) return { matches: [], total: 0, body: "", charCapped: false, lineCapped: false, caseOnly: 0 };
  const hits: number[] = [];
  for (let i = 0; i < lines.length && hits.length < limit; i += 1) {
    if (lines[i].includes(needle)) hits.push(i + 1);
  }
  // 统计总数时不受 limit 限制，便于告诉模型"还有更多"。
  let total = 0;
  for (const line of lines) if (line.includes(needle)) total += 1;
  // **只是大小写不同**也算一条有用线索（实测）：匹配是刻意区分大小写的（模型给的多半是
  // 标识符原文），但它常把 `SPEED` 写成 `speed`。此时只回"换个片段试试（区分大小写）"，
  // 它只会换一个词再搜一次。数一下忽略大小写能命中多少行，回执就能直接说"只是大小写不同"。
  let caseOnly = 0;
  if (total === 0) {
    const lower = needle.toLowerCase();
    for (const line of lines) if (line.toLowerCase().includes(lower)) caseOnly += 1;
  }
  const blocks: string[] = [];
  const matches: Array<{ line: number; text: string }> = [];
  const shown = new Set<number>();
  // 是否发生过**行内**截断。必须单独标出来（而不是靠 body 里出现「…」判断：
  // 产物正文本来就可能含省略号），否则模型把节选当成原文照抄，oldText 必然匹配不上。
  let lineCapped = false;
  for (const hit of hits) {
    matches.push({ line: hit, text: lines[hit - 1].trim() });
    const from = Math.max(1, hit - context);
    const to = Math.min(lines.length, hit + context);
    for (let n = from; n <= to; n += 1) {
      if (shown.has(n)) continue;
      shown.add(n);
      // **命中行按 needle 居中截**：压缩过的单行 HTML 有几十万字符，
      // 直接裸拼等于把整行塞回上下文；而按行首截又会把 needle 本身切掉
      // （它在行尾时模型看到的正好是"没有命中"的一段）。
      if (lines[n - 1].length > EXCERPT_CHARS) lineCapped = true;
      blocks.push(`${String(n).padStart(5, " ")}| ${excerptLine(lines[n - 1], n === hit ? needle : undefined)}`);
    }
  }
  const joined = blocks.join("\n");
  if (joined.length > MAX_READ_CHARS) {
    return { matches, total, body: sliceSafe(joined, MAX_READ_CHARS), charCapped: true, lineCapped, caseOnly };
  }
  return { matches, total, body: joined, charCapped: false, lineCapped, caseOnly };
}

/**
 * 围绕某个偏移截一段（首尾被省略时加「…」）。
 *
 * 用于"最接近的行"提示：压缩过的单行 HTML 有几十万字符，从行首截等于给模型看一屏 `x`。
 * 必须把**命中的那个词**留在窗口里，提示才有用。
 */
function excerptAround(line: string, at: number, max: number): string {
  const trimmed = line.trim();
  if (trimmed.length <= max) return trimmed;
  // trim 会挪动偏移：按 trim 掉的前导空白量修正（否则窗口会整体偏左）。
  const shift = line.length - line.trimStart().length;
  const center = Math.max(0, at - shift);
  const start = Math.max(0, Math.min(center - Math.floor(max / 2), trimmed.length - max));
  const end = start + max;
  return `${start > 0 ? "…" : ""}${sliceSafe(trimmed.slice(start, end), max)}${end < trimmed.length ? "…" : ""}`;
}

/** 单行展示长度上限。命中行取 needle 附近，其余取行首。 */
const EXCERPT_CHARS = 400;

function excerptLine(line: string, needle?: string): string {
  if (line.length <= EXCERPT_CHARS) return line;
  if (needle) {
    const at = line.indexOf(needle);
    // 前后各留一段，保证 needle 与它的缩进/赋值上下文都能看到。
    const start = Math.max(0, at - Math.floor((EXCERPT_CHARS - needle.length) / 2));
    const end = Math.min(line.length, start + EXCERPT_CHARS);
    const head = start > 0 ? "…" : "";
    const tail = end < line.length ? "…" : "";
    return `${head}${sliceSafe(line.slice(start, end), EXCERPT_CHARS)}${tail}`;
  }
  return `${sliceSafe(line, EXCERPT_CHARS)}…`;
}
