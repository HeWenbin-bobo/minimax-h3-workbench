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
