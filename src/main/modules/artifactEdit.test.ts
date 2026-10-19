import { describe, expect, it } from "vitest";
import { applyExactEdit, applyExactEdits, findMatchingLines, sliceWithLineNumbers, MAX_READ_LINES, MAX_READ_CHARS } from "./artifactEdit";

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

  // 实测性能事故：600KB 产物里模式 `}` 命中 40,000 次，
  // 旧实现每处都从头数一遍换行（命中数 × 文件长度）→ **主进程同步阻塞 8.2 秒**，
  // 整个窗口卡死（渲染进程在等 IPC 回包），用户看到的是"软件没反应了"。
  // 模型给出过短的 oldText（`}` / `return`）就会触发，而这正是它最常犯的错。
  it("大量命中时仍然很快，且行号有上限", () => {
    const text = "function a(){if(x){return 1;}}".repeat(20_000); // 600KB，`}` 命中 4 万次
    const started = Date.now();
    const out = applyExactEdit(text, "}", ";");
    const elapsed = Date.now() - started;
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("ambiguous");
      expect(out.count).toBe(40_000);
      // 调用方只拼前 6 条进错误信息，多算的没人用。
      expect(out.lines.length).toBeLessThanOrEqual(20);
    }
    expect(elapsed).toBeLessThan(500);
  });

  it("行号仍然正确（批量翻译不能数错）", () => {
    const out = applyExactEdit("a\nb\nmatch\nd\nmatch\ne", "match", "x");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.lines).toEqual([3, 5]);
  });

  // 实测复现：`read_artifact` 返回的是 `    42| const a = 1;`，
  // 模型照抄进 oldText 时连着行号一起复制（它看到的就是这段）。
  // 那不是文件内容 → 精确匹配必然失败 → 再读一遍再猜一遍。
  // 这是我们自己的输出格式挖的坑，理应在编辑这一侧替它剥掉。
  it("oldText 带着 read_artifact 的行号前缀也能改到", () => {
    const NL = String.fromCharCode(10);
    const file = ["const a = 1;", "const b = 2;"].join(NL);
    // 模型照抄读回结果（前导空格 + 行号 + | ）
    const copied = ["    1| const a = 1;", "    2| const b = 2;"].join(NL);
    const out = applyExactEdit(file, copied, "const a = 9;");
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.text).toBe("const a = 9;");
      // 必须告诉调用方"我替你剥了行号"，否则模型不知道发生了什么
      expect(out.strippedGutter).toBe(true);
    }
  });

  // 反向自检：产物里本来就可能有 `1| ` 这种文本（ASCII 表格、竖线分隔的笔记），
  // 不能因为第一行像行号就整段乱剥。
  it("普通文本（只有一行带竖线）不会被误当行号剥掉", () => {
    const NL = String.fromCharCode(10);
    const file = ["1| 这不是行号，是正文", "普通第二行"].join(NL);
    const out = applyExactEdit(file, file, "改掉了");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.strippedGutter).toBeUndefined();
  });

  // 实测复现：模型把**新内容也照抄成带行号的样子**（`newText = "    1| const a = 9;"`）。
  // 只剥 oldText 的话，那串 `    1| ` 会被**写进文件本身**——产物直接坏掉，
  // 而且下一轮读回时模型看到的就是这段脏内容。
  it("newText 也带行号前缀时一并剥掉（不能写进文件）", () => {
    const NL = String.fromCharCode(10);
    const file = ["const a = 1;", "const b = 2;"].join(NL);
    const out = applyExactEdit(file, "    1| const a = 1;", "    1| const a = 9;");
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.text).toBe(`const a = 9;${NL}const b = 2;`);
      expect(out.text).not.toContain("|");
    }
  });

  // 反向自检：只有**一半以上**的行带行号时才剥，普通正文不许被动。
  it("普通正文里的竖线在 newText 里也保留（不误剥）", () => {
    const NL = String.fromCharCode(10);
    const file = ["1| 不是行号", "2| 也是正文"].join(NL);
    const out = applyExactEdit(file, "2| 也是正文", "2| 改过了");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.text).toBe(`1| 不是行号${NL}2| 改过了`);
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

  // 实测复现：文件是 LF、模型给的 newText 是 CRLF 时，直接拼会写出**混合行尾**
  // （`a\nB1\r\nB2\nc`）。下一次读回时 `\r` 藏在行尾、显示出来看不见，
  // 模型照抄的 oldText 少了它，于是匹配不上——它只会以为"改错地方了"，反复重读。
  it("newText 的行尾对齐文件（LF 文件不混进 CRLF）", () => {
    const NL = String.fromCharCode(10);
    const CR = String.fromCharCode(13);
    const out = applyExactEdit(`a${NL}b${NL}c`, "b", `B1${CR}${NL}B2`);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.text).toBe(`a${NL}B1${NL}B2${NL}c`);
      expect(out.text).not.toContain(CR);
    }
  });

  it("CRLF 文件保持 CRLF（不把原有格式改成 LF）", () => {
    const NL = String.fromCharCode(10);
    const CR = String.fromCharCode(13);
    const out = applyExactEdit(`a${CR}${NL}b${CR}${NL}c`, "b", `B1${NL}B2`);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.text).toBe(`a${CR}${NL}B1${CR}${NL}B2${CR}${NL}c`);
  });

  // 实测复现：**行尾归一那条分支**（oldText 用 LF、文件是 CRLF）原先把归一化后的
  // 全文直接写回，等于把整个 CRLF 文件**静默改成 LF**。
  // 上面那条只覆盖了"直接命中"的分支，这条覆盖归一分支。
  it("归一分支也保持 CRLF（不能把整个文件改成 LF）", () => {
    const NL = String.fromCharCode(10);
    const CR = String.fromCharCode(13);
    const out = applyExactEdit(`a${CR}${NL}b${CR}${NL}c`, `a${NL}b`, `A${NL}B`);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.text).toBe(`A${CR}${NL}B${CR}${NL}c`);
      expect(/[^\r]\n/.test(out.text)).toBe(false); // 没有裸 LF
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

  // 实测：endLine < startLine（范围写反）夹成一行，而调用方的 `truncated` 分支
  // 会说"还有 N 行没显示"——那 N 行其实在范围**之前**。
  // 模型据此以为自己没读到结尾，会反复换范围重读。
  it("范围写反时标出 reversed（调用方据此解释，而不是说'还有 N 行没显示'）", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
    const out = sliceWithLineNumbers(text, 8, 3);
    expect(out.reversed).toBe(true);
    expect(out.from).toBe(8);
    expect(out.to).toBe(8);
  });

  it("正常范围与不传 endLine 都不标 reversed", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
    expect(sliceWithLineNumbers(text, 3, 8).reversed).toBe(false);
    expect(sliceWithLineNumbers(text, 5).reversed).toBe(false);
    expect(sliceWithLineNumbers(text, 5, 5).reversed).toBe(false);
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

// 实测动因：模型一次修 5 处 bug，单处 edit 吃 5 步预算，叠加 10 步上限后任务被打断。
// 批量版对齐 Codex `apply_patch` 一次提交多个 hunk——但必须**全成功才写盘**。
describe("applyExactEdits（批量，原子）", () => {
  const source = "let a = 1;\nlet b = 2;\nlet c = 3;";

  it("多处全部命中时一起改，并回报各自行号", () => {
    const out = applyExactEdits(source, [
      { oldText: "let a = 1;", newText: "let a = 10;" },
      { oldText: "let c = 3;", newText: "let c = 30;" }
    ]);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.text).toBe("let a = 10;\nlet b = 2;\nlet c = 30;");
      expect(out.lines).toEqual([1, 3]);
    }
  });

  it("任意一条失败 → 整批不返回文本（调用方不会写盘）", () => {
    const out = applyExactEdits(source, [
      { oldText: "let a = 1;", newText: "let a = 10;" },
      { oldText: "不存在的行", newText: "x" }
    ]);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.index).toBe(1);
      expect(out.reason).toBe("not-found");
      expect(out).not.toHaveProperty("text");
    }
  });

  it("歧义失败时报出是第几条 + 命中行号", () => {
    const dup = "M.identity;\nok\nM.identity;";
    const out = applyExactEdits(dup, [
      { oldText: "M.identity", newText: "M.ident" }
    ]);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.index).toBe(0);
      expect(out.reason).toBe("ambiguous");
      expect(out.lines).toEqual([1, 3]);
    }
  });

  it("顺序应用：后一条基于前一条改过的文本匹配", () => {
    // 第一条把 old 改成 new，第二条匹配的正是改后的内容——若并发/乱序就会失败。
    const out = applyExactEdits("const x = old;", [
      { oldText: "old", newText: "new" },
      { oldText: "const x = new;", newText: "const x = final;" }
    ]);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.text).toBe("const x = final;");
  });
});

