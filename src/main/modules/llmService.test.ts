import { describe, expect, it, vi } from "vitest";

// chatAgent 动态 import("ai")，用 mock 拦截以免真调模型；vi.hoisted 保证 mock 工厂可用。
const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }));
vi.mock("ai", () => ({
  streamText: streamTextMock,
  tool: (definition: unknown) => definition,
  stepCountIs: (count: number) => count
}));
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: () => ({ chatModel: (id: string) => ({ id }) })
}));

import { consumeSse, chatAgent, LlmService, resolveChatPath, rewriteChatEndpoint, humanizeToolInput, humanizeToolOutput, isToolFailure, normalizeAgentQuestions, type LlmServiceOptions } from "./llmService";

// 构造一个 ReadableStream，把字符串分块推送（模拟网络分包边界不齐）。
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
}

describe("consumeSse", () => {
  it("解析标准 SSE data 行并按序发送 delta", async () => {
    const received: string[] = [];
    await consumeSse(streamOf([
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
      "data: [DONE]\n\n"
    ]), (event) => received.push(event.delta));
    expect(received.join("")).toBe("你好");
  });

  it("跨 chunk 残行缓存：data 行被网络分包切开也能解析", async () => {
    const received: string[] = [];
    await consumeSse(streamOf([
      'data: {"choices":[{"delta":{"content":"A"}}]}\n\ndata: {"choices":[{"del',
      'ta":{"content":"B"}}]}\n\ndata: [DONE]'
    ]), (event) => received.push(event.delta));
    expect(received.join("")).toBe("AB");
  });

  it("跳过心跳注释行与非 JSON 行", async () => {
    const received: string[] = [];
    await consumeSse(streamOf([
      ": keep-alive\n\n",
      'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n',
      "data: not-json\n\n",
      "data: [DONE]\n\n"
    ]), (event) => received.push(event.delta));
    expect(received.join("")).toBe("OK");
  });

  it("空 delta 不发送事件", async () => {
    const received: Array<{ seq: number; delta: string }> = [];
    await consumeSse(streamOf([
      'data: {"choices":[{"delta":{}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
      "data: [DONE]\n\n"
    ]), (event) => received.push(event));
    expect(received).toEqual([{ seq: 1, delta: "x" }]);
  });

  // 实测缺口：上游/中转偶尔把 `content` 写成对象或数字
  // （`{"content":{"text":"你好"}}` / `{"content":42}`）。旧实现原样透传，
  // 渲染端把它拼进气泡字符串 → 用户读到 `[object Object]`。
  // 非字符串一律当"这一帧没有正文"跳过（与 `content: null` 的工具调用帧同一处理）。
  it("content 不是字符串时不发送事件（避免气泡出现 [object Object]）", async () => {
    const received: Array<{ seq: number; delta: string }> = [];
    await consumeSse(streamOf([
      'data: {"choices":[{"delta":{"content":{"text":"你好"}}}]}\n\n',
      'data: {"choices":[{"delta":{"content":42}}]}\n\n',
      'data: {"choices":[{"delta":{"content":null}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
      "data: [DONE]\n\n"
    ]), (event) => received.push(event));
    expect(received).toEqual([{ seq: 1, delta: "好" }]);
    expect(received.every((event) => typeof event.delta === "string")).toBe(true);
  });

  // 回归：收到 `[DONE]` 时必须**主动取消流**，不能只 `releaseLock()`。
  // `releaseLock()` 只放读锁、不断底层连接——实测（probe-sse-done，本机起一个发完
  // `[DONE]` 但不断开连接的 SSE 服务）连跑 3 轮后仍有 3 条 socket 开着、一条都没关。
  // 部分中转正是这种形态（答完静默挂着），长会话会累积成连接泄漏。
  it("收到 [DONE] 后取消流（不只释放读锁，避免连接泄漏）", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'));
        // 刻意不 close：模拟上游在 [DONE] 之后仍保持连接。
      },
      cancel() { cancelled = true; }
    });
    const got = await consumeSse(stream, () => undefined);
    expect(got).toBe(true);
    expect(cancelled).toBe(true);
  });

  // 回归：流结束时缓冲区里的最后一行不能丢。服务端最后一帧之后不一定带换行，
  // 旧实现在 done 时直接 return，那一帧内容整段丢失（实测：单帧流返回空内容 → "空回复"）。
  it("流末尾没有换行时，最后一帧仍被解析（不丢内容）", async () => {
    const received: string[] = [];
    const got = await consumeSse(streamOf([
      'data: {"choices":[{"delta":{"content":"末"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"帧"}}]}'
    ]), (event) => received.push(event.delta));
    expect(received.join("")).toBe("末帧");
    expect(got).toBe(true);
  });

  it("只有一帧且无换行时也算收到内容（不误判为空回复）", async () => {
    const received: string[] = [];
    const got = await consumeSse(streamOf([
      'data: {"choices":[{"delta":{"content":"唯一"}}]}'
    ]), (event) => received.push(event.delta));
    expect(received.join("")).toBe("唯一");
    expect(got).toBe(true);
  });
});

