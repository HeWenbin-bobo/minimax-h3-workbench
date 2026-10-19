import { describe, expect, it } from "vitest";
import { applyExactEdit, sliceWithLineNumbers, MAX_READ_LINES } from "./artifactEdit";

// 这些用例全部来自真机观察到的形态（鹈鹕案例）：
// 模型为改一处 `M.identity` 整份重写 40KB，改完仍是错的，且它无法核对。
// applyExactEdit 的职责就是**不给它改错的机会**：找不到不写、多处不写。
describe("applyExactEdit", () => {
  it("唯一命中时替换，并回报行号", () => {
    const text = "line1\nconst M = {}\nM.identity();\nline4";
    const out = applyExactEdit(text, "M.identity()", "M.ident()");
    expect(out).toMatchObject({ ok: true, line: 3 });
    if (out.ok) {
      expect(out.text).toContain("M.ident()");
      expect(out.text).not.toContain("M.identity");
      expect(out.text).toContain("line1");
      expect(out.text).toContain("line4");
    }
  });

  it("找不到就拒绝，不写任何东西", () => {
    const out = applyExactEdit("abc", "not-there", "x");
    expect(out).toMatchObject({ ok: false, reason: "not-found", count: 0 });
  });

  // 最关键的用例：文件里有两处同名标识符时，**拒绝**而不是改第一处。
  // 真机正是这个形态——原文件 2 处 `M.identity`，模型改完还剩 1 处。
  it("命中多处时拒绝，并回报每一处的行号", () => {
    const text = "M.identity;\nok\nM.identity;";
    const out = applyExactEdit(text, "M.identity", "M.ident");
    expect(out).toMatchObject({ ok: false, reason: "ambiguous", count: 2 });
    if (!out.ok) expect(out.lines).toEqual([1, 3]);
  });

  it("补上上下文后可以唯一定位（给模型的修正路径）", () => {
    const text = "a\nM.identity;\nok\nif (x) M.identity;";
    // 第一处单独成行，第二处前面有 if —— 带上上下文就唯一了。
    const out = applyExactEdit(text, "if (x) M.identity;", "if (x) M.ident;");
    expect(out).toMatchObject({ ok: true, line: 4 });
  });

  it("oldText 为空串直接拒绝（否则会到处插入）", () => {
    expect(applyExactEdit("abc", "", "x")).toMatchObject({ ok: false, reason: "empty-old" });
  });

  it("允许替换成空串（删除这一段）", () => {
    const out = applyExactEdit("keep\nDELETE ME\nkeep2", "DELETE ME\n", "");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.text).toBe("keep\nkeep2");
  });

  it("重叠模式被正确计数（不能低估命中数而放行）", () => {
    // "aa" 在 "aaa" 里出现 2 次（位置 0 与 1）→ 必须判为歧义。
    expect(applyExactEdit("aaa", "aa", "b")).toMatchObject({ ok: false, reason: "ambiguous", count: 2 });
  });

  it("CRLF 文件用 LF 的 oldText 也能改到（行尾归一）", () => {
    const text = "a\r\nM.identity();\r\nb";
    const out = applyExactEdit(text, "M.identity();", "M.ident();");
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.text).toContain("M.ident();");
      expect(out.text).not.toContain("M.identity");
    }
  });

  // 注意：单行子串本来就能在带缩进的行里命中（"indented();" 是 "  indented();" 的子串），
  // 这不是缺陷。真正要防的是**多行块**里的缩进对不上——那才会改错地方。
  it("多行块的行内缩进不一致时找不到（不做模糊匹配）", () => {
    const text = "function f() {\n  doThing();\n  return 1;\n}";
    // 模型把两行都写成顶格，但文件里第二行有缩进 → 找不到，而不是凑合改掉。
    expect(applyExactEdit(text, "function f() {\ndoThing();", "x")).toMatchObject({ ok: false, reason: "not-found" });
  });

  it("多行块缩进一致时正常命中", () => {
    const text = "function f() {\n  doThing();\n  return 1;\n}";
    const out = applyExactEdit(text, "  doThing();\n  return 1;", "  doThing();\n  return 2;");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.text).toContain("return 2;");
  });
});

describe("sliceWithLineNumbers", () => {
  it("默认从头读到尾，每行带行号", () => {
    const out = sliceWithLineNumbers("a\nb\nc");
    expect(out.totalLines).toBe(3);
    expect(out.body).toBe("    1| a\n    2| b\n    3| c");
  });

  it("按范围切片（含端点）", () => {
    const out = sliceWithLineNumbers("a\nb\nc\nd", 2, 3);
    expect(out).toMatchObject({ from: 2, to: 3 });
    expect(out.body).toBe("    2| b\n    3| c");
  });

  it("越界夹紧而不是报错（模型给个大范围也要拿到东西）", () => {
    const out = sliceWithLineNumbers("a\nb", 1, 9_999);
    expect(out).toMatchObject({ from: 1, to: 2 });
  });

  it("起始行超出末尾时退到最后一行", () => {
    const out = sliceWithLineNumbers("a\nb", 100, undefined);
    expect(out).toMatchObject({ from: 2, to: 2 });
  });
});

// 实测真机踩到：模型不带范围调用 read_artifact，拿到 1651 行全文，紧接着又读一遍。
// 提示词写了"一次别读整个文件"，但提示词不是护栏——代码必须有默认上限。
describe("read_artifact 的默认行数上限", () => {
  const bigFile = Array.from({ length: 1000 }, (_, i) => `line${i + 1}`).join("\n");

  it("不带范围时只返回前 MAX_READ_LINES 行，并标记被截断", () => {
    const out = sliceWithLineNumbers(bigFile);
    expect(out.from).toBe(1);
    expect(out.to).toBe(MAX_READ_LINES);
    expect(out.truncated).toBe(true);
    expect(out.totalLines).toBe(1000);
    expect(out.body.split("\n")).toHaveLength(MAX_READ_LINES);
  });

  it("显式给 endLine 时尊重它（可以在上限内任意取）", () => {
    const out = sliceWithLineNumbers(bigFile, 500, 520);
    expect(out).toMatchObject({ from: 500, to: 520, truncated: true });
  });

  it("小文件不截断", () => {
    const out = sliceWithLineNumbers("a\nb\nc");
    expect(out.truncated).toBe(false);
    expect(out.to).toBe(3);
  });

  it("从中间开始读时按上限往后取，而不是一口气读到末尾", () => {
    const out = sliceWithLineNumbers(bigFile, 900);
    expect(out.from).toBe(900);
    expect(out.to).toBe(1000); // 只剩 101 行，不到上限
    expect(out.truncated).toBe(false);
  });
});
