import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown } from "./markdown";
import { normalizeStoredSessions, extractArtifact, foldArtifactVersions, stripTransientForPersist } from "./App";
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

  // 递归深度必须有上限：这段文本来自模型输出，可被提示注入诱导写出成百上千个开标签。
  // 实测（probe-plan-depth，复刻同一段逻辑）1000 层直接栈溢出——
  // 溢出发生在渲染期，表现是**整个游乐场页白屏**，且刷新后会立刻复发（坏文本存在历史里）。
  it("深层嵌套的 <proposed_plan> 不栈溢出（超限按普通文本渲染）", () => {
    const depth = 2_000;
    const text = `${PLAN_BLOCK_OPEN}\n`.repeat(depth) + "正文" + `\n${PLAN_BLOCK_CLOSE}`.repeat(depth);
    expect(() => render(text)).not.toThrow();
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

  // 重复 id 来自并发写盘 / 手改 / 从别的窗口导入。后果都在"按 id 操作"的地方：
  // `key={session.id}` 让 React 复用错元素；删除/恢复是 `filter(s => s.id !== id)`，
  // 一次操作会作用到两条。这里锁定"保留第一次出现的那个"。
  it("重复的会话 id 被去重（保留第一条）", () => {
    const result = normalizeStoredSessions([
      { id: "dup", title: "第一条", messages: [] },
      { id: "dup", title: "第二条", messages: [] },
      { id: "ok", title: "正常", messages: [] }
    ]);
    expect(result.map((s) => s.id)).toEqual(["dup", "ok"]);
    expect(result[0].title).toBe("第一条");
  });

  it("重复的消息 id 被去重；缺 id 的补一个（否则 React key 是 undefined）", () => {
    const result = normalizeStoredSessions([{
      id: "a",
      messages: [
        { id: "m1", role: "user", content: "甲" },
        { id: "m1", role: "assistant", content: "乙" },
        { role: "assistant", content: "无 id" }
      ]
    }]);
    const ids = result[0].messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    // 重复的那条被丢掉：只剩 [m1, 无 id 那条补出来的 id]。
    expect(ids[0]).toBe("m1");
    expect(ids[1]).toMatch(/^legacy-/);
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

  it("messages 里的非对象元素被丢弃（字符串按字符展开会变成垃圾消息）", () => {
    const result = normalizeStoredSessions([{ id: "a", messages: ["hi", 42, null, { role: "user", content: "好" }] }]);
    expect(result[0].messages).toHaveLength(1);
    expect(result[0].messages[0].content).toBe("好");
  });

  it("taskIds 非数组时不被包成「一组装一个字符串」（否则渲染端 map 白屏）", () => {
    const result = normalizeStoredSessions([{ id: "a", messages: [{ role: "assistant", content: "x", taskIds: "abc" }] }]);
    expect(result[0].messages[0].taskGroups).toBeUndefined();
  });

  it("taskIds 是合法数组时照常迁移为单组", () => {
    const result = normalizeStoredSessions([{ id: "a", messages: [{ role: "assistant", content: "x", taskIds: ["t1", "t2"] }] }]);
    expect(result[0].messages[0].taskGroups).toEqual([["t1", "t2"]]);
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

  // 只判"是不是数组"不够：元素是对象时 `{entry.step}` 会抛
  // "Objects are not valid as a React child" → 整个游乐场页白屏。
  it("planSteps 数组里的非对象/缺 step 元素被剔除", () => {
    const result = normalizeStoredSessions([{
      id: "a",
      messages: [{
        role: "assistant", content: "x",
        planSteps: [{ step: "第一步", status: "completed" }, "bad", 42, null, { status: "pending" }]
      }]
    }]);
    expect(result[0].messages[0].planSteps).toEqual([{ step: "第一步", status: "completed" }]);
  });

  it("artifacts 数组里缺 name/path 的元素被剔除", () => {
    const result = normalizeStoredSessions([{
      id: "a",
      messages: [{
        role: "assistant", content: "x",
        artifacts: [
          { name: "a.md", path: "/p/a.md", size: 1, kind: "doc" },
          { name: "缺路径.md" },
          { path: "/p/b.md" },
          "bad"
        ]
      }]
    }]);
    expect(result[0].messages[0].artifacts).toHaveLength(1);
    expect(result[0].messages[0].artifacts?.[0].name).toBe("a.md");
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

// 一次请求里模型「写→自检→修→重写」会留下多份同名文件（uniqueArtifactPath 加序号不覆盖）。
// 默认只展示最新一版，别让用户去读回复猜哪个是最终版。
describe("产物多版本折叠（foldArtifactVersions）", () => {
  it("同名文件的 (2)(3) 折成一组，最新的是最后一个", () => {
    const groups = foldArtifactVersions([
      { name: "鹈鹕骑自行车_3D.html" },
      { name: "鹈鹕骑自行车_3D (2).html" },
      { name: "鹈鹕骑自行车_3D (3).html" }
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].latest.name).toBe("鹈鹕骑自行车_3D (3).html");
    expect(groups[0].older.map((x) => x.name)).toEqual(["鹈鹕骑自行车_3D.html", "鹈鹕骑自行车_3D (2).html"]);
  });

  it("不同主名的文件不合并", () => {
    const groups = foldArtifactVersions([{ name: "报告.md" }, { name: "数据.csv" }]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.older.length === 0)).toBe(true);
  });

  it("同名但不是序号后缀的算不同文件（中间的括号属于文件名）", () => {
    const groups = foldArtifactVersions([{ name: "图表 (草稿).html" }, { name: "图表.html" }]);
    expect(groups).toHaveLength(2);
  });

  it("只有一个版本时 older 为空（渲染端据此不显示展开按钮）", () => {
    const groups = foldArtifactVersions([{ name: "单份.html" }]);
    expect(groups[0].older).toEqual([]);
    expect(groups[0].latest.name).toBe("单份.html");
  });

  it("分组顺序按首次出现，卡片位置不因新版本出现而跳动", () => {
    const groups = foldArtifactVersions([
      { name: "甲.html" },
      { name: "乙.md" },
      { name: "甲 (2).html" }
    ]);
    expect(groups.map((g) => g.latest.name)).toEqual(["甲 (2).html", "乙.md"]);
  });

  it("空列表返回空数组", () => {
    expect(foldArtifactVersions([])).toEqual([]);
  });
});

// 实测不一致：注释说 toolSteps / streaming 是"瞬态、读取时强制剥离"，
// 但写入侧一直没剥离——每条消息的工具日志被原样写进 localStorage（配额只有 5–10MB）。
describe("落盘前剥离瞬态字段（stripTransientForPersist）", () => {
  const base = (over: Record<string, unknown>) => ({
    id: "s1", title: "t", createdAt: "2026-10-19T00:00:00.000Z", updatedAt: "2026-10-19T00:00:00.000Z",
    // `role` 必须窄成字面量类型，否则整个对象不满足 PlaygroundSession（TS2322）。
    messages: [{ id: "m1", role: "assistant" as const, content: "hi", ...over }]
  });

  it("toolSteps 不落盘（内存态不动，只影响写的拷贝）", () => {
    const out = stripTransientForPersist([base({ toolSteps: ["→ 正在搜索：x", "✓ 找到 3 条结果"] })]);
    expect(out[0].messages[0].toolSteps).toBeUndefined();
    expect(out[0].messages[0].content).toBe("hi");
  });

  it("streaming 标记不落盘", () => {
    const out = stripTransientForPersist([base({ streaming: true })]);
    expect(out[0].messages[0].streaming).toBeUndefined();
  });

  it("没有瞬态字段的消息**原样返回同一个引用**（避免无谓复制）", () => {
    const input = [base({})];
    expect(stripTransientForPersist(input)[0].messages[0]).toBe(input[0].messages[0]);
  });

  it("其它字段与 artifacts 完整保留", () => {
    const artifacts = [{ name: "a.html", path: "p", size: 1, kind: "html" }];
    const out = stripTransientForPersist([base({ artifacts, toolSteps: ["x"] })]);
    expect(out[0].messages[0].artifacts).toEqual(artifacts);
    expect(out[0].title).toBe("t");
  });

  // 实测形状：挂起的选择题靠主进程内存里的 questionBridge 兑现，
  // 重启后 requestId 全部失效——卡片留在界面上，点了只会得到"已超时或结束"。
  // 一个永远点不动的控件比没有更糟，所以两端都要剥。
  it("questions 不落盘（重启后点不动的卡片）", () => {
    const questions = { requestId: "r1", questions: [{ id: "q", header: "时长", question: "要几秒？", options: [{ id: "a", label: "6 秒", description: "短" }] }] };
    const out = stripTransientForPersist([base({ questions })]);
    expect(out[0].messages[0].questions).toBeUndefined();
  });

  it("读取侧也会剥掉旧版本写进去的 questions", () => {
    const questions = { requestId: "r1", questions: [] };
    const result = normalizeStoredSessions([{ id: "s", messages: [{ id: "m", role: "assistant", content: "x", questions }] }]);
    expect(result[0].messages[0].questions).toBeUndefined();
  });
});

// 实测缺陷：围栏只认三个反引号时，用**四个反引号**包住三个反引号的代码块
// （官方 Markdown 用来"在正文里教别人写代码块"的标准写法）会渲染成两个空代码块，
// 中间那行正文落到外面变成普通段落。模型写"怎么用 markdown"这类文档时几乎一定会这么写。
describe("围栏代码块（长度可变）", () => {
  it("四个反引号能包住三个反引号的示例", () => {
    const html = render(["````md", "```js", "const a = 1;", "```", "````"].join("\n"));
    expect(html).toContain("md-code");
    expect(html).toContain("```js");
    expect(html).toContain("const a = 1;");
    // 不能渲染成两个空代码块
    expect(html).not.toContain("<code></code>");
  });

  it("普通三个反引号行为不变（语言标记仍被识别）", () => {
    const html = render("```js\nconst a = 1;\n```");
    expect(html).toContain('data-lang="js"');
    expect(html).toContain("const a = 1;");
  });

  it("未闭合的围栏（流式途中）照常按代码块渲染", () => {
    const html = render("说明：\n```js\nconst a = 1;");
    expect(html).toContain("md-code");
    expect(html).toContain("说明：");
  });
});
