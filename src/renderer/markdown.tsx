import type { ReactNode } from "react";

// 轻量 Markdown 渲染器：React 元素树输出（无 innerHTML，无 XSS 面）。
// 覆盖语法：围栏代码块、行内代码、粗体、链接、有序/无序列表、标题；其余按纯文本段落。
// 聊天场景足够，不足再扩。

export function renderMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const lines = text.split("\n");
  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index];

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
    while (index < lines.length && lines[index].trim() && !lines[index].trimStart().startsWith("```") && !/^\s*[-*]\s+/.test(lines[index]) && !/^\s*\d+[.、]\s+/.test(lines[index]) && !/^#{1,4}\s/.test(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    nodes.push(<p key={key++}>{inline(paragraph.join("\n"), key++)}</p>);
  }
  return nodes;
}

// 行内：`code`、**bold**、[text](https-url)。先切行内元素再拼纯文本。
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
      nodes.push(<a key={key++} href={match[4]} target="_blank" rel="noopener noreferrer">{match[3]}</a>);
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
