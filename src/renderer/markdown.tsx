import type { ReactNode } from "react";
import { PLAN_BLOCK_CLOSE, PLAN_BLOCK_OPEN } from "../shared/planMode";

// 轻量 Markdown 渲染器：React 元素树输出（无 innerHTML，无 XSS 面）。
// 覆盖语法：围栏代码块、行内代码、粗体、链接、有序/无序列表、标题、表格、方案块；其余按纯文本段落。
// 聊天场景足够，不足再扩。

/**
 * 表格最多渲染多少数据行。
 *
 * 模型偶尔吐出成千上万行的表格（把整份 CSV 当 markdown 贴出来），
 * 一次性铺开会把主线程占满（与预览面板 SheetTable 的 500 行上限同一理由）。
 * 只渲染前这么多行，并在表下明确告知还剩多少行——不静默少给。
 */
const MAX_TABLE_ROWS = 200;

export function renderMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const lines = text.split("\n");
  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index];

    // 方案块 <proposed_plan> … </proposed_plan>（计划模式定稿的显式契约）。
    // 必须单独处理：不处理的话这两个标签会作为普通段落的字面文本显示出来，
    // 用户看到一堆尖括号噪声，比不加标记更糟。
    if (line.trim() === PLAN_BLOCK_OPEN) {
      const body: string[] = [];
      index += 1;
      // 未闭合也当正文收下（流式途中会先出现开标签）：宁可先按方案渲染，
      // 也不要"开标签后的内容先按普通段落显示、闭合的一刻突然跳成另一种样式"。
      while (index < lines.length && lines[index].trim() !== PLAN_BLOCK_CLOSE) {
        body.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1; // 跳过闭标签
      // 递归渲染正文：块内仍是 markdown（标题/列表照常）。
      // 内层从 key 0 重新计数是安全的——与外层不同层级，React 只要求同级唯一。
      nodes.push(<div className="md-plan" key={key++}>{renderMarkdown(body.join("\n"))}</div>);
      continue;
    }

    // 围栏代码块 ```lang ... ```
    if (line.trimStart().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trimStart().startsWith("```")) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // 跳过闭合 ```
      nodes.push(
        <pre className="md-code" key={key++} data-lang={lang || undefined}>
          <code>{body.join("\n")}</code>
        </pre>
      );
      continue;
    }

    // 表格：表头行 + 下一行是分隔行（---|---）。模型常用表格输出结构化结果，
    // 不支持时整块沦为挤在一起的纯文本（实测热搜 10 条渲染成一坨）。
    //
    // 外侧竖线**必须可选**：GFM 允许 `a | b` / `---|---` / `1 | 2` 这种省略写法，
    // 模型也常这么写。此前要求首尾都有 `|`，这类表整块不识别（实测 probe-md-pipe-optional）。
    if (isTableRow(line) && isTableSeparator(lines[index + 1] ?? "")) {
      const header = parseTableRow(line);
      index += 2; // 跳过表头与分隔行
      const rows: string[][] = [];
      while (index < lines.length && isTableRow(lines[index])) {
        rows.push(parseTableRow(lines[index]));
        index += 1;
      }
      // **行数上限**：模型偶尔吐出成千上万行的表格，一次性铺开会把主线程占满
      // （与预览面板 `SheetTable` 的 500 行上限同一理由）。只渲染前 MAX_TABLE_ROWS 行，
      // 并明确告知还有多少行没显示——不静默少给。
      const shown = rows.slice(0, MAX_TABLE_ROWS);
      const hidden = rows.length - shown.length;
      nodes.push(
        <table key={key++}>
          <thead><tr>{header.map((cell, i) => <th key={i}>{inline(cell, key++)}</th>)}</tr></thead>
          <tbody>{shown.map((row, ri) => <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{inline(cell, key++)}</td>)}</tr>)}</tbody>
        </table>
      );
      if (hidden > 0) {
        nodes.push(<p key={key++} className="md-table-truncated">（表格共 {rows.length} 行，仅显示前 {MAX_TABLE_ROWS} 行）</p>);
      }
      continue;
    }

    // 标题 # 到 ####
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const content = inline(heading[2], key++);
      nodes.push(level === 1 ? <h3 key={key++}>{content}</h3> : level === 2 ? <h4 key={key++}>{content}</h4> : <h5 key={key++}>{content}</h5>);
      index += 1;
      continue;
    }

    // 无序列表 -/* 与有序列表 1. / 1、
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.、]\s+/.test(line)) {
      const ordered = /^\s*\d+[.、]\s+/.test(line);
      const items: ReactNode[] = [];
      while (index < lines.length && (/^\s*[-*]\s+/.test(lines[index]) || /^\s*\d+[.、]\s+/.test(lines[index]))) {
        const itemText = lines[index].replace(/^\s*(?:[-*]|\d+[.、])\s+/, "");
        items.push(<li key={key++}>{inline(itemText, key++)}</li>);
        index += 1;
      }
      nodes.push(ordered ? <ol key={key++}>{items}</ol> : <ul key={key++}>{items}</ul>);
      continue;
    }

    // 空行
    if (!line.trim()) {
      index += 1;
      continue;
    }

    // 普通段落（连续非空非特殊行合并）
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !lines[index].trimStart().startsWith("```") && !/^\s*[-*]\s+/.test(lines[index]) && !/^\s*\d+[.、]\s+/.test(lines[index]) && !/^#{1,4}\s/.test(lines[index]) && !isTableRow(lines[index])) {
      // 表格行不能并入段落：否则"说明文字：\n| a | b |\n|---|---|" 会把整张表
      // 当成段落正文（实测：紧随其后的表格完全不渲染，用户看到的是一堆竖线）。
      paragraph.push(lines[index]);
      index += 1;
    }
    nodes.push(<p key={key++}>{inline(paragraph.join("\n"), key++)}</p>);
  }
  return nodes;
}

