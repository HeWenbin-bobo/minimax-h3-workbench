import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown } from "./markdown";

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