// 真机证据：模型猜错 oldText（缩进差两格）后只收到一句"找不到"，
// 于是又读 400 行、再猜一次——单轮重复了 4 次，20 步预算全烧在这上面。
// 失败时给出"最接近的行"，它就能直接照抄准确片段，一轮收敛。
describe("找不到原文时给出最接近的行", () => {
  const NL = String.fromCharCode(10);
  const source = ["function draw() {", "  var M = {};", "  M.identity();", "}"].join(NL);

  it("缩进记错 → not-found，并带上含关键标识符的候选行", () => {
    const out = applyExactEdit(source, "      M.identity();", "      M.ident();");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("not-found");
      expect(out.hints?.length).toBeGreaterThan(0);
      // 候选必须指向真实那一行，且内容是原文（模型要照抄它）
      expect(out.hints?.[0].line).toBe(3);
      expect(out.hints?.[0].text).toContain("M.identity");
    }
  });

  it("候选最多 3 条", () => {
    const many = ["  M.identity();", "   M.identity();", "    M.identity();", "     M.identity();"].join(NL);
    // 6 个空格缩进在文件里不存在 → not-found
    const out = applyExactEdit(many, "      M.identity();", "x");
    expect(out.ok).toBe(false);
    if (!out.ok) expect((out.hints ?? []).length).toBeLessThanOrEqual(3);
  });

  it("没有任何共同片段时不硬凑候选", () => {
    const out = applyExactEdit("nothing relevant here", "zzz", "x");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.hints).toEqual([]);
  });

  it("批量版也会把候选行带出来（第几条 + 候选）", () => {
    const out = applyExactEdits(source, [
      { oldText: "var M = {};", newText: "var M = { ok: 1 };" },
      { oldText: "      M.identity();", newText: "      M.ident();" }
    ]);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.index).toBe(1);
      expect(out.reason).toBe("not-found");
      expect(out.hints?.[0].text).toContain("M.identity");
    }
  });

  // 批量版走的是同一个 applyExactEdit（会剥行号），但**这条信息原本被丢在返回值里**：
  // 模型整批都抄了行号、居然全部成功，却一个字都没被告知"你抄错了"，下一批还会继续抄。
  // 单处编辑那条路早就会提示，批量这条漏了。
  it("批量版也把「替你剥了行号」这条信息传上来", () => {
    const NL = String.fromCharCode(10);
    const file = ["const a = 1;", "const b = 2;"].join(NL);
    const out = applyExactEdits(file, [
      { oldText: "    1| const a = 1;", newText: "const a = 9;" },
      { oldText: "    2| const b = 2;", newText: "const b = 8;" }
    ]);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.strippedGutter).toBe(true);
      expect(out.text).toBe("const a = 9;" + NL + "const b = 8;");
    }
  });

  it("没有行号前缀时不误标 strippedGutter", () => {
    const out = applyExactEdits("const x = old;", [
      { oldText: "old", newText: "new" },
      { oldText: "const x", newText: "let x" }
    ]);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.strippedGutter).toBeUndefined();
  });
});

