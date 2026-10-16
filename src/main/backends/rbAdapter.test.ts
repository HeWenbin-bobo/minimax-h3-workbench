import { describe, expect, it, vi } from "vitest";
import type { GenerationRequest } from "../../shared/types";
import { RbAdapter, assertSafeResultUrl } from "./rbAdapter";

const base: GenerationRequest = {
  mode: "text",
  backend: "rb",
  prompt: "一只猫在奔跑",
  duration: 8,
  ratio: "16:9",
  resolution: "768P",
  width: 1280,
  height: 720,
  count: 1,
  baseSeed: 1
};

const adapter = () => new RbAdapter({ baseUrl: "https://rb.test", cardCode: "k", outputDirectory: "/tmp" });

describe("RbAdapter.buildJobBody", () => {
  it("未指定预设时有首尾帧→tail_frame，否则 reference", () => {
    const tail = adapter().buildJobBody({ ...base, firstFramePath: "a.png", lastFramePath: "b.png" }, { images: [], videos: [] });
    expect(tail.preset).toBe("tail_frame");
    const ref = adapter().buildJobBody(base, { images: [], videos: [] });
    expect(ref.preset).toBe("reference");
    expect(ref.prompt).toBe("一只猫在奔跑");
    expect(ref.width).toBe(1280);
    expect(ref.seconds).toBe(8);
  });

  it("easy_15/30 固定画布 1344×768 与时长，忽略请求宽高", () => {
    const easy15 = adapter().buildJobBody({ ...base, preset: "easy_15" }, { images: [], videos: [] });
    expect(easy15.width).toBe(1344);
    expect(easy15.height).toBe(768);
    expect(easy15.seconds).toBe(15);
    expect(easy15.interpolate).toBeUndefined();
    const easy30 = adapter().buildJobBody({ ...base, preset: "easy_30", duration: 8 }, { images: [], videos: [] });
    expect(easy30.seconds).toBe(30);
  });

  it("reference 透传补帧与步数", () => {
    const body = adapter().buildJobBody({ ...base, interpolate: true, samplerSteps: 8 }, { images: ["r1"], videos: [] });
    expect(body.interpolate).toBe(true);
    expect(body.sampler_steps).toBe(8);
    expect(body.images).toEqual(["r1"]);
  });

  it("flashvsr_upscale 只收源视频、无 prompt；缺源视频报错", () => {
    const body = adapter().buildJobBody({ ...base, preset: "flashvsr_upscale", sourceVideoPath: "v.mp4" }, { images: [], videos: ["v1"] });
    expect(body.video).toBe("v1");
    expect(body.prompt).toBeUndefined();
    expect(body.images).toBeUndefined();
    expect(() => adapter().buildJobBody({ ...base, preset: "flashvsr_upscale" }, { images: [], videos: [] })).toThrow("源视频");
  });

  it("提交响应解包官网 {job:{id}} 包装：进入轮询而非误报提交失败", async () => {
    const fetchMock = (async (url: string | URL) => {
      const target = String(url);
      if (target.endsWith("/api/v1/jobs")) {
        return new Response(JSON.stringify({ job: { id: "job-9", status: "queued" } }), { status: 200 });
      }
      // 提交成功后进入轮询：返回 failed 以终止 generate，同时证明已越过提交阶段。
      return new Response(JSON.stringify({ job: { id: "job-9", status: "failed", message: "内容审核未通过" } }), { status: 200 });
    }) as typeof fetch;
    globalThis.fetch = fetchMock;
    const task = { id: "t1", seed: 1, prompt: base.prompt } as never;
    await expect(adapter().generate(base, task, () => undefined)).rejects.toThrow("内容审核未通过");
  });

  // 背景：rb.coolhs.com 在 Electron 下会瞬时报连接超时（实测连续 12 次请求里 5 次失败），
  // 旧实现轮询中一次抖动就抛错——云端任务仍在跑、卡密次数已扣，用户却看到"失败"。
  it("轮询中的瞬时网络抖动不终止任务，恢复后继续拿到结果", async () => {
    let polls = 0;
    const fetchMock = (async (url: string | URL) => {
      const target = String(url);
      if (target.endsWith("/api/v1/jobs")) {
        return new Response(JSON.stringify({ job: { id: "job-1" } }), { status: 200 });
      }
      if (target.endsWith("/api/v1/jobs/job-1/video")) {
        return new Response(new Uint8Array([0, 0, 0, 1]), { status: 200 });
      }
      polls += 1;
      // 前两次查询模拟连接抖动（undici 形态：cause.code = UND_ERR_CONNECT_TIMEOUT）。
      if (polls <= 2) {
        const error = new Error("fetch failed");
        (error as { cause?: unknown }).cause = { code: "UND_ERR_CONNECT_TIMEOUT" };
        throw error;
      }
      return new Response(JSON.stringify({ job: { id: "job-1", status: "succeeded", video_url: "https://rb.test/job-1/video" } }), { status: 200 });
    }) as typeof fetch;
    globalThis.fetch = fetchMock;
    const task = { id: "t1", seed: 1, prompt: base.prompt } as never;
    // 重试走 5s 退避睡眠：用假定时器推进，避免单测真等 10s+。
    vi.useFakeTimers();
    try {
      const pending = adapter().generate(base, task, () => undefined);
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await pending;
      // 抖动 2 次后恢复：不应抛错，且应下载到结果（说明是在原任务上继续轮询，而非重新提交）。
      expect(result.providerTaskId).toBe("job-1");
      expect(polls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  // 实测官网真实词汇表是 done/failed（progress 为"已完成"），不是 succeeded。
  // 旧实现只认 succeeded：任务早已 has_video=true 却永远匹配不上，界面卡在"正在生成 92%"、成片永不下载。
  it("识别官网真实成功态 done（而非只认 succeeded）并下载成片", async () => {
    const fetchMock = (async (url: string | URL) => {
      const target = String(url);
      if (target.endsWith("/api/v1/jobs")) {
        return new Response(JSON.stringify({ job: { id: "job-done" } }), { status: 200 });
      }
      if (target.endsWith("/api/v1/jobs/job-done/video")) {
        return new Response(new Uint8Array([0, 0, 0, 1]), { status: 200 });
      }
      // 官网实证响应形态：status/progress 为中英混排，has_video 为蛇形。
      return new Response(JSON.stringify({ job: { id: "job-done", status: "done", progress: "已完成", has_video: true, error: "" } }), { status: 200 });
    }) as typeof fetch;
    globalThis.fetch = fetchMock;
    const task = { id: "t3", seed: 1, prompt: base.prompt } as never;
    const result = await adapter().generate(base, task, () => undefined);
    expect(result.providerTaskId).toBe("job-done");
    expect(result.outputPath).toContain("t3.mp4");
  });

  it("连续查询全部失败时才报错，并提示任务可能仍在云端", async () => {
    const fetchMock = (async (url: string | URL) => {
      const target = String(url);
      if (target.endsWith("/api/v1/jobs")) {
        return new Response(JSON.stringify({ job: { id: "job-2" } }), { status: 200 });
      }
      const error = new Error("fetch failed");
      (error as { cause?: unknown }).cause = { code: "UND_ERR_CONNECT_TIMEOUT" };
      throw error;
    }) as typeof fetch;
    globalThis.fetch = fetchMock;
    const task = { id: "t2", seed: 1, prompt: base.prompt } as never;
    vi.useFakeTimers();
    try {
      const pending = adapter().generate(base, task, () => undefined);
      const assertion = expect(pending).rejects.toThrow(/连续 5 次查询瞬映任务失败/);
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("assertSafeResultUrl（SSRF 防护）", () => {
  it("放行公网 HTTPS 结果地址", () => {
    expect(assertSafeResultUrl("https://cdn.example.com/v/1.mp4").hostname).toBe("cdn.example.com");
  });

  it("拒绝非 HTTPS（含 http 与 file）", () => {
    expect(() => assertSafeResultUrl("http://cdn.example.com/1.mp4")).toThrow("HTTPS");
    expect(() => assertSafeResultUrl("file:///C:/Windows/win.ini")).toThrow("HTTPS");
  });

  it("拒绝回环 / 私网 / 链路本地 / 云元数据地址", () => {
    for (const url of [
      "https://127.0.0.1/1.mp4",
      "https://localhost/1.mp4",
      "https://10.0.0.8/1.mp4",
      "https://192.168.1.10/1.mp4",
      "https://172.16.5.4/1.mp4",
      "https://169.254.169.254/latest/meta-data/",
      "https://[::1]/1.mp4",
      "https://[fd00::1]/1.mp4",
      "https://0.0.0.0/1.mp4",
      // IPv4 映射的 IPv6：URL 会规范化成 [::ffff:7f00:1] 等十六进制形式，
      // 旧前缀检查漏判 → 回环/内网被放行（实测 SSRF 绕过）。
      "https://[::ffff:127.0.0.1]/1.mp4",
      "https://[::ffff:169.254.169.254]/latest/meta-data/",
      "https://[::ffff:10.0.0.8]/1.mp4",
      "https://[0:0:0:0:0:ffff:7f00:1]/1.mp4"
    ]) {
      expect(() => assertSafeResultUrl(url), url).toThrow("内网");
    }
  });

  it("拒绝无效地址", () => {
    expect(() => assertSafeResultUrl("not-a-url")).toThrow("无效");
  });
});
