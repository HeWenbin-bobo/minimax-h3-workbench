import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown } from "./markdown";
import { normalizeStoredSessions, extractArtifact } from "./App";
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

  // 回归：回收站会话数量超过上限时，不能把**活跃**会话全挤掉。
  // （第一版把回收站也算进名额，room 被压成 0，活跃会话全灭。）
  it("回收站会话数超过上限时，活跃会话仍按上限保留", async () => {
    const { capSessions } = await import("./App");
    const actives = Array.from({ length: 5 }, (_, i) => make(`a${i}`, i * 1000));
    const deleted = Array.from({ length: 60 }, (_, i) => make(`d${i}`, 6 * 86_400_000, { deletedAt: at(6 * 86_400_000) }));
    const kept = capSessions([...actives, ...deleted], []);
    expect(kept.filter((s) => !(s as { deletedAt?: string }).deletedAt)).toHaveLength(5);
    expect(kept.filter((s) => (s as { deletedAt?: string }).deletedAt)).toHaveLength(60);
  });

  it("活跃会话超过上限时按最近使用裁到上限", async () => {
    const { capSessions } = await import("./App");
    const actives = Array.from({ length: 60 }, (_, i) => make(`a${i}`, i * 1000)); // a0 最新
    const kept = capSessions(actives, []);
    expect(kept).toHaveLength(50);
    expect(kept.some((s) => s.id === "a0")).toBe(true);
    expect(kept.some((s) => s.id === "a59")).toBe(false);
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

// GFM 允许省略表格外侧竖线（`a | b`），模型常这么写；但正文里的竖线不能被误当分隔符。
describe("markdown 表格：外侧竖线可选", () => {
  it("省略外侧竖线的表格仍渲染为 <table>", () => {
    const html = render("a | b\n---|---\n1 | 2");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
  });

  it("只省略左侧竖线也能识别", () => {
    const html = render("a | b |\n---|---|\n1 | 2 |");
    expect(html).toContain("<table>");
  });

  it("正文里的竖线不被误判为表格", () => {
    const html = render("价格是 100 元|台\n选项 A|B 都不对");
    expect(html).not.toContain("<table>");
    expect(html).toContain("价格是 100 元|台");
  });
});

// 会话读取容错：一条坏数据不能让**全部**会话消失。
// 旧实现直接对数组 map 并靠外层 catch 兜底，数组里出现 null/非对象时
// `session.messages` 立刻抛错 → 外层 catch 返回 []，用户的全部对话一次性清空。
describe("normalizeStoredSessions 坏数据容错", () => {
  it("坏元素被跳过，正常会话全部保留", () => {
    const result = normalizeStoredSessions([
      { id: "a", title: "甲", messages: [{ role: "user", content: "hi" }] },
      null,
      "坏数据",
      { id: "b", title: "乙", messages: [] }
    ]);
    expect(result.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("非数组输入返回空数组（不抛错）", () => {
    for (const bad of [null, undefined, 42, "x", {}]) {
      expect(normalizeStoredSessions(bad)).toEqual([]);
    }
  });

  it("messages 非数组时当作空会话，其它字段仍保留", () => {
    const result = normalizeStoredSessions([{ id: "a", title: "甲", messages: "坏" }]);
    expect(result).toHaveLength(1);
    expect(result[0].messages).toEqual([]);
    expect(result[0].title).toBe("甲");
  });

  it("残留 streaming 标记被清掉（重启后不留闪烁光标）", () => {
    const result = normalizeStoredSessions([
      { id: "a", messages: [{ role: "assistant", content: "半截", streaming: true }] }
    ]);
    expect(result[0].messages[0].streaming).toBe(false);
  });

  it("旧数据扁平 taskIds 迁移成单组 taskGroups", () => {
    const result = normalizeStoredSessions([{ id: "a", messages: [{ role: "assistant", content: "x", taskIds: ["t1", "t2"] }] }]);
    expect(result[0].messages[0].taskGroups).toEqual([["t1", "t2"]]);
    expect(result[0].messages[0].taskIds).toBeUndefined();
  });
});

// content 类型兜底：主进程会调 `.trim()` / `.match()`，非字符串会抛英文技术错误。
describe("normalizeStoredSessions 消息 content 类型兜底", () => {
  it("数字/对象 content 被转成字符串，不留给下游抛错", () => {
    const result = normalizeStoredSessions([
      { id: "a", messages: [{ role: "user", content: 123 }, { role: "assistant", content: { x: 1 } }] }
    ]);
    expect(result[0].messages[0].content).toBe("123");
    expect(typeof result[0].messages[1].content).toBe("string");
  });

  it("null / undefined content 变空串（下游按空消息处理，不是崩溃）", () => {
    const result = normalizeStoredSessions([{ id: "a", messages: [{ role: "user", content: null }, { role: "user" }] }]);
    expect(result[0].messages[0].content).toBe("");
    expect(result[0].messages[1].content).toBe("");
  });

  it("正常字符串原样保留（不改变既有内容）", () => {
    const result = normalizeStoredSessions([{ id: "a", messages: [{ role: "user", content: "你好\n世界" }] }]);
    expect(result[0].messages[0].content).toBe("你好\n世界");
  });
});

// deletedAt 非法时：回收站显示「NaN 天后自动清除」，且永远不会被过期清理
// （`Date.now() - NaN > 7 天` 恒为 false），白占 localStorage 配额。
describe("normalizeStoredSessions deletedAt 归一", () => {
  it("非法字符串被改成可解析时间（7 天计时能正常走）", () => {
    const before = Date.now();
    const result = normalizeStoredSessions([{ id: "a", messages: [], deletedAt: "abc" }]);
    const stamp = new Date(result[0].deletedAt!).getTime();
    expect(Number.isNaN(stamp)).toBe(false);
    expect(stamp).toBeGreaterThanOrEqual(before - 1000);
  });

  it("非字符串被改成可解析时间", () => {
    for (const bad of [123, {}, [], true]) {
      const result = normalizeStoredSessions([{ id: "a", messages: [], deletedAt: bad }]);
      expect(Number.isNaN(new Date(result[0].deletedAt!).getTime())).toBe(false);
    }
  });

  it("空值/缺失仍表示「未删除」（不误标成已删除）", () => {
    for (const value of [undefined, null, ""]) {
      const result = normalizeStoredSessions([{ id: "a", messages: [], deletedAt: value }]);
      expect(result[0].deletedAt).toBeUndefined();
    }
  });

  it("合法时间串原样保留", () => {
    const iso = "2026-10-01T00:00:00.000Z";
    const result = normalizeStoredSessions([{ id: "a", messages: [], deletedAt: iso }]);
    expect(result[0].deletedAt).toBe(iso);
  });
});

// 消息上的数组字段（images / taskGroups / planSteps / artifacts）在渲染端一律直接
// `.map()` / `.filter()`。非数组会让整个会话列表打不开（"xxx.map is not a function"）。
describe("normalizeStoredSessions 数组字段归一", () => {
  it("images 非数组时丢弃，不留给 <img src> 与多模态载荷", () => {
    const result = normalizeStoredSessions([{ id: "a", messages: [{ role: "user", content: "x", images: "a.jpg" }] }]);
    expect(result[0].messages[0].images).toBeUndefined();
  });

  it("images 数组里的非字符串项被剔除", () => {
    const result = normalizeStoredSessions([{ id: "a", messages: [{ role: "user", content: "x", images: ["a.jpg", 42, null] }] }]);
    expect(result[0].messages[0].images).toEqual(["a.jpg"]);
  });

  it("taskGroups 非数组时丢弃（旧的 taskIds 迁移仍生效）", () => {
    const bad = normalizeStoredSessions([{ id: "a", messages: [{ role: "assistant", content: "x", taskGroups: "g1" }] }]);
    expect(bad[0].messages[0].taskGroups).toBeUndefined();
    const migrated = normalizeStoredSessions([{ id: "a", messages: [{ role: "assistant", content: "x", taskIds: ["t1"] }] }]);
    expect(migrated[0].messages[0].taskGroups).toEqual([["t1"]]);
  });

  it("taskGroups 里混入非数组/空组会被过滤", () => {
    const result = normalizeStoredSessions([{ id: "a", messages: [{ role: "assistant", content: "x", taskGroups: [["t1"], "bad", [], [2, "t2"]] }] }]);
    expect(result[0].messages[0].taskGroups).toEqual([["t1"], ["t2"]]);
  });

  it("planSteps / artifacts 非数组时丢弃", () => {
    const result = normalizeStoredSessions([{ id: "a", messages: [{ role: "assistant", content: "x", planSteps: "p", artifacts: {} }] }]);
    expect(result[0].messages[0].planSteps).toBeUndefined();
    expect(result[0].messages[0].artifacts).toBeUndefined();
  });

  it("正常数组原样保留", () => {
    const result = normalizeStoredSessions([{
      id: "a",
      messages: [{
        role: "assistant", content: "x",
        images: ["a.jpg"],
        taskGroups: [["t1"]],
        planSteps: [{ step: "s", status: "completed" }],
        artifacts: [{ name: "a.md", path: "/p/a.md", size: 1, kind: "doc" }]
      }]
    }]);
    const msg = result[0].messages[0];
    expect(msg.images).toEqual(["a.jpg"]);
    expect(msg.taskGroups).toEqual([["t1"]]);
    expect(msg.planSteps).toHaveLength(1);
    expect(msg.artifacts).toHaveLength(1);
  });
});

// 产物围栏的语言标记必须收下 `md`：它是 create_file 的 kind 枚举值之一，
// 也是模型手写围栏时最常用的标记。漏掉时文档卡片静默不出现（用户只看到代码块），
// 与当年漏掉 `xlsx` 别名是同一类问题。
describe("extractArtifact 围栏语言别名", () => {
  it("```md 被识别为文档产物", () => {
    expect(extractArtifact("说明：\n```md\n# 标题\n正文\n```")).toEqual({ kind: "doc", content: "# 标题\n正文" });
  });

  it("```markdown / ```docx / ```doc 仍然可用", () => {
    for (const lang of ["markdown", "docx", "doc"]) {
      expect(extractArtifact("```" + lang + "\n正文\n```")?.kind).toBe("doc");
    }
  });

  it("```csv 有结构化数据时识别为表格，单行不成表", () => {
    expect(extractArtifact("```csv\na,b\n1,2\n```")?.kind).toBe("sheet");
    expect(extractArtifact("```csv\n只有一行\n```")).toBeUndefined();
  });

  it("```html 优先于其它围栏", () => {
    const text = "```csv\na,b\n1,2\n```\n\n```html\n<!DOCTYPE html><p>x</p>\n```";
    expect(extractArtifact(text)?.kind).toBe("html");
  });

  it("没有围栏的纯文本不产生产物", () => {
    expect(extractArtifact("这是一段普通回答。")).toBeUndefined();
  });
});