/**
 * 表格行判定。**外侧竖线可选**（GFM 允许 `a | b`），但不能把正文里的竖线当分隔符：
 * 竖线必须位于行首/行尾，或至少一侧紧邻空白。
 * 否则「价格是 100 元|台」这类普通句子会被当成表格行（实测 probe-md-table-false）。
 * 分隔行由 isTableSeparator 单独判定，这里排除掉。
 */
function isTableRow(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.includes("|")) return false;
  if (isTableSeparator(trimmed)) return false;
  // 首/尾竖线，或竖线一侧紧邻空白 → 视为分隔符
  return /^\||\|$/.test(trimmed) || /(^|\s)\||\|(\s|$)/.test(trimmed);
}

/** 表格分隔行判定：`|---|---|` / `---|---` / `:--|--:` 等。 */
function isTableSeparator(text: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(text) && text.includes("-");
}

/**
 * 解析表格行 "| a | b |" → ["a","b"]：去首尾竖线后**按未转义的 | 切分**并修剪。
 *
 * 不能用 `split("|")`：单元格里的 `\|` 是 markdown 的转义竖线（模型常用来写 "A|B" 这类内容），
 * 朴素切分会把一格拆成两格、整行错位（实测 `| x\|y | z |` → 3 格而非 2 格）。
 */
function parseTableRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "\\" && body[i + 1] === "|") { current += "|"; i += 1; continue; }
    if (ch === "|") { cells.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

// 行内：`code`、**bold**、[text](url)。先切行内元素再拼纯文本。
//
// **http 链接仍要匹配，但只能渲染成纯文本**：
// 主进程的 `setWindowOpenHandler` 与 `shell:openExternal` 都只放行 HTTPS
// （CLAUDE.md 的安全约束，不能放宽），所以 http 渲染成 <a> 只会"点了没反应"。
// 但**也不能不匹配**——那样 `[标题](http://…)` 会把方括号与网址原文显示出来，
// 比不可点更糟。这里的做法：匹配 `https?`，http 只输出标题文字。
function inline(text: string, keyBase: number): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = keyBase * 1000;
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1] !== undefined) {
      nodes.push(<code key={key++}>{match[1]}</code>);
    } else if (match[2] !== undefined) {
      nodes.push(<strong key={key++}>{match[2]}</strong>);
    } else if (match[3] !== undefined && match[4]) {
      // 只有 https 可点击；http 退化为纯文本标题（保留可读性，不伪装成可点）。
      nodes.push(match[4].startsWith("https:")
        ? <a key={key++} href={match[4]} target="_blank" rel="noopener noreferrer">{match[3]}</a>
        : <span key={key++}>{match[3]}</span>);
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
