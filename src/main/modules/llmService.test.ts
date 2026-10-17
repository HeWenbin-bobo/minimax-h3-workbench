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

import { consumeSse, chatAgent, type LlmServiceOptions } from "./llmService";

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
