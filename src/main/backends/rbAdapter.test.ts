import { describe, expect, it } from "vitest";
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
      "https://0.0.0.0/1.mp4"
    ]) {
      expect(() => assertSafeResultUrl(url), url).toThrow("内网");
    }
  });

  it("拒绝无效地址", () => {
    expect(() => assertSafeResultUrl("not-a-url")).toThrow("无效");
  });
});