// 实测真机：模型要找某个函数在哪，却没有搜索能力，把 2118 行的文件按 400 行一段
// 连读 5 次（步骤条上 5 行"读取文件完成（共 2118 行）"），光找位置就吃掉 5 步。
// 给它"按关键词定位"，一步就能拿到命中行 + 上下文。
describe("按关键词定位（findMatchingLines）", () => {
  const NL = String.fromCharCode(10);
  const src = [
    "function a() {",        // 1
    "  return 1;",           // 2
    "}",                     // 3
    "function b() {",        // 4
    "  return M.identity;",  // 5
    "}"                      // 6
  ].join(NL);

  it("命中时返回行号与上下文", () => {
    const out = findMatchingLines(src, "M.identity");
    expect(out.total).toBe(1);
    expect(out.matches[0].line).toBe(5);
    expect(out.body).toContain("M.identity");
    // 上下文应包含相邻行
    expect(out.body).toContain("function b()");
  });

  it("没有命中时返回 0 条（调用方据此提示换个片段）", () => {
    const out = findMatchingLines(src, "notThere");
    expect(out.total).toBe(0);
    expect(out.matches).toEqual([]);
  });

  it("多处命中时全部列出", () => {
    const out = findMatchingLines(src, "function");
    expect(out.total).toBe(2);
    expect(out.matches.map((m) => m.line)).toEqual([1, 4]);
  });

  it("区分大小写（模型该给准确标识符）", () => {
    expect(findMatchingLines(src, "m.identity").total).toBe(0);
  });

  // 实测：模型常把 `SPEED` 写成 `speed`。匹配刻意区分大小写（它给的多半是标识符原文），
  // 但**必须数一下"忽略大小写能命中几行"**——只说"换个片段试试"，它只会换个词再搜一次。
  it("大小写不同没命中时，报出忽略大小写能命中多少行", () => {
    const NL = String.fromCharCode(10);
    const file = ["const SPEED = 3;", "if (Speed > 1) { run(); }"].join(NL);
    const out = findMatchingLines(file, "speed");
    expect(out.total).toBe(0);
    expect(out.caseOnly).toBe(2);
  });

  it("能精确命中时 caseOnly 保持 0（不做多余扫描的结论）", () => {
    expect(findMatchingLines(src, "M.identity").caseOnly).toBe(0);
  });

  // 实测复现：模型把读回的一整行（含 `    2| ` 行号栏）整段当 keyword 抄进来。
  // 那不是文件内容，`includes` 永远命中不了——它只会再换一个片段再搜一次。
  // 这是 oldText / newText 那条坑的**第三处**（两处已修）。
  it("keyword 带着行号前缀时自动剥掉再搜，并标出 strippedGutter", () => {
    const NL = String.fromCharCode(10);
    const file = ["const a = 1;", "const b = 2;"].join(NL);
    const out = findMatchingLines(file, "    2| const b = 2;");
    expect(out.total).toBe(1);
    expect(out.matches[0].line).toBe(2);
    expect(out.strippedGutter).toBe(true);
  });

  it("干净 keyword 不误标 strippedGutter", () => {
    expect(findMatchingLines(src, "M.identity").strippedGutter).toBe(false);
  });

  it("空关键词返回空结果（不匹配每一行）", () => {
    const out = findMatchingLines(src, "");
    expect(out.total).toBe(0);
    expect(out.body).toBe("");
  });

  it("找不到时的候选行围绕命中的词截断（超长单行也给得出线索）", () => {
    // 实测复现：一行 18 万字符、标识符在正中间。旧实现把整行原样返回，
    // 调用方从头截 160 字 → 全是 `x`，提示里看不到模型要找的标识符。
    const line = "x".repeat(90_000) + "M.identity(); // ok" + "y".repeat(90_000);
    const out = applyExactEdit(`<script>${line}</script>`, "M.identity(); // 错了", "改");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.hints?.[0].text).toContain("M.identity");
      expect(out.hints?.[0].text.length).toBeLessThan(400);
    }
  });

  it("候选行不会因为 trim 把窗口挪偏（前导空白很长的行）", () => {
    const line = " ".repeat(5_000) + "targetSymbol()" + "z".repeat(50_000);
    const out = applyExactEdit(line, "targetSymbol(1)", "改");
    if (!out.ok) expect(out.hints?.[0].text).toContain("targetSymbol");
  });

  it("受 limit 限制但 total 仍报真实总数", () => {
    const many = Array.from({ length: 30 }, (_, i) => `hit ${i}`).join(NL);
    const out = findMatchingLines(many, "hit", 5);
    expect(out.matches).toHaveLength(5);
    expect(out.total).toBe(30);
  });

  // 实测复现：600KB 的压缩 HTML（一行 600,000 字符）里 locate 一个标识符，
  // 上下文"前后各 2 行"其实就是整行 → 返回 600,034 字符，
  // 是 MAX_READ_CHARS 的 10 倍（约 15 万 token），一次读爆上下文。
  // sliceWithLineNumbers 早有这道闸门，keyword 分支漏了。
  it("超长单行：命中行按 needle 居中截断，仍能看到 needle", () => {
    const line = "a".repeat(50_000) + "NEEDLE" + "b".repeat(50_000);
    const out = findMatchingLines(line, "NEEDLE");
    expect(out.total).toBe(1);
    expect(out.body).toContain("NEEDLE");
    expect(out.body.length).toBeLessThan(2_000);
    // **必须显式标记节选**：产物正文本来就可能含「…」，
    // 靠 body 里有没有省略号判断会漏报；模型把节选当原文抄，oldText 必然匹配不上。
    expect(out.lineCapped).toBe(true);
  });

  it("正常长度的文件不标 lineCapped", () => {
    expect(findMatchingLines(src, "M.identity").lineCapped).toBe(false);
  });

  it("整体输出超 MAX_READ_CHARS 时再截一次并标记 charCapped", () => {
    // 每行都在「按行截断」阈值（400）以内，所以行级截断救不了——
    // 只有命中条数够多时总量才会超，这正是第二道闸门要拦的形状。
    const lines: string[] = [];
    for (let i = 0; i < 200; i += 1) lines.push("HIT" + "x".repeat(350));
    const out = findMatchingLines(lines.join(NL), "HIT", 200);
    expect(out.charCapped).toBe(true);
    expect(out.body.length).toBeLessThanOrEqual(MAX_READ_CHARS + 10);
  });

  it("单行超长但总量不超时，不需要标 charCapped（行级截断已够）", () => {
    const line = "a".repeat(50_000) + "NEEDLE" + "b".repeat(50_000);
    expect(findMatchingLines(line, "NEEDLE").charCapped).toBe(false);
  });
});

