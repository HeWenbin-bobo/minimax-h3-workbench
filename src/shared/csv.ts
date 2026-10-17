/**
 * 单行 CSV 解析：正确处理引号字段。
 *
 * SheetJS 的 `sheet_to_csv` 默认会对含 `,`、`"` 或换行的字段加双引号包裹、
 * 字段内的 `"` 会被转义为 `""`。本函数按这套规则反解——与 SheetTable 拆分逻辑配套，
 * 替代旧的 `line.split(/,\t?|\t/)`（含逗号字段会被错切成多列）。
 *
 * 字段分隔符：`,` 或 `\t`（制表）。引号外遇到任一分隔符即结束当前字段；
 * 引号内遇到分隔符视为普通字符（保留），遇到 `""` 视为一个 `"`。
 * 字段两侧的空白会被 trim 掉。
 */
/**
 * 把整段 CSV 文本切成行（**引号内的换行不算行尾**）。
 *
 * 为什么需要：SheetJS 对含换行的字段会加引号跨行输出（`"多行\n内容",x`）。
 * 若先按 `\n` 切行再逐行解析，那一格会被劈成两行、后续列全部错位
 * （实测 probe-csv-newline：2 行被切成 3 行）。
 */
export function splitCsvLines(text: string): string[] {
  const lines: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      // 引号内的 "" 是转义，原样保留；引号内出现的单个 " 才是结束引用。
      if (inQuotes && text[i + 1] === '"') { current += '""'; i += 1; continue; }
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (!inQuotes && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && text[i + 1] === "\n") i += 1; // \r\n 当作一个换行
      lines.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.length > 0) lines.push(current);
  return lines.map((line) => line.trim()).filter(Boolean);
}

/**
 * 推断分隔符：分别按 `,` 与 `\t` 试切，选**能切出多列的行数最多**的那个。
 *
 * 不能只看"全文含不含 \t"：CSV 单元格里出现制表符（"备注\t含tab"）会被误判成 TSV，
 * 整表列数错乱（实测 probe-delim-guess）。也不能两个都当分隔符（TSV 里的逗号会被切，probe-tsv-comma）。
 *
 * 计分：引号内的分隔符不算数（parseCsvRow 已处理），所以对每种分隔符数"width > 1 的行数"。
 * 平手时取列数一致的那个，再平手取首行列数大的。
 */
function detectDelimiter(lines: string[]): string {
  const score = (delimiter: string) => {
    const widths = lines.map((line) => parseCsvRow(line, delimiter).length);
    const first = widths[0] ?? 1;
    return {
      separated: widths.filter((width) => width > 1).length,
      consistent: widths.every((width) => width === first),
      first
    };
  };
  const comma = score(",");
  const tab = score("\t");
  if (comma.separated !== tab.separated) return comma.separated > tab.separated ? "," : "\t";
  if (comma.consistent !== tab.consistent) return comma.consistent ? "," : "\t";
  return tab.first > comma.first ? "\t" : ",";
}

/** 整段 CSV/TSV → 二维数组（正确跨行、正确引号、自动识别分隔符）。 */
export function parseCsvRows(text: string): string[][] {
  const lines = splitCsvLines(text);
  if (lines.length === 0) return [];
  const delimiter = detectDelimiter(lines);
  return lines.map((line) => parseCsvRow(line, delimiter));
}

/**
 * 单行 CSV/TSV 解析：正确处理引号字段。
 *
 * @param delimiter 字段分隔符（默认逗号）。TSV 传制表符——此时行内逗号是普通字符。
 */
export function parseCsvRow(line: string, delimiter = ","): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; continue; }
        inQuotes = false;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === delimiter) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.length > 0 || out.length > 0) out.push(cur.trim());
  return out;
}
