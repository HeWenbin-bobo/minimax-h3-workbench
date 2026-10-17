import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown } from "./markdown";
import { PLAN_BLOCK_CLOSE, PLAN_BLOCK_OPEN } from "../shared/planMode";

const render = (text: string) => renderToStaticMarkup(createElement("div", null, renderMarkdown(text)));

// PgToolSteps 行为契约的回归护栏：折叠/展开交互由 E2E 探针（probe-preview）覆盖，
// 这里保证 markdown 渲染与 App 模块加载不受改动影响。
describe("工具步骤折叠（PgToolSteps 行为契约）", () => {
  it("renderMarkdown 表格渲染回归护栏", () => {
    const html = renderToStaticMarkup(createElement("div", null, renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |")));
    expect(html).toContain("<table>");
  });

  it("App 模块可加载（PgToolSteps 定义无语法/引用错误）", async () => {
    const mod = await import("./App");
    expect(typeof mod.App).toBe("function");
  });
});

// 方案块契约：模型按 PLAN_MODE_PROMPT 加了 <proposed_plan> 标记，渲染端必须认得，
// 否则尖括号会作为字面文本显示给用户（比不加标记更糟）。
describe("方案块渲染（<proposed_plan> 契约）", () => {
  it("包成 .md-plan，标签本身不出现在输出里", () => {
    const html = render(`${PLAN_BLOCK_OPEN}\n## 方案\n1. 第一步\n${PLAN_BLOCK_CLOSE}`);
    expect(html).toContain("md-plan");
    expect(html).not.toContain("proposed_plan");
  });

  it("块内 markdown 照常渲染（标题与有序列表都不丢）", () => {
    const html = render(`${PLAN_BLOCK_OPEN}\n## 方案标题\n\n1. 搜价格\n2. 出表格\n${PLAN_BLOCK_CLOSE}`);
    expect(html).toContain("<h4>");
    expect(html).toContain("<ol>");
    expect(html).toContain("搜价格");
  });

  it("未闭合也能渲染（流式途中先出现开标签，不该等到闭合才成型）", () => {
    const html = render(`${PLAN_BLOCK_OPEN}\n## 写到一半`);
    expect(html).toContain("md-plan");
    expect(html).not.toContain("proposed_plan");
  });

  it("块外内容不受影响（前后段落照常输出）", () => {
    const html = render(`前面的话\n\n${PLAN_BLOCK_OPEN}\n方案正文\n${PLAN_BLOCK_CLOSE}\n\n后面的话`);
    expect(html).toContain("前面的话");
    expect(html).toContain("后面的话");
    expect(html).toContain("方案正文");
  });

  it("普通文本里提到该标签不被特殊对待（只认独占一行的标记）", () => {
    const html = render("这是一段提到 <proposed_plan> 字样的普通说明文字。");
    expect(html).not.toContain("md-plan");
  });
});

// 会话容量裁剪：回收站里的会话必须保留（"7 天内可恢复"的承诺不能被容量上限打破）。
// 与主进程 trimHistory / TaskStore.write 对 deletedAt 的处理保持一致。
describe("capSessions 容量裁剪", () => {
  const now = Date.now();
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  const make = (id: string, ageMs: number, extra: Record<string, unknown> = {}) =>
    ({ id, title: id, createdAt: at(ageMs), updatedAt: at(ageMs), messages: [], ...extra }) as never;

  it("未超上限时原样返回（同一个引用，避免无谓重渲染）", async () => {
    const { capSessions } = await import("./App");
    const list = [make("a", 1000)];
    expect(capSessions(list, [])).toBe(list);
  });

  it("回收站会话不被容量上限淘汰（即使它很旧）", async () => {
    const { capSessions } = await import("./App");
    const actives = Array.from({ length: 60 }, (_, i) => make(`a${i}`, i * 1000));
    const deleted = Array.from({ length: 5 }, (_, i) => make(`d${i}`, 6 * 86_400_000, { deletedAt: at(6 * 86_400_000) }));
    const kept = capSessions([...actives, ...deleted], []);
    expect(kept.filter((s) => (s as { deletedAt?: string }).deletedAt)).toHaveLength(5);
  });

  it("正在生成的会话不被淘汰", async () => {
    const { capSessions } = await import("./App");
    const actives = Array.from({ length: 60 }, (_, i) => make(`a${i}`, i * 1000));
    const kept = capSessions(actives, ["a59"]);
    expect(kept.some((s) => s.id === "a59")).toBe(true);
  });
});

// 回归：文字后紧跟表格时，表格不能被并进段落（否则整张表渲染成一堆竖线）。
describe("markdown 表格紧随段落", () => {
  it("段落后的表格仍渲染为 <table>", () => {
    const html = render("下面是对比：\n| 名称 | 价格 |\n|---|---|\n| A | 1 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>名称</th>");
    expect(html).toContain("<td>A</td>");
  });

  it("段落本身仍保留", () => {
    const html = render("下面是对比：\n| 名称 | 价格 |\n|---|---|\n| A | 1 |");
    expect(html).toContain("下面是对比");
  });

  it("单元格里的转义竖线不被当作分隔符", () => {
    // 注意用 \\| —— JS 字符串里 '\|' 会退化成 '|'，那样测的就不是转义了。
    const html = render("| 组合 | 说明 |\n|---|---|\n| x\\|y | 含竖线 |");
    // 两列表头 + 两列数据；若错切会出现第三列
    expect((html.match(/<td>/g) || []).length).toBe(2);
    expect(html).toContain("x|y");
  });
});