// 步骤条摘要必须只讲**用户关心的事实**。工具返回的文本本来是写给模型的，
// 里面混着行为指令——实测（鹈鹕案例真机）用户看到过"继续执行下一步，不要在回复里重复整个清单。"
describe("工具成败判定（isToolFailure）", () => {
  // 实测踩到：edit_artifact 拒绝歧义编辑时，步骤条渲染成
  // `✓ 修改文件完成（oldText 在文件里出现了 2 次…）`——打勾与"失败"同屏。
  // 成败改成结构化字段后，这里锁住判定本身。
  it("各工具的错误文案被识别为失败", () => {
    expect(isToolFailure("修改文件失败：oldText 在文件里出现了 2 次（第 3、5 行）。")).toBe(true);
    expect(isToolFailure("保存文件失败：不支持的产物类型：pdf。")).toBe(true);
    expect(isToolFailure("打开网页失败：渲染超时。")).toBe(true);
    expect(isToolFailure("搜索失败：连接重置。")).toBe(true);
    expect(isToolFailure("自检失败：页面没能加载起来（…）。")).toBe(true);
  });

  it("成功文案不算失败", () => {
    expect(isToolFailure("已修改 编辑测试.html（第 5 行，文件现为 8 行 / 1KB）。")).toBe(false);
    expect(isToolFailure("文件已生成并保存：报告.md（3KB）。")).toBe(false);
    expect(isToolFailure("[1] 结果一\n[2] 结果二")).toBe(false);
  });

  it("只在开头判定：正文中间出现'失败'不算（模型生成的页面里可能有错误提示）", () => {
    const pageBody = "已读取 500 字正文。页面内容：加载失败时请重试。";
    expect(isToolFailure(pageBody)).toBe(false);
  });

  // **放宽 schema 之后新增的一类回执**：参数空/缺时工具什么都没做，
  // 只回一句"请先给我像样的参数"。它们不含"失败"二字，旧判定一律打勾。
  // 实测要点：`update_plan` 会显示「步骤清单已更新」（实际一条没更新）、
  // `request_user_input` 显示「已收到你的回答」（实际没问出去）、
  // `web_search` 显示「未找到结果」（实际根本没搜）。
  it("可纠正的拒绝（参数为空）要判成未成功，且摘要说出实情", () => {
    const cases: Array<[string, string, string]> = [
      ["web_search", "搜索关键词是空的。请给出 3–6 个具体的词，不要写整句话。", "搜索关键词是空的"],
      ["update_plan", "步骤清单是空的：请给出至少一步（每步写清要做什么 + 当前 status）。", "步骤清单是空的"],
      ["request_user_input", "没有要问的问题（questions 是空的）。如果确实需要用户拍板，请给出 1–3 个问题。", "没有要问的问题（questions 是空的）"],
      ["edit_artifact_batch", "没有可应用的修改：edits 是空的。请把要改的内容写成至少一条 {oldText, newText}。", "没有可应用的修改"],
      // 实测 probe-nocred-backend：模型选了没配密钥的后端，`submit()` 前的前置检查拒绝。
      // 这类回执不含「失败」二字，旧判定打勾 → 步骤条编出
      // `✓ 生成视频完成（已创建视频任务）`，而回执原文写着"任务没有创建"——界面替模型撒谎。
      ["generate_video", "后端「MiniMax H3」现在用不了：还没保存 MiniMax АРI keys。\n目前可用的有：本机 ComfyUI（local）。\n**任务没有创建**，不要告诉用户已经提交。", "后端「MiniMax H3」现在用不了"]
    ];
    for (const [tool, text, expected] of cases) {
      expect(isToolFailure(text), `${tool} 应判为未成功`).toBe(true);
      expect(humanizeToolOutput(tool, text), `${tool} 摘要`).toBe(expected);
    }
  });

  // 实测：`read_artifact(keyword)` 没命中时，步骤条渲染成
  // `✓ 读取文件完成（共 2118 行）`——打了勾、还像是读到了内容。
  // 两个成因：① 判定用"前 40 字切句"，长文件名把「没有找到」挤出窗口；
  // ② 摘要优先匹配"共 N 行"，把"没找到"说成了行数。
  it("keyword 没命中（长文件名）要判成未成功", () => {
    const missed = "在 一个特别特别长的鹈鹕骑自行车三维演示页面文件名.html（共 2118 行）里没有找到「M.identity」。换个更短或更准确的片段试试（区分大小写）。";
    expect(isToolFailure(missed)).toBe(true);
  });

  it("keyword 没命中的摘要要说「没找到」，不能说成行数", () => {
    const missed = "在 鹈鹕.html（共 2118 行）里没有找到「M.identity」。换个更短或更准确的片段试试（区分大小写）。";
    const summary = humanizeToolOutput("read_artifact", missed);
    expect(summary).toBe("没有找到该片段");
    expect(summary).not.toContain("2118");
  });

  it("正常按行读回仍报行数（不误伤）", () => {
    const text = humanizeToolOutput("read_artifact", "文件：鹈鹕.html（共 2118 行，本次显示第 1–400 行）\n   1| …");
    expect(text).toBe("共 2118 行");
  });

  // 实测 probe-skip-question（2026-10-20）：用户**自己点**了「跳过，你决定」，
  // 步骤条却渲染成 `✕ 用户未回答，按默认继续`——把他的主动选择当成工具故障。
  // 回执里本来就有区分依据（skip / 超时 / 停止 三句文案各不相同），摘要各说各的即可。
  describe("request_user_input 的跳过/超时/停止不能判成失败", () => {
    const answered = [
      "未获得用户回答（用户跳过了这组问题。）。请按你认为最合理的方式继续执行，并在回复里说明你做了哪些默认假设。",
      "未获得用户回答（用户未在时限内回答。）。请按你认为最合理的方式继续执行。",
      "未获得用户回答（用户停止了本轮对话。）。请按你认为最合理的方式继续执行。"
    ];

    it("三种「没答成」都不是失败（用户跳过是他主动的选择）", () => {
      for (const text of answered) expect(isToolFailure(text), text.slice(0, 20)).toBe(false);
    });

    it("摘要要说清是哪种情况，不能一律「用户未回答」", () => {
      expect(humanizeToolOutput("request_user_input", answered[0])).toBe("已跳过（按默认继续）");
      expect(humanizeToolOutput("request_user_input", answered[1])).toBe("等待超时，按默认继续");
      expect(humanizeToolOutput("request_user_input", answered[2])).toBe("已停止本轮");
    });

    it("真的拿到回答时仍说收到了", () => {
      expect(humanizeToolOutput("request_user_input", "用户已回答：\n【时长】用户选择：6 秒"))
        .toBe("已收到你的回答");
    });
  });

  // 本会话自引入：允许 `duration` / `count` 写成 `"8 秒"` / `"2 路"` 之后，
  // 步骤条仍要显示这两个值——只判 `typeof === "number"` 会让它们**从步骤条上消失**，
  // 而"这一轮生成几秒、几条"正是用户最想在这一行确认的东西。
  it("步骤条摘要能显示带单位的时长与数量", () => {
    expect(humanizeToolInput("generate_video", { prompt: "a cat", duration: "8 秒", count: "2 路" }))
      .toBe("a cat · 8 秒 · 2 路");
    expect(humanizeToolInput("generate_video", { prompt: "a cat", duration: 6, count: 1 }))
      .toBe("a cat · 6 秒 · 1 路");
    // 读不出数字时不要显示 "NaN 秒"。
    expect(humanizeToolInput("generate_video", { prompt: "a cat", duration: "很久" }))
      .toBe("a cat");
  });

  // 项目约定：`inspect_artifact` 的回执 = 报告正文 + 末尾的文件身份说明。
  // 曾经反过来（身份说明在前），于是 `自检失败：…` 落到第二句——
  // 步骤条打勾、摘要显示"自检完成"，而页面根本没加载起来。
  // 这条断言把"失败必须出现在开头"这个契约锁住。
  it("自检失败 + 末尾文件身份说明时仍判为失败", () => {
    const NL = String.fromCharCode(10);
    const text = [
      "自检失败：页面没能加载起来（页面加载失败：ERR_FILE_NOT_FOUND（-6））。请检查 HTML 结构是否完整。",
      "",
      "---",
      "本次检查的文件：鹈鹕.html（41KB，修改于 00:28:06）。"
    ].join(NL);
    expect(isToolFailure(text)).toBe(true);
    expect(humanizeToolOutput("inspect_artifact", text)).toContain("自检失败");
  });

  it("自检通过 + 末尾文件身份说明时不算失败", () => {
    const NL = String.fromCharCode(10);
    const text = [
      "自检结果：页面已在本机 Chromium 中真实运行（标题「鹈鹕」，30 个元素，可见文本 40 字）。",
      "控制台没有任何 error/warning，画面也不是纯色。",
      "",
      "---",
      "本次检查的文件：鹈鹕.html（41KB，修改于 00:28:06）。"
    ].join(NL);
    expect(isToolFailure(text)).toBe(false);
    expect(humanizeToolOutput("inspect_artifact", text)).toBe("自检通过，无报错");
  });

  it("非字符串一律不算失败（不误报）", () => {
    expect(isToolFailure(undefined)).toBe(false);
    expect(isToolFailure(null)).toBe(false);
    expect(isToolFailure({ ok: false })).toBe(false);
  });

  // 本会话自引入：给 read/edit 加了名字回落说明后，未命中的 `没有找到`
  // 落在**第二行**，而判定只看第一句 → 步骤条打勾。
  // 修复是跳过开头那段括号说明后再判。
  it("带名字回落说明时，仍未命中要判成未成功", () => {
    const NL = String.fromCharCode(10);
    const missed = `（你点名的「a.html」已被更新的版本取代，实际读的是「a (2).html」）${NL}在 a (2).html（共 2118 行）里没有找到「M.identity」。换片段试试。`;
    expect(isToolFailure(missed)).toBe(true);
  });

  it("带名字回落说明但读取成功时不算失败", () => {
    const NL = String.fromCharCode(10);
    const ok = `（你写的「报告」没带扩展名，已按实际类型读「报告.html」）${NL}文件：报告.html（共 8 行，本次显示第 1–8 行）`;
    expect(isToolFailure(ok)).toBe(false);
  });

  // 跳过说明行不能变成"整段都扫"：正文里出现"失败"仍不该误判。
  it("跳过说明行后仍只看第一句（正文里的「失败」不算）", () => {
    const NL = String.fromCharCode(10);
    const body = `（说明行）${NL}已读取 500 字正文。页面内容：加载失败时请重试。`;
    expect(isToolFailure(body)).toBe(false);
  });
});

