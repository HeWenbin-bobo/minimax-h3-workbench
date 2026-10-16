// 用 AI SDK 原样复现 chatAgent 的时序：textStream 循环结束时刻 vs steps/finishReason 时刻
const { app, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
app.setPath("userData", process.env.REAL_USER_DATA);
app.whenReady().then(async () => {
  const out = {};
  try {
    const secrets = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "secrets.json"), "utf8"));
    const key = safeStorage.decryptString(Buffer.from(secrets.llmApiKey, "base64"));
    const { streamText, tool, stepCountIs } = await import("ai");
    const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
    const { z } = await import("zod");
    const provider = createOpenAICompatible({ name: "wb", baseURL: "https://<relay-host>/v1", apiKey: key });
    const model = provider.chatModel("glm-5.3-flash");
    const t0 = Date.now();
    const stream = streamText({
      model,
      system: "你是助手。",
      messages: [{ role: "user", content: "只回复两个字：你好" }],
      tools: { generate_video: tool({ description: "生成视频", inputSchema: z.object({ prompt: z.string(), duration: z.number(), count: z.number() }), execute: async () => "ok" }) },
      stopWhen: stepCountIs(10),
      maxRetries: 0,
      timeout: { chunkMs: 120000, totalMs: 600000 },
      abortSignal: AbortSignal.timeout(120000)
    });
    let textLength = 0, first = null, last = null;
    for await (const part of stream.textStream) { if (part) { textLength += part.length; first ??= Date.now() - t0; last = Date.now() - t0; } }
    out.textStreamLoopEndedAt = Date.now() - t0;
    out.firstChunkAt = first; out.lastChunkAt = last; out.textLength = textLength;
    let toolCalls = 0;
    try { for (const step of await stream.steps) toolCalls += step.toolCalls.length; } catch (e) { out.stepsError = e.message; }
    out.stepsResolvedAt = Date.now() - t0; out.toolCalls = toolCalls;
    out.finishReason = await stream.finishReason;
    out.finishReasonResolvedAt = Date.now() - t0;
  } catch (e) { out.fatal = e.message; }
  fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify(out, null, 2));
  app.exit(0);
});
