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