describe("工具摘要（humanizeToolOutput）", () => {
  it("update_plan 只给进度，不泄漏写给模型的指令", () => {
    const text = humanizeToolOutput("update_plan", "步骤清单已更新（0/4 已完成），用户能在对话里看到。继续执行下一步，不要在回复里重复整个清单。");
    expect(text).toBe("步骤 0/4 已完成");
    expect(text).not.toContain("不要在回复里重复");
  });

  it("create_file 给出保存的文件名", () => {
    const text = humanizeToolOutput("create_file", "文件已生成并保存：鹈鹕骑自行车_3D.html（41KB）。文件卡片已显示在对话中，用户可点「预览」查看或在文件夹中打开。**不要**把文件内容重复贴进回复。");
    expect(text).toBe("已保存 鹈鹕骑自行车_3D.html");
  });

  // 回归：重名文件带 ` (2)` 后缀，文件名里含 ASCII 括号。
  // 初版用 `[^（(]+` 做右边界，被 `(` 提前截断成 `已保存 鹈鹕骑自行车_3D`
  // ——后缀和扩展名全丢，两张卡片显示成同一个文件（真机踩到）。
  it("create_file 保留重名后缀 (2) 与扩展名", () => {
    const text = humanizeToolOutput("create_file", "文件已生成并保存：鹈鹕骑自行车_3D (2).html（46KB）。文件卡片已显示在对话中。");
    expect(text).toBe("已保存 鹈鹕骑自行车_3D (2).html");
  });

  it("create_file 的 MB 尺寸也能正确切出文件名", () => {
    const text = humanizeToolOutput("create_file", "文件已生成并保存：大文件.html（2.5MB）。文件卡片已显示在对话中。");
    expect(text).toBe("已保存 大文件.html");
  });

  // 真机复跑抓到的：keyword 分支回的是「在 X 里找到 N 处…」、不含"共 N 行"，
  // 只匹配行数就会掉进兜底，步骤条变成 `✓ 读取文件完成（完成）`。
  it("read_artifact 两个分支各说各的（定位 / 行数）", () => {
    expect(humanizeToolOutput("read_artifact", "在 鹈鹕.html 里找到 3 处「M.identity」：\n  120| …\n需要改哪一处…"))
      .toBe("定位到 3 处");
    expect(humanizeToolOutput("read_artifact", "文件：鹈鹕.html（共 1727 行，本次显示第 1–400 行）\n…"))
      .toBe("共 1727 行");
    // 两种措辞都不匹配时不硬凑
    expect(humanizeToolOutput("read_artifact", "别的内容")).toBe("完成");
  });

  it("inspect_artifact 把报错条数变成一眼可读的结论", () => {
    expect(humanizeToolOutput("inspect_artifact", "自检结果：页面已在本机 Chromium 中真实运行（标题「鹈鹕」，300 个元素，可见文本 40 字）。\n运行时报错（共 2 条，已去重）：\n- 错误：…"))
      .toBe("自检发现 2 条报错");
    expect(humanizeToolOutput("inspect_artifact", "自检结果：页面已在本机 Chromium 中真实运行（标题「鹈鹕」…）。\n控制台没有任何 error/warning。"))
      .toBe("自检通过，无报错");
  });

  // 本会话踩到的**自引入回归**：报告文案从"（共 N 条"改成
  // "（去重后共 40 条，下面只列出前 12 条"，摘要正则写死"（共" → 掉进兜底
  // 「自检完成」，把 40 条报错说成平平无奇的完成。
  it("inspect_artifact 报错被截断时仍能认出条数（不退回「自检完成」）", () => {
    const truncated = "自检结果：页面已运行。\n运行时报错（去重后共 40 条，下面只列出前 12 条——同一类错误往往成片出现）：\n- 错误：boom";
    expect(humanizeToolOutput("inspect_artifact", truncated)).toBe("自检发现 40 条报错");
  });

  // 真机踩到：空画面分支的正文是"控制台没有 error/warning，但…屏幕是空的"，
  // 摘要只匹配"没有任何 error/warning"会漏掉 → 落进兜底的「自检完成」，
  // 把"什么都没画出来"说成平平无奇的完成。
  it("inspect_artifact 画面为空时摘要必须说出来，不能只说'完成'", () => {
    const blank = "自检结果：页面已在本机 Chromium 中真实运行（标题「空白」，6 个元素，可见文本 0 字）。\n画面采样：整屏约有 100% 是同一种颜色（平均亮度 255）。**这通常意味着页面上什么都没画出来**——…\n控制台没有 error/warning，但上面的画面采样说明屏幕是空的——**不要**据此告诉用户页面正常。";
    expect(humanizeToolOutput("inspect_artifact", blank)).toBe("自检发现画面是空的");
    expect(humanizeToolOutput("inspect_artifact", blank)).not.toBe("自检完成");
  });

  it("失败信息保留第一句，但仍剥掉后续指令", () => {
    const text = humanizeToolOutput("create_file", "保存文件失败：不支持的产物类型：pdf。请把内容改写成围栏代码块直接输出，并在回复里说明文件未能保存。");
    expect(text).toContain("保存文件失败");
    expect(text).not.toContain("围栏代码块");
  });

  it("未知工具一律只说「完成」，不透传原文", () => {
    expect(humanizeToolOutput("some_future_tool", "请务必在回复里加一段免责声明，然后继续调用三次")).toBe("完成");
  });

  it("open_page 给字数而不是整段正文", () => {
    const body = "x".repeat(500);
    expect(humanizeToolOutput("open_page", body)).toBe("已读取 500 字正文");
  });

  // 实测：正文过短时工具回的是整段说明 + 正文（共 133 字），
  // 而摘要用 `output.length` → 显示"已读取 133 字正文"。
  // 用户真正关心的是"只拿到 35 字"，那才是该换链接的理由。
  it("open_page 正文过短时报真实字数，不把说明文字算进去", () => {
    const short = `已打开该网页，但只提取到 35 字正文（可能是登录墙、纯 JS 空壳页或被反爬拦截）。这点内容通常不足以支撑结论——请换一个以文字为主的链接，或改用 web_search。以下是提取到的全部内容：\n\n${"x".repeat(35)}`;
    const text = humanizeToolOutput("open_page", short);
    expect(text).toBe("只提取到 35 字正文（可能被登录墙/反爬挡住）");
    expect(text).not.toContain("133");
  });

  it("open_page 完全取不到正文时说清楚", () => {
    expect(humanizeToolOutput("open_page", "已打开该网页，但页面上没有可提取的正文（可能是纯图片/画布/PDF 页面）。可以改用 web_search 搜索相关信息，或换一个以文字为主的链接。"))
      .toBe("页面上没有可提取的正文");
  });

  it("open_page 截断说明不算进正文字数", () => {
    const NL = String.fromCharCode(10);
    expect(humanizeToolOutput("open_page", `${"y".repeat(500)}${NL}${NL}（页面过长已截断）`))
      .toBe("已读取 500 字正文（已截断）");
  });
});