// 实测：真实产物 1757 行、最长单行 169 字符，行数上限够用；
// 但压缩过的 HTML / 超宽 CSV 可以是"一行几十万字符"——
// 400 行 × 单行 5000 字符 ≈ 200 万字符 ≈ 57 万 token，一次读爆上下文。
// 行数只是看起来合理的护栏，字符数才决定真实占用。
describe("读回时的字符上限（防超长单行）", () => {
  const NL = String.fromCharCode(10);

  it("超长单行被字符数截断，并标记 charCapped", () => {
    const text = Array.from({ length: 10 }, () => "x".repeat(20_000)).join(NL);
    const out = sliceWithLineNumbers(text);
    expect(out.charCapped).toBe(true);
    expect(out.body.length).toBeLessThanOrEqual(MAX_READ_CHARS + 10); // sliceSafe 可能多留几个字符
  });

  // 实测复现：200 行 × 2000 字符的文件，按 60K 上限只装得下 ~30 行，
  // 而回执标题照旧写"本次显示第 1–200 行"。模型据此以为拿到了 200 行，
  // 下一次从第 201 行接着读——中间 170 行被**静默跳过**。
  //
  // 语义取舍：`to` 取**最后一个完整的行**。被切在半路的那一行算"没读完"，
  // 下次从 `to + 1` 续读最多重复一行（重叠无害），而按半截行算 `to` 会让最后那段
  // 被切掉的内容永远拿不到（漏读有害）。宁可重叠，不可跳过。
  it("字符截断后 to 必须是最后一个**完整**行，不能声称返回了请求的全部行", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line${i}:`.padEnd(10, " ") + "x".repeat(1990));
    const out = sliceWithLineNumbers(lines.join(NL), 1, 200);
    expect(out.charCapped).toBe(true);
    expect(out.to).toBeLessThan(200);
    expect(out.truncated).toBe(true);

    const kept = out.body.split(NL);
    const lastRendered = kept[kept.length - 1];
    // 末行一定是被切过的（不完整）——所以它不算"已读到"
    expect(lastRendered.length).toBeLessThan(2000);
    const lastRenderedNo = Number(/^\s*(\d+)\|/.exec(lastRendered)?.[1]);
    expect(out.to).toBe(lastRenderedNo - 1);
  });

  // 反向自检：没触发字符截断时，范围就是请求的范围（不能被上一处的逻辑改坏）。
  it("未触发字符截断时 to 等于请求的 endLine", () => {
    const out = sliceWithLineNumbers("a\nb\nc\nd", 2, 3);
    expect(out).toMatchObject({ from: 2, to: 3, charCapped: false });
  });

  it("正常文件不触发字符截断", () => {
    const out = sliceWithLineNumbers("a" + NL + "b" + NL + "c");
    expect(out.charCapped).toBe(false);
    expect(out.body).toContain("a");
  });

  it("一次读 400 行普通行时总量也在上限内", () => {
    const text = Array.from({ length: 1000 }, (_, i) => `line ${i} ` + "y".repeat(100)).join(NL);
    const out = sliceWithLineNumbers(text);
    expect(out.charCapped).toBe(false);
    expect(out.body.length).toBeLessThan(MAX_READ_CHARS);
  });
});
