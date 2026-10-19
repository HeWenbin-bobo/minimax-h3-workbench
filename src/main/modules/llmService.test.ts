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

import { consumeSse, chatAgent, LlmService, resolveChatPath, rewriteChatEndpoint, humanizeToolOutput, isToolFailure, type LlmServiceOptions } from "./llmService";

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

  it("非字符串一律不算失败（不误报）", () => {
    expect(isToolFailure(undefined)).toBe(false);
    expect(isToolFailure(null)).toBe(false);
    expect(isToolFailure({ ok: false })).toBe(false);
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