describe("chatAgent 工具暴露", () => {
  const options: LlmServiceOptions = { baseUrl: "https://example.com/v1", apiKey: "k", model: "m", systemPrompt: "" };
  const callbacks = { webSearch: async () => "结果", generateVideo: async () => "已创建" };
  const messages = [{ role: "user" as const, content: "hi" }];

  // 让假 streamText 返回可控的异步流
  function stubStream(chunks: string[]) {
    streamTextMock.mockImplementation(() => ({
      textStream: (async function* () { for (const c of chunks) yield c; })(),
      steps: Promise.resolve([]),
      finishReason: Promise.resolve("stop")
    }));
  }
  function lastTools(): Record<string, unknown> {
    return (streamTextMock.mock.calls.at(-1)?.[0] as { tools: Record<string, unknown> }).tools;
  }
  function lastPrepareStep(): (arg: unknown) => { messages?: unknown[] } {
    return (streamTextMock.mock.calls.at(-1)?.[0] as { prepareStep: (arg: unknown) => { messages?: unknown[] } }).prepareStep;
  }

  // 严重回归护栏：预算提示注入时必须**保留已累积的对话**。
  // 初版用的是 `chatAgent` 入参（初始历史）而不是回调参数里的当前 messages，
  // 导致第 16 步消息数从 31 条骤降到 4 条——前面搜到的资料全被抹掉，
  // 模型恰好在"该收敛"的那一刻失忆（探针 probe-preparestep-history 抓到）。
  describe("剩余预算提示（prepareStep）", () => {
    it("未到阈值时不覆盖 messages", async () => {
      stubStream(["好"]);
      await chatAgent(options, messages, callbacks, () => {}, new AbortController().signal);
      const out = lastPrepareStep()({ stepNumber: 2, messages: [{ role: "user", content: "a" }] });
      expect(out.messages).toBeUndefined();
    });

    it("跨过阈值时保留当前消息并追加提示", async () => {
      stubStream(["好"]);
      await chatAgent(options, messages, callbacks, () => {}, new AbortController().signal);
      const current = [
        { role: "user", content: "最初的问题" },
        { role: "assistant", content: "我搜一下" },
        { role: "tool", content: "步骤清单已更新" }
      ];
      // 阈值 = MAX_AGENT_STEPS / 4 = 5；stepNumber = 20 - 5 = 15
      const out = lastPrepareStep()({ stepNumber: 15, messages: current });
      expect(out.messages).toHaveLength(current.length + 1);
      // 关键：原有消息**一条都不能少**
      expect(out.messages?.slice(0, current.length)).toEqual(current);
      expect(JSON.stringify(out.messages?.at(-1))).toContain("剩余预算");
    });

    it("只在跨阈值那一步注入（不每步都刷）", async () => {
      stubStream(["好"]);
      await chatAgent(options, messages, callbacks, () => {}, new AbortController().signal);
      const step = lastPrepareStep();
      // 阈值之前、之后都不注入：覆盖 carry-forward，不会重复堆叠
      expect(step({ stepNumber: 14, messages: [] }).messages).toBeUndefined();
      expect(step({ stepNumber: 16, messages: [] }).messages).toBeUndefined();
    });
  });

  // 撞满步骤上限必须能被识别：否则用户看到一段戛然而止的回答，界面上没有任何说明
  // （实测 probe-step-limit：10 步打满后气泡停在"正在做第 10 步。"）。
  // 判据是**最后一步**的 finishReason：还是 tool-calls 说明模型想继续、被上限掐断；
  // 自然收尾会是 stop。
  describe("步数上限识别（hitStepLimit）", () => {
    const stubSteps = (finishReasons: string[]) => {
      streamTextMock.mockImplementation(() => ({
        textStream: (async function* () { yield "边干边说"; })(),
        steps: Promise.resolve(finishReasons.map((finishReason) => ({ finishReason, toolCalls: [{ toolName: "update_plan" }] }))),
        finishReason: Promise.resolve(finishReasons.at(-1) ?? "stop")
      }));
    };

    it("最后一步仍是 tool-calls → 判定撞上限", async () => {
      stubSteps(["tool-calls", "tool-calls", "tool-calls"]);
      const result = await chatAgent(options, messages, callbacks, () => {}, new AbortController().signal);
      expect(result.hitStepLimit).toBe(true);
    });

    it("自然收尾（stop）→ 不算撞上限", async () => {
      stubSteps(["tool-calls", "stop"]);
      const result = await chatAgent(options, messages, callbacks, () => {}, new AbortController().signal);
      expect(result.hitStepLimit).toBe(false);
    });

    it("没有 steps 信息时保守判为未撞上限（不误报）", async () => {
      stubStream(["好"]);
      const result = await chatAgent(options, messages, callbacks, () => {}, new AbortController().signal);
      expect(result.hitStepLimit).toBe(false);
    });
  });

  // 回归护栏：曾无条件下发 web_search，导致游乐场「联网」开关形同虚设。
  it("联网开关关闭时不暴露 web_search 工具", async () => {
    stubStream(["好"]);
    await chatAgent(options, messages, callbacks, () => {}, new AbortController().signal, false);
    expect(Object.keys(lastTools())).not.toContain("web_search");
    expect(Object.keys(lastTools())).toContain("generate_video");
  });

  it("联网开关开启时暴露 web_search 工具", async () => {
    stubStream(["好"]);
    await chatAgent(options, messages, callbacks, () => {}, new AbortController().signal, true);
    expect(Object.keys(lastTools())).toContain("web_search");
    expect(Object.keys(lastTools())).toContain("generate_video");
  });

  it("默认（不传参）不下发 web_search", async () => {
    stubStream(["好"]);
    await chatAgent(options, messages, callbacks, () => {}, new AbortController().signal);
    expect(Object.keys(lastTools())).not.toContain("web_search");
  });

  // 计划模式：副作用工具与"语义冲突"工具都要摘掉。
  // 对齐 Codex 的 update_plan_enabled == false → without_update_plan_instructions（整段移除）。
  it("计划模式摘掉 generate_video 与 create_file（副作用工具）", async () => {
    stubStream(["1. 第一步\n2. 第二步"]);
    await chatAgent(options, messages, callbacks, () => {}, new AbortController().signal, true, undefined, undefined, true);
    const tools = Object.keys(lastTools());
    expect(tools).not.toContain("generate_video");
    expect(tools).not.toContain("create_file");
  });

  it("计划模式摘掉 update_plan（语义与'只出方案'冲突）", async () => {
    stubStream(["1. 第一步\n2. 第二步"]);
    await chatAgent(options, messages, callbacks, () => {}, new AbortController().signal, true, undefined, undefined, true);
    expect(Object.keys(lastTools())).not.toContain("update_plan");
  });

  it("计划模式保留只读工具（open_page 看不到就写不出靠谱的计划）", async () => {
    stubStream(["1. 第一步\n2. 第二步"]);
    await chatAgent(options, messages, callbacks, () => {}, new AbortController().signal, true, undefined, undefined, true);
    expect(Object.keys(lastTools())).toContain("open_page");
  });

  // 新增产物工具也要守住这条边界：**只读的留下、会改文件的摘掉**。
  // 读代码看不出来——它们分散在三个不同的 `planMode ? {} : {` 块里，
  // 全靠人肉记住哪个块包了谁。这条断言把边界变成可执行的事实。
  it("计划模式保留 read_artifact（只读），摘掉 edit / edit_batch / inspect", async () => {
    stubStream(["1. 第一步\n2. 第二步"]);
    await chatAgent(options, messages, callbacks, () => {}, new AbortController().signal, true, undefined, undefined, true);
    const tools = Object.keys(lastTools());
    expect(tools).toContain("read_artifact");
    expect(tools).not.toContain("edit_artifact");
    expect(tools).not.toContain("edit_artifact_batch");
    // inspect_artifact 本身只读，但它服务于"刚生成的产物"——计划模式不产文件，
    // 留着只会让模型以为有东西可查。与 create_file 同块摘除。
    expect(tools).not.toContain("inspect_artifact");
  });

  it("非计划模式下这些产物工具都在", async () => {
    stubStream(["好"]);
    await chatAgent(options, messages, callbacks, () => {}, new AbortController().signal, true, undefined, undefined, false);
    const tools = Object.keys(lastTools());
    for (const name of ["read_artifact", "edit_artifact", "edit_artifact_batch", "inspect_artifact", "create_file"]) {
      expect(tools).toContain(name);
    }
  });

  it("非计划模式仍下发 update_plan（它只在计划模式被摘）", async () => {
    stubStream(["好"]);
    await chatAgent(options, messages, callbacks, () => {}, new AbortController().signal, true, undefined, undefined, false);
    expect(Object.keys(lastTools())).toContain("update_plan");
  });

  it("文本分块按序推送给渲染端，并统计文本长度", async () => {
    stubStream(["你", "好"]);
    const sent: string[] = [];
    const result = await chatAgent(options, messages, callbacks, (event) => sent.push(event.delta), new AbortController().signal, false);
    expect(sent).toEqual(["你", "好"]);
    expect(result.textLength).toBe(2);
  });

  it("按步累计工具调用数（供调用方判断模型是否支持工具）", async () => {
    streamTextMock.mockImplementation(() => ({
      textStream: (async function* () { yield "ok"; })(),
      steps: Promise.resolve([{ toolCalls: [{}, {}] }, { toolCalls: [{}] }]),
      finishReason: Promise.resolve("stop")
    }));
    const result = await chatAgent(options, messages, callbacks, () => {}, new AbortController().signal, false);
    expect(result.toolCalls).toBe(3);
  });
});

