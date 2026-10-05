import { describe, expect, it } from "vitest";
import { consumeSse } from "./llmService";

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
});
