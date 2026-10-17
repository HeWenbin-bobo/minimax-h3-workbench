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

/** 整段 CSV → 二维数组（正确跨行、正确引号）。 */
export function parseCsvRows(text: string): string[][] {
  return splitCsvLines(text).map((line) => parseCsvRow(line));
}

export function parseCsvRow(line: string): string[] {
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
    if (ch === "," || ch === "\t") { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.length > 0 || out.length > 0) out.push(cur.trim());
  return out;
}