// **本会话最贵的一条教训**：工具 schema 里任何一个"硬校验"，只要模型可能给一个
// **代码本来就能自动纠正**的值，就会让 AI SDK 在 `parseToolCall` 阶段抛
// `InvalidToolInputError` → 整个调用被**静默跳过**（toolCall 记进历史但不执行）→
// 模型收不到回执 → 反复重试同一条 → **20 步预算全烧光**。
//
// 本轮用 mock 探针逐个复现并修掉了 10 处：edits.min(2)、edits.max(20)、
// duration/count 的 min/max/int、url 的 .url()、startLine/endLine 的 .int().min(1)、
// kind 的 z.enum、status 的 z.enum、oldText 的 .min(1)（单处 + 批量）、
// keyword 的 .min(1) 与 range 的不可为 null。
//
// 这条测试把规律变成可执行断言：**每个工具都必须能吞下自己那句描述里
// "会被自动纠正/夹紧/补齐"所承诺的输入**。新加工具时它会第一时间变红。
describe("工具 schema 契约：可自动纠正的输入不能拒掉整轮", () => {
  const options: LlmServiceOptions = { baseUrl: "https://example.com/v1", apiKey: "k", model: "m", systemPrompt: "" };
  const callbacks = { webSearch: async () => "结果", generateVideo: async () => "已创建" };
  const messages = [{ role: "user" as const, content: "hi" }];

  async function schemas(): Promise<Record<string, { safeParse: (v: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } } }>> {
    streamTextMock.mockImplementation(() => ({
      textStream: (async function* () { yield "好"; })(),
      steps: Promise.resolve([]),
      finishReason: Promise.resolve("stop")
    }));
    await chatAgent(options, messages, callbacks, () => {}, new AbortController().signal, true);
    const tools = (streamTextMock.mock.calls.at(-1)?.[0] as { tools: Record<string, { inputSchema: unknown }> }).tools;
    return Object.fromEntries(Object.entries(tools).map(([name, def]) => [name, def.inputSchema as never]));
  }

  it("read_artifact：空 keyword、null 范围、0 起算行号都能进", async () => {
    const s = (await schemas()).read_artifact;
    for (const value of [
      { name: "a.html", keyword: "" },
      { name: "a.html", keyword: null },
      { name: "a.html", startLine: 0 },
      { name: "a.html", startLine: null, endLine: null },
      { name: "a.html", startLine: 3.7 }
    ]) {
      const parsed = s.safeParse(value);
      expect(parsed.success, `${JSON.stringify(value)} → ${parsed.error?.issues[0]?.message}`).toBe(true);
    }
  });

  it("create_file：excel/word 这类别名不能把整轮拒掉", async () => {
    const s = (await schemas()).create_file;
    for (const kind of ["excel", "xlsx", "word", "markdown", "网页"]) {
      const parsed = s.safeParse({ kind, name: "x", content: "y" });
      expect(parsed.success, `${kind} → ${parsed.error?.issues[0]?.message}`).toBe(true);
    }
  });

  // 实测复现（probe-missing-content）：模型只给 `{ kind, name }`（"先建个空文件、
  // 下一步再写"的思路）时，`content` 缺键会让 parseToolCall 拒掉整个调用——
  // create_file 连续 20 次没执行，气泡只剩「没有产生可展示的产物」。
  it("create_file：省略 content / name / kind 也能进工具层", async () => {
    const s = (await schemas()).create_file;
    for (const value of [
      { kind: "html", name: "空壳" },
      { kind: "html", content: "<p>x</p>" },
      { name: "a", content: "y" },
      {}
    ]) {
      const parsed = s.safeParse(value);
      expect(parsed.success, `${JSON.stringify(value)} → ${parsed.error?.issues[0]?.message}`).toBe(true);
    }
  });

  it("generate_video：越界时长/数量交给代码夹取，不在 schema 拒", async () => {
    const s = (await schemas()).generate_video;
    for (const value of [
      { prompt: "p", duration: 20, count: 9 },
      { prompt: "p", duration: 6.5, count: 2 },
      // **字符串数字也要收**（实测同一类坑第十二处）：部分模型把数字写成 `"6"`，
      // `z.number()` 会直接拒 → 整个调用被静默跳过。
      { prompt: "p", duration: "6", count: "2" },
      // **带单位的字符串更常见**（实测第十三处）：`"8 秒"` / `"2 路"` 用
      // `z.coerce.number()` 会得到 NaN，zod 拒掉 NaN → generate_video 连续 20 次没执行。
      { prompt: "p", duration: "8 秒", count: "2 路" },
      { prompt: "p", duration: "约 6.5s", count: "1" }
    ]) {
      const parsed = s.safeParse(value);
      expect(parsed.success, `${JSON.stringify(value)} → ${parsed.error?.issues[0]?.message}`).toBe(true);
    }
  });

  it("read_artifact：行号写成带单位/范围的中文也收（值由代码归一）", async () => {
    const s = (await schemas()).read_artifact;
    for (const value of [
      { name: "a.html", startLine: "第 3 行" },
      { name: "a.html", startLine: "3-100", endLine: "120" },
      { name: "a.html", startLine: 0, endLine: 9999 }
    ]) {
      const parsed = s.safeParse(value);
      expect(parsed.success, `${JSON.stringify(value)} → ${parsed.error?.issues[0]?.message}`).toBe(true);
    }
  });

  it("edit_artifact / batch：空 oldText 与 0/超量 edits 都能进工具层", async () => {
    const tools = await schemas();
    expect(tools.edit_artifact.safeParse({ name: "a", oldText: "", newText: "x" }).success).toBe(true);
    expect(tools.edit_artifact_batch.safeParse({ name: "a", edits: [] }).success).toBe(true);
    expect(tools.edit_artifact_batch.safeParse({
      name: "a",
      edits: Array.from({ length: 25 }, () => ({ oldText: "x", newText: "y" }))
    }).success).toBe(true);
  });

  it("open_page：不带协议的地址由代码补 https", async () => {
    expect((await schemas()).open_page.safeParse({ url: "example.com/foo" }).success).toBe(true);
  });

  // 实测同类坑第十五处：模型把 url 传成空串时（"打开刚才那个链接"），
  // `.min(1)` 会让 AI SDK 在 parseToolCall 阶段拒掉整个调用 → 静默跳过。
  it("open_page：空 url 也能进工具层（由 execute 回一句可纠正说明）", async () => {
    expect((await schemas()).open_page.safeParse({ url: "" }).success).toBe(true);
  });

  // 实测复现（probe-schema-empty-name）：模型说"刚才那个文件"时把 name 留空，
  // `z.string().min(1)` 让 AI SDK 在 parseToolCall 阶段抛错、调用被**静默跳过**：
  // 1 次 create_file + **19 次空转**，20 步预算全烧光、步骤条一片空白。
  // 空名字必须能进工具层，由 execute 回一句可纠正的说明。
  it("四个产物工具的 name 为空时不拒掉整轮", async () => {
    const tools = await schemas();
    for (const [name, value] of [
      ["read_artifact", { name: "" }],
      ["inspect_artifact", { name: "" }],
      ["edit_artifact", { name: "", oldText: "a", newText: "b" }],
      ["edit_artifact_batch", { name: "", edits: [{ oldText: "a", newText: "b" }] }]
    ] as const) {
      const parsed = tools[name].safeParse(value);
      expect(parsed.success, `${name} → ${parsed.error?.issues[0]?.message}`).toBe(true);
    }
  });

  it("update_plan：done / in-progress 这类写法在代码里归一", async () => {
    const s = (await schemas()).update_plan;
    const parsed = s.safeParse({ plan: [{ step: "a", status: "done" }, { step: "b", status: "in-progress" }] });
    expect(parsed.success, parsed.error?.issues[0]?.message).toBe(true);
  });

  // 实测复现（probe-plan-missing）：模型只写 `{ plan: [{ step: "搜索资料" }] }`，省略 status。
  // 必填时 AI SDK 在 parseToolCall 阶段抛错 → 调用被静默跳过：探针实测连 20 次没执行、
  // 步骤清单卡片一次都没渲染。而这个工具几乎每步都调，等于废掉整轮的进度可视化。
  it("update_plan：省略 step / status 也能进工具层", async () => {
    const s = (await schemas()).update_plan;
    for (const value of [
      { plan: [{ step: "搜索资料" }] },
      { plan: [{ status: "done" }] },
      { plan: [{}, {}] }
    ]) {
      const parsed = s.safeParse(value);
      expect(parsed.success, `${JSON.stringify(value)} → ${parsed.error?.issues[0]?.message}`).toBe(true);
    }
  });

  // 实测复现（probe-schema-question-field）：模型只写 `{ id, question, options }`，
  // 省掉 `header`、或选项只给 `{ id, label }` 不给 `description`。
  // 必填时 AI SDK 在 `parseToolCall` 阶段抛错 → 调用被**静默跳过**：
  // 探针实测 request_user_input 连续 20 次没执行，界面上连选择题卡片都不出现。
  it("request_user_input：缺 header / question / description 也能进工具层", async () => {
    const s = (await schemas()).request_user_input;
    for (const value of [
      { questions: [{ id: "q1", question: "多久？", options: [{ id: "a", label: "6 秒" }] }] },
      { questions: [{ id: "q1", header: "时长", options: [{ id: "a" }] }] },
      { questions: [{ options: [] }] }
    ]) {
      const parsed = s.safeParse(value);
      expect(parsed.success, `${JSON.stringify(value)} → ${parsed.error?.issues[0]?.message}`).toBe(true);
    }
  });
});

