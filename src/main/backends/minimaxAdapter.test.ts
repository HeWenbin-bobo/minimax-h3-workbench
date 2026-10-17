import { afterEach, describe, expect, it, vi } from "vitest";
import type { GenerationRequest, GenerationTask } from "../../shared/types";
import { MiniMaxAdapter } from "./minimaxAdapter";

const request: GenerationRequest = {
  mode: "text",
  backend: "minimax",
  prompt: "一只猫在奔跑",
  duration: 6,
  ratio: "16:9",
  resolution: "768P",
  width: 1280,
  height: 720,
  count: 1,
  baseSeed: 1
};

const task = { id: "t1", seed: 1, prompt: request.prompt } as GenerationTask;

afterEach(() => vi.unstubAllGlobals());

const adapter = () => new MiniMaxAdapter({ baseUrl: "https://api.minimax.test", apiKey: "k", outputDirectory: "/tmp" });

let queryIndex = 0;
function stubApi(queryBodies: unknown[]) {
  queryIndex = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/v2/video_generation")) {
      return new Response(JSON.stringify({ task_id: "task-abc" }), { status: 200 });
    }
    if (url.includes("/v2/query/video_generation/")) {
      const body = queryBodies[Math.min(queryIndex, queryBodies.length - 1)];
      queryIndex += 1;
      return new Response(JSON.stringify(body), { status: 200 });
    }
    // 结果下载
    return new Response(new Uint8Array([0, 0, 0, 1]), { status: 200 });
  }));
}

/** 轮询内含 10s 睡眠：用假定时器推进，避免单测真等。 */
async function generateWithTimers(progress: (status: string) => void = () => undefined) {
  vi.useFakeTimers();
  try {
    const pending = adapter().generate(request, task, (status) => progress(status));
    // 先挂空处理器：失败用例里 promise 会在推进假定时器时就 reject，晚挂会触发 unhandled rejection 告警。
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(120_000);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

// 背景：官方文档的成功态是 "Success"（首字母大写，不是 succeeded）。旧实现只比对 succeeded，
// 会让已生成完成的任务永远匹配不上、界面卡在"正在生成"直到 1 小时超时。
describe("MiniMaxAdapter 任务状态识别", () => {
  it("识别官方的 Success 成功态并下载结果", async () => {
    stubApi([{ task: { status: "Success", content: { url: "https://cdn.minimax.test/1.mp4" }, usage: { input_seconds: 0, output_seconds: 6 } } }]);
    const result = await generateWithTimers();
    expect(result.providerTaskId).toBe("task-abc");
    expect(result.outputPath).toContain("t1.mp4");
    expect(result.usage?.outputSeconds).toBe(6);
  });

  it("兼容 succeeded / done / SUCCESS 等写法", async () => {
    for (const status of ["succeeded", "done", "SUCCESS"]) {
      stubApi([{ task: { status, content: { url: "https://cdn.minimax.test/2.mp4" } } }]);
      const result = await generateWithTimers();
      expect(result.outputPath).toContain("t1.mp4");
    }
  });

  it("Success 但暂无 content.url 时继续轮询，不提前当成功", async () => {
    stubApi([
      { task: { status: "Success", content: {} } },
      { task: { status: "Success", content: { url: "https://cdn.minimax.test/3.mp4" } } }
    ]);
    const statuses: string[] = [];
    const result = await generateWithTimers((status) => statuses.push(status));
    expect(result.outputPath).toContain("t1.mp4");
    expect(queryIndex).toBe(2); // 轮询了两次才拿到 url
    expect(statuses).toContain("running");
  });

  it("失败态带服务端原文抛出", async () => {
    stubApi([{ task: { status: "Fail", error: { message: "内容审核未通过" } } }]);
    await expect(generateWithTimers()).rejects.toThrow("内容审核未通过");
  });

  it("进行中（Processing）继续轮询直到完成", async () => {
    stubApi([
      { task: { status: "Processing" } },
      { task: { status: "Success", content: { url: "https://cdn.minimax.test/4.mp4" } } }
    ]);
    const result = await generateWithTimers();
    expect(result.outputPath).toContain("t1.mp4");
    expect(queryIndex).toBe(2);
  });
});

// 鉴权探测：401 与 403 都应判为失败。只认 401 会把 403（Key 被禁用 / 无该模型权限 /
// 地区限制）误报成"已通过鉴权"，用户看到绿色"连接成功"却根本用不了。
describe("MiniMaxAdapter.test 鉴权判定", () => {
  const stubStatus = (status: number) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status })));

  it("200 → 通过", async () => {
    stubStatus(200);
    expect((await adapter().test()).ok).toBe(true);
  });

  it("401 → 失败", async () => {
    stubStatus(401);
    expect((await adapter().test()).ok).toBe(false);
  });

  it("403 → 失败（无权限不等于已通过鉴权）", async () => {
    stubStatus(403);
    expect((await adapter().test()).ok).toBe(false);
  });
});
