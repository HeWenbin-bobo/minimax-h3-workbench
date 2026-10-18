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

import { consumeSse, chatAgent, LlmService, resolveChatPath, rewriteChatEndpoint, type LlmServiceOptions } from "./llmService";

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