// 智能体路径端点：AI SDK 固定拼 /chat/completions，但 MiniMax 官方是 /text/chatcompletion_v2。
// 普通对话早按 resolveChatPath 推导，智能体此前没有 → 同一 baseUrl 下两条路径打到不同端点。
describe("rewriteChatEndpoint", () => {
  it("MiniMax 官方 baseUrl → 改写为 /text/chatcompletion_v2", () => {
    expect(rewriteChatEndpoint("https://api.minimax.io/v1/chat/completions", "https://api.minimax.io/v1"))
      .toBe("https://api.minimax.io/v1/text/chatcompletion_v2");
  });

  it("中转/自定义 baseUrl → 保持 /chat/completions 不变", () => {
    const url = "https://relay.example/v1/chat/completions";
    expect(rewriteChatEndpoint(url, "https://relay.example/v1")).toBe(url);
  });

  it("保留查询串", () => {
    expect(rewriteChatEndpoint("https://api.minimax.io/v1/chat/completions?x=1", "https://api.minimax.io/v1"))
      .toBe("https://api.minimax.io/v1/text/chatcompletion_v2?x=1");
  });
});

// 官方有两个域名：国际站 api.minimax.io、中国站 api.minimaxi.com，都用 /text/chatcompletion_v2。
// 只认 .io 会让中国站用户走 /chat/completions（该路径不存在 → 404）。
describe("resolveChatPath", () => {
  it("国际站与中国站都用官方私有端点", () => {
    expect(resolveChatPath("https://api.minimax.io/v1")).toBe("/text/chatcompletion_v2");
    expect(resolveChatPath("https://api.minimaxi.com/v1")).toBe("/text/chatcompletion_v2");
  });

  it("中转/其他上游用标准端点", () => {
    expect(resolveChatPath("https://relay.example/v1")).toBe("/chat/completions");
    expect(resolveChatPath("https://api.deepseek.com/v1")).toBe("/chat/completions");
  });

  it("相似域名不误命中（按 hostname 精确比对）", () => {
    expect(resolveChatPath("https://api.minimax.io.evil.com/v1")).toBe("/chat/completions");
  });

  // 尾点是 FQDN 根锚定写法，DNS 解析与无尾点完全等价，官方接口照样能通。
  // 只比字面量会让同一个服务走错端点（→ 404），而用户在连接设置里看不出区别。
  it("带尾点的官方域名仍走私有端点（与 assertPublicHost 同一口径）", () => {
    expect(resolveChatPath("https://api.minimax.io./v1")).toBe("/text/chatcompletion_v2");
    expect(resolveChatPath("https://api.minimaxi.com./v1")).toBe("/text/chatcompletion_v2");
    // 只剥尾点，不放松相似域名判定。
    expect(resolveChatPath("https://api.minimax.io.evil.com./v1")).toBe("/chat/completions");
  });

  it("非法 baseUrl 不抛错", () => {
    expect(resolveChatPath("not-a-url")).toBe("/chat/completions");
    expect(resolveChatPath("")).toBe("/chat/completions");
  });
});

