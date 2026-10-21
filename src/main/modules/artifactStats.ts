/**
 * 表格/数值列的统计计算（智能体 `compute` 工具的实现）。
 *
 * 为什么需要（真机实测，2026-10-21）：让模型统计一份 5000 行 CSV 的温度最值与均值，
 * 它读了前 400 行之后**明确拒绝给平均值**，理由是
 * 「我没有可执行的代码工具用来对 399 个数求和，只靠逐行心算平均值得出的数字是编出来的」。
 * 那是**正确**的回答——但也说明我们缺了 Codex 有而我们没有的一环：算数能力。
 * 模型只能读文本、不能求和，于是"数据统计"这类任务永远只能给出部分结论。
 *
 * 设计取舍：**不做任意代码执行**（没有 shell、没有 eval、不引 vm）。
 * 只提供确定性的、可穷举的统计原语——模型要什么就调什么。
 * 这样既不引入沙箱逃逸面（本应用的安全红线），又能覆盖绝大多数数据分析需求。
 *
 * 纯函数、零依赖：好单测，也不会因为运行环境差异行为不同。
 */

export interface NumericSummary {
  /** 参与统计的样本数（跳过空值与非数字）。 */
  count: number;
  /** 被跳过的非数字/空值个数。 */
  skipped: number;
  min?: number;
  max?: number;
  sum?: number;
  mean?: number;
  median?: number;
  /** 总体标准差（不是样本标准差）。 */
  stdDev?: number;
}

/** 四舍五入到固定小数位，避免 0.30000000000000004 这类浮点尾巴影响模型判断。 */
function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const FULLWIDTH_MAP: Record<string, string> = { "．": ".", "，": ",", "－": "-", "＋": "+", "％": "%" };

/**
 * 把单元格文本解析成数字；不是数字返回 undefined。
 *
 * **必须剥常见装饰**（真实 CSV 里到处都是）：
 * `"1,234"`（千分位）、`"¥29.9"`（货币）、`"85%"`（百分号）、`" -10.0 "`（空白）。
 * 不剥的话这些值会被当成"非数字"跳过，统计结果**悄悄少算一批数据**——
 * 而模型看不出少了什么。
 *
 * `%` 不换算成小数（保留 85 而不是 0.85）：用户问"平均湿度"时期望的是 68.5 这种量纲。
 */
export function parseNumber(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== "string") return undefined;
  let text = raw.trim();
  if (!text) return undefined;
  // 全角数字 → 半角（中文表格里很常见）
  text = text.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  text = text.replace(/[．，－＋％]/g, (ch) => FULLWIDTH_MAP[ch] ?? ch);
  // 货币前缀
  text = text.replace(/^[¥$€£￥]/, "");
  // 千分位与空格分组：`1,234.5`。只在"整体是数字形态"时剥，避免把 `1,2` 这种列值当数字。
  if (/^[-+]?[\d,\s]+(?:\.\d+)?%?$/.test(text)) text = text.replace(/[,\s]/g, "");
  text = text.replace(/%$/, "");
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * 对一列原始值做统计。
 *
 * 空列返回 `{ count: 0, skipped: n }`——**不抛错**：模型传错列名时会得到
 * "这一列没有可用数字"，据此能自己纠正（抛错会让整轮失败，与本项目一贯口径一致）。
 */
export function summarizeColumn(values: readonly unknown[]): NumericSummary {
  const numbers: number[] = [];
  let skipped = 0;
  for (const value of values) {
    const parsed = parseNumber(value);
    if (parsed === undefined) skipped += 1;
    else numbers.push(parsed);
  }
  if (numbers.length === 0) return { count: 0, skipped };
  const sum = numbers.reduce((a, b) => a + b, 0);
  const mean = sum / numbers.length;
  const sorted = [...numbers].sort((a, b) => a - b); // 排序副本：不改入参
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const variance = numbers.reduce((acc, n) => acc + (n - mean) ** 2, 0) / numbers.length;
  return {
    count: numbers.length,
    skipped,
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
    sum: round(sum),
    mean: round(mean),
    median: round(median),
    stdDev: round(Math.sqrt(variance))
  };
}

/**
 * 猜分隔符：取首行里出现最多的一种（逗号 / 制表符 / 分号 / 竖线）。
 * 只看首行即可——表头与数据行必然用同一种。
 */
function detectDelimiter(headerLine: string): string {
  const candidates = [",", "\t", ";", "|"].map((ch) => ({ ch, n: headerLine.split(ch).length - 1 }));
  candidates.sort((a, b) => b.n - a.n);
  return candidates[0].n > 0 ? candidates[0].ch : ",";
}

/**
 * 切一行。**支持双引号包裹**（值里含分隔符时 CSV 会加引号，如 `"北京, 东城"`）。
 * 不处理引号的话那种行会整体错位，统计结果就落到别的列上。
 */
function splitRow(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      // 双引号转义：`""` 表示一个引号字符
      if (quoted && line[i + 1] === '"') { current += '"'; i += 1; continue; }
      quoted = !quoted;
      continue;
    }
    if (ch === delimiter && !quoted) { cells.push(current); current = ""; continue; }
    current += ch;
  }
  cells.push(current);
  return cells;
}

/**
 * 从 CSV/TSV 文本里切出**某一列**的原始值（按表头名或列序号）。
 *
 * @param name 表头名（精确匹配优先，其次包含匹配）；也可以是 0 起的列序号。
 * @returns 列值（不含表头）；列不存在返回 undefined。
 */
export function extractColumn(text: string, name: string | number): unknown[] | undefined {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n").filter((line) => line.trim());
  if (lines.length === 0) return undefined;
  const delimiter = detectDelimiter(lines[0]);
  const header = splitRow(lines[0], delimiter).map((cell) => cell.trim());
  let index = -1;
  if (typeof name === "number") {
    index = Number.isInteger(name) && name >= 0 && name < header.length ? name : -1;
  } else {
    const wanted = String(name).trim();
    index = header.indexOf(wanted);
    if (index < 0) index = header.findIndex((cell) => cell.includes(wanted));
  }
  if (index < 0) return undefined;
  return lines.slice(1).map((line) => splitRow(line, delimiter)[index]);
}