// 搜索返回空结果时必须**明确告知模型**，不能什么都不追加——
// 否则模型以为自己检索过了，直接凭训练知识作答（本项目反复踩到的"凭旧知识回答实时问题"）。
describe("buildPayload 搜索空结果的告知", () => {
  async function systemContentFrom(handler: (url: string) => Response): Promise<string> {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/search")) return handler(url);
      bodies.push(String(init?.body ?? ""));
      if (url.includes("/chat/completions")) {
        return new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "好" } }] })}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        );
      }
      throw new Error(`Unexpected: ${url}`);
    }));
    const service = new LlmService({
      baseUrl: "https://llm.test/v1",
      apiKey: "k",
      model: "m",
      systemPrompt: "SYS",
      searchBaseUrl: "https://search.test",
      searchApiKey: "k"
    });
    await service.chat([{ role: "user", content: "今天股价多少" }], true, () => {});
    const payload = JSON.parse(bodies[0]) as { messages: Array<{ role: string; content: string }> };
    vi.unstubAllGlobals();
    return payload.messages[0].content;
  }

  it("搜索 API 返回 0 条时，system 里写明「未返回任何结果」", async () => {
    const content = await systemContentFrom(() => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    expect(content).toContain("未返回任何结果");
    // 必须同时约束模型不要编造具体数字。
    expect(content).toContain("不要凭记忆给出具体数字");
  });

  it("搜索有结果时追加结果正文，不写「未返回」提示", async () => {
    const content = await systemContentFrom(() => new Response(
      JSON.stringify({ results: [{ title: "T", url: "https://x", snippet: "S" }] }),
      { status: 200 }
    ));
    expect(content).toContain("以下是网络搜索结果");
    expect(content).toContain("[1] T");
    expect(content).not.toContain("未返回任何结果");
  });
});

// 上游半开/卡住时 `reader.read()` 永不返回。智能体路径有 timeout.chunkMs 兜着，
// 普通对话这条没有 → 光标一直闪、点停止前毫无反馈。这里锁住空闲超时行为。
describe("非流式响应体取内容（空串不能被当成有内容）", () => {
  async function chatWith(body: unknown): Promise<string> {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
    ));
    const service = new LlmService({ baseUrl: "https://llm.test/v1", apiKey: "k", model: "m", systemPrompt: "" });
    let received = "";
    await service.chat([{ role: "user", content: "hi" }], false, (event) => { received += event.delta; });
    vi.unstubAllGlobals();
    return received;
  }

  // `??` 只跳过 null/undefined：`message.content` 为空串时会选中它，
  // 于是明明 `text`/顶层 `content` 里有内容，却被报成"服务商未返回内容"。
  it("message.content 为空串时回退到 choices[0].text", async () => {
    await expect(chatWith({ choices: [{ message: { content: "" }, text: "来自 text" }] }))
      .resolves.toBe("来自 text");
  });

  it("message.content 为空串时回退到顶层 content", async () => {
    await expect(chatWith({ choices: [{ message: { content: "" } }], content: "顶层内容" }))
      .resolves.toBe("顶层内容");
  });

  it("全部为空时仍按「未返回内容」报错（不静默）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200, headers: { "Content-Type": "application/json" } })
    ));
    const service = new LlmService({ baseUrl: "https://llm.test/v1", apiKey: "k", model: "m", systemPrompt: "" });
    const error = await service.chat([{ role: "user", content: "hi" }], false, () => {}).catch((e: Error) => e);
    vi.unstubAllGlobals();
    expect((error as Error).message).toContain("未返回内容");
  });

  // 反向代理/网关出错时返回的是 **HTML 错误页**。旧实现把响应体原样截 200 字拼进
  // 错误文案，实测（probe-http-error）界面上出现
  // `LLM 请求失败：502 <!DOCTYPE html><html><head><title>502 Bad Gateway</title>…`
  // ——整段标签糊在气泡里，用户既读不出信息也不知道该做什么。
  describe("HTTP 失败文案", () => {
    async function failureFrom(status: number, body: string, contentType: string): Promise<string> {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status, headers: { "Content-Type": contentType } })));
      const service = new LlmService({ baseUrl: "https://llm.test/v1", apiKey: "k", model: "m", systemPrompt: "" });
      const error = await service.chat([{ role: "user", content: "hi" }], false, () => {}).catch((e: Error) => e);
      vi.unstubAllGlobals();
      return (error as Error).message;
    }

    it("HTML 错误页不回显正文，只给状态码与可执行建议", async () => {
      const text = await failureFrom(502, "<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1></body></html>", "text/html");
      expect(text).toContain("HTTP 502");
      expect(text).toContain("稍后重试");
      expect(text).not.toContain("<!DOCTYPE");
      expect(text).not.toContain("<html");
    });

    it("JSON 错误体保留服务商自己的说明", async () => {
      const text = await failureFrom(400, JSON.stringify({ error: { message: "model not found: m" } }), "application/json");
      expect(text).toContain("HTTP 400");
      expect(text).toContain("model not found: m");
    });

    it("MiniMax 风格的 base_resp.status_msg 也能取到", async () => {
      const text = await failureFrom(400, JSON.stringify({ base_resp: { status_msg: "invalid api key" } }), "application/json");
      expect(text).toContain("invalid api key");
    });

    it("401 给出「检查 API Key」的定向建议", async () => {
      const text = await failureFrom(401, "", "text/plain");
      expect(text).toContain("API Key");
    });

    it("超长说明被截断（不把整段堆栈糊给用户）", async () => {
      const text = await failureFrom(500, JSON.stringify({ error: { message: "x".repeat(500) } }), "application/json");
      expect(text.length).toBeLessThan(400);
    });
  });
});

describe("consumeSse 空闲超时", () => {
  it("上游迟迟不吐数据时按超时抛中文错误", async () => {
    const stuck = new ReadableStream<Uint8Array>({
      start() { /* 永不 enqueue、也永不 close：模拟连接半开 */ }
    });
    const error = await consumeSse(stuck, () => {}, 50).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("没有继续返回内容");
  });

  it("正常结束的流不受超时影响", async () => {
    const received: string[] = [];
    const ok = await consumeSse(
      streamOf([`data: ${JSON.stringify({ choices: [{ delta: { content: "好" } }] })}\n\n`, "data: [DONE]\n\n"]),
      (event) => received.push(event.delta),
      5_000
    );
    expect(ok).toBe(true);
    expect(received).toEqual(["好"]);
  });
});

// `consumeSse` 的空闲超时只在**拿到响应头之后**才生效。上游若接受连接却永不回响应头
// （网关卡死、中间层黑洞、服务半开），而这里传的是用户取消信号（本身永不到期），
// 整轮对话会永久卡住——界面一直是"生成中"，用户不知道要等多久。
// 实测（probe-chat-headers，本机起一个只接受连接不回头的 server）：8 秒后仍未落定。
describe("chat 等响应头的超时", () => {
  it("上游不回响应头时按超时抛中文错误（不永久挂住）", async () => {
    // 模拟 fetch 卡在等响应头：只在 signal abort 时落定，否则永不 resolve。
    vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("已取消", "AbortError")));
      })
    ));
    const service = new LlmService({
      baseUrl: "https://llm.test/v1",
      apiKey: "k",
      model: "m",
      systemPrompt: "",
      headerTimeoutMs: 50
    });
    const error = await service.chat([{ role: "user", content: "hi" }], false, () => {}).catch((e: Error) => e);
    vi.unstubAllGlobals();
    expect((error as Error).message).toContain("没有返回响应");
    // 必须能被上层的 describeError 翻成中文，而不是透出 AbortError 英文名。
    expect((error as Error).message).not.toMatch(/AbortError/);
  });
});

// 实测误报（本会话自引入）：放宽 schema 后新增的「可纠正的拒绝」判定，最初写成裸的
// `/是空的|没有要问的问题|…/`，于是搜索引擎返回的**标题**只要含这几个字
// （`[1] 为什么杯子是空的`）就会被判成工具失败 —— 步骤条打 ✕、摘要只剩标题一行。
// 判据必须锚定我们自己的回执开头。
describe("可纠正的拒绝对搜索结果不误报", () => {
  it("标题里含「是空的」的正常结果不算失败", () => {
    const output = "[1] 为什么杯子是空的\nhttps://x.com/a\n一篇科普。\n\n[2] 标题二\nhttps://x.com/b\n摘要二";
    expect(isToolFailure(output)).toBe(false);
    expect(humanizeToolOutput("web_search", output)).toBe("找到 2 条结果");
  });

  it("读回的正文里含这些字样也不算失败", () => {
    const output = "文件：a.html（共 3 行，本次显示第 1–3 行）\n    1| 没有要问的问题\n    2| x";
    expect(isToolFailure(output)).toBe(false);
  });
});

/**
 * 选择题参数的形状归一（`normalizeAgentQuestions`）。
 *
 * 实测背景（probe-question-shapes，2026-10-20）：9 种参数形状里 **7 种**被 AI SDK 在
 * `parseToolCall` 阶段拒掉，`execute` 根本不跑、模型收不到回执。而 `request_user_input`
 * 是后端闸门（"多个后端可用时必须先问用户"）的**唯一出口**——调用被跳过，
 * 闸门就永远关不上，模型反复重试烧光 20 步。
 *
 * 所以这里的契约是：**任何"能猜出意图"的形状都要接住**，读不出来时回一句
 * 可纠正的中文说明（而不是抛错）。
 */
describe("选择题参数归一（normalizeAgentQuestions）", () => {
  const questionsOf = (raw: unknown) => {
    const result = normalizeAgentQuestions(raw);
    if ("error" in result) throw new Error(`预期归一成功，却返回了说明：${result.error}`);
    return result.questions;
  };

  it("标准形状原样通过", () => {
    const [q] = questionsOf([{ id: "dur", header: "时长", question: "几秒？", options: [{ id: "6", label: "6 秒", description: "短" }] }]);
    expect(q.id).toBe("dur");
    expect(q.header).toBe("时长");
    expect(q.question).toBe("几秒？");
    expect(q.options).toEqual([{ id: "6", label: "6 秒", description: "短" }]);
  });

  it("options 写成纯字符串数组也接住（模型真这么写）", () => {
    const [q] = questionsOf([{ question: "几秒？", options: ["6 秒", "15 秒"] }]);
    expect(q.options.map((o) => o.label)).toEqual(["6 秒", "15 秒"]);
    // id 自动补，且两两不同（否则答案回传会把两个选项当成一个）
    expect(new Set(q.options.map((o) => o.id)).size).toBe(2);
  });

  it("options 写成对象映射 / 单个字符串也接住", () => {
    expect(questionsOf([{ question: "几秒？", options: { a: "6 秒", b: "15 秒" } }])[0].options.map((o) => o.label))
      .toEqual(["6 秒", "15 秒"]);
    expect(questionsOf([{ question: "几秒？", options: "6 秒" }])[0].options).toHaveLength(1);
  });

  it("questions 写成单字符串 / 对象映射也接住", () => {
    // 单个字符串 = "只问这一个"（没给选项 → 走可纠正说明）
    expect(normalizeAgentQuestions("几秒？")).toHaveProperty("error");
    // 对象映射的**值**里带完整问题与选项时应能画出来
    const [q] = questionsOf({ q1: { question: "几秒？", options: ["6 秒", "15 秒"] } });
    expect(q.question).toBe("几秒？");
    expect(q.options).toHaveLength(2);
  });

  it("问题元素本身是字符串时，用文本当问题", () => {
    const result = normalizeAgentQuestions([{ question: "几秒？", options: [{ label: "6 秒" }, { label: "15 秒" }] }]);
    expect("questions" in result && result.questions[0].question).toBe("几秒？");
  });

  it("multiSelect 接受 \"yes\" / 1 / \"是\"，拒绝无意义的值时按未开启", () => {
    const bool = (value: unknown) => questionsOf([{ question: "哪些？", multiSelect: value, options: ["a", "b"] }])[0].multiSelect;
    expect(bool("yes")).toBe(true);
    expect(bool(1)).toBe(true);
    expect(bool("是")).toBe(true);
    expect(bool("no")).toBe(false);
    expect(bool(0)).toBe(false);
    expect(bool("???")).toBeUndefined();
  });

  it("label 是数字时转成文本（否则渲染端会画出空标签）", () => {
    const [q] = questionsOf([{ question: "几秒？", options: [{ id: "6", label: 6 }, { id: "15", label: 15 }] }]);
    expect(q.options.map((o) => o.label)).toEqual(["6", "15"]);
  });

  it("问题 id / 选项 id 双双去重（同 id 会让后一题顶用前一题的答案）", () => {
    const list = questionsOf([
      { id: "q", question: "几秒？", options: [{ id: "a", label: "6 秒" }, { id: "a", label: "15 秒" }] },
      { id: "q", question: "什么比例？", options: ["16:9", "9:16"] }
    ]);
    expect(list[0].id).not.toBe(list[1].id);
    expect(new Set(list[0].options.map((o) => o.id)).size).toBe(2);
  });

  it("越界夹紧而不是拒绝：超过 3 题 / 4 个选项时只截断", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      id: `q${i}`,
      question: `问题 ${i}`,
      options: Array.from({ length: 8 }, (_, j) => ({ id: `o${j}`, label: `选项 ${j}` }))
    }));
    const list = questionsOf(many);
    expect(list).toHaveLength(3);
    expect(list[0].options).toHaveLength(4);
  });

  it("问不出来的形状给**中文可纠正说明**，而不是抛错（模型据此改）", () => {
    // 只有一句话、没有选项 → 说清"缺选项"
    const noOptions = normalizeAgentQuestions([{ question: "几秒？" }]);
    expect("error" in noOptions && noOptions.error).toMatch(/没有任何选项/);
    // 空/缺 → 说清"没有要问的问题"
    for (const empty of [[], null, undefined, "", {}, 0]) {
      const result = normalizeAgentQuestions(empty);
      expect("error" in result, JSON.stringify(empty)).toBe(true);
    }
  });

  it("缺 header / question 时补默认值，不让卡片空着", () => {
    // 两个都缺 → 这一条读不出问题文本，**跳过它**；全被跳光时回可纠正说明
    // （而不是画一张既没标题也没问题的空卡片）。
    const empty = normalizeAgentQuestions([{ options: ["6 秒", "15 秒"] }]);
    expect("error" in empty && empty.error).toMatch(/缺少 question/);

    // 只缺 question、有 header → 用 header 顶上（总比空卡片强）
    const [withHeader] = questionsOf([{ header: "时长", options: ["6 秒", "15 秒"] }]);
    expect(withHeader.question).toBe("时长");
    expect(withHeader.header).toBe("时长");

    // 只缺 header、有 question → header 补「问题 N」
    const [withQuestion] = questionsOf([{ question: "几秒？", options: ["6 秒", "15 秒"] }]);
    expect(withQuestion.header).toBe("问题 1");
  });
});
