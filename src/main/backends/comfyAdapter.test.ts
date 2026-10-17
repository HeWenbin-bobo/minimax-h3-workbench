import { afterEach, describe, expect, it, vi } from "vitest";
import type { GenerationRequest, GenerationTask } from "../../shared/types";
import { ComfyAdapter } from "./comfyAdapter";

const request: GenerationRequest = {
  mode: "text",
  backend: "local",
  prompt: "A cinematic tracking shot",
  duration: 4,
  ratio: "16:9",
  resolution: "768P",
  width: 1280,
  height: 720,
  count: 4,
  baseSeed: 42
};

const task: GenerationTask = {
  id: "task-1",
  parentId: "group-1",
  index: 0,
  seed: 42,
  backend: "local",
  mode: "text",
  status: "queued",
  progress: 0,
  prompt: request.prompt,
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z"
};

afterEach(() => vi.unstubAllGlobals());

describe("ComfyAdapter readiness", () => {
  it("reports the exact missing H3 models instead of a false successful connection", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/system_stats")) return json({ system: { comfyui_version: "0.31.0" } });
      if (url.endsWith("/object_info")) return json(objectInfo({
        diffusion: [],
        textEncoders: [],
        vaes: []
      }));
      throw new Error(`Unexpected request: ${url}`);
    }));

    const result = await adapter().test();

    expect(result.ok).toBe(false);
    expect(result.message).toContain("缺少 5 个 H3 模型文件");
    expect(result.details.missingModels).toEqual([
      "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
      "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
      "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
      "minimax_h3_video_vae_fp16.safetensors",
      "minimax_h3_audio_vae_fp32.safetensors"
    ]);
  });

  it("accepts a complete H3 installation", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/system_stats")) return json({ system: { comfyui_version: "0.31.0" } });
      if (url.endsWith("/object_info")) return json(objectInfo({
        diffusion: [
          "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
          "minimax_h3_ref2va_pruned_int8_convrot.safetensors"
        ],
        textEncoders: ["qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"],
        vaes: ["minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae_fp32.safetensors"]
      }));
      throw new Error(`Unexpected request: ${url}`);
    }));

    const result = await adapter().test();

    expect(result.ok).toBe(true);
    expect(result.message).toContain("节点与 5 个模型文件均已就绪");
  });

  it("blocks generation before /prompt when the required model is missing", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/object_info")) return json(objectInfo({
        diffusion: [],
        textEncoders: ["qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"],
        vaes: ["minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae_fp32.safetensors"]
      }));
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(adapter().generate(request, task, () => undefined)).rejects.toThrow(
      "minimax_h3_fl2va_pruned_int8_convrot.safetensors"
    );
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/prompt"))).toBe(false);
  });
});

// 取消链路必须自带超时：tasks:cancel 是等待返回的 IPC，ComfyUI 无响应时裸 fetch
// 永不落定，用户点了「停止」界面一直转圈、任务也停不下来。
describe("ComfyAdapter.cancel 超时纪律", () => {
  it("两个取消请求都带 signal（不裸 fetch）", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return new Response("{}", { status: 200 });
    }));

    await adapter().cancel("prompt-1");

    expect(signals).toHaveLength(2);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
    }
  });

  it("没有 providerTaskId 时只打 /interrupt，且同样带超时", async () => {
    const calls: string[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(String(input));
      signals.push(init?.signal ?? undefined);
      return new Response("{}", { status: 200 });
    }));

    await adapter().cancel();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/interrupt");
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  // 取消是"尽力而为"：网络错误不该把停止操作本身变成失败弹窗。
  it("上游报错时静默收尾（取消本身不抛错）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("连接被拒绝"); }));
    await expect(adapter().cancel("prompt-1")).resolves.toBeUndefined();
  });
});

function adapter(): ComfyAdapter {
  return new ComfyAdapter({ baseUrl: "http://127.0.0.1:8188", outputDirectory: "/tmp" });
}

function objectInfo(files: { diffusion: string[]; textEncoders: string[]; vaes: string[] }) {
  return {
    MiniMaxH3ImageToVideo: {},
    MiniMaxH3ReferenceToVideo: {},
    UNETLoader: { input: { required: { unet_name: [files.diffusion] } } },
    CLIPLoader: { input: { required: { clip_name: [files.textEncoders] } } },
    VAELoader: { input: { required: { vae_name: [files.vaes] } } }
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

// 任务已完成但没有媒体产物时必须立刻失败，而不是轮询到 30 分钟超时。
// 实测场景：工作流跑完了、outputs 为空（输出节点没接保存/预览节点）。
// 旧实现只认 status_str === "error"，这种"成功但没东西"会被当成"还在跑"。
describe("ComfyAdapter 完成但无产物", () => {
  it("status=success 且 outputs 为空时立即报错（不干等超时）", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/object_info")) return json(objectInfo({
        diffusion: [
          "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
          "minimax_h3_ref2va_pruned_int8_convrot.safetensors"
        ],
        textEncoders: ["qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"],
        vaes: ["minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae_fp32.safetensors"]
      }));
      if (url.endsWith("/prompt")) return json({ prompt_id: "p1" });
      if (url.includes("/history/")) {
        return json({ p1: { outputs: {}, status: { status_str: "success", completed: true } } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const startedAt = Date.now();
    await expect(adapter().generate(request, task, () => undefined)).rejects.toThrow(/没有产出视频/);
    // 不能是"轮询到超时"的路径：超时是 30 分钟，这里必须秒回。
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  // 轮询间隔是 3 秒真实等待，这里只走一轮（1 次 delay），并给足超时。
  it("status 未完成（仍在跑）时不报错，继续轮询", async () => {
    let historyHits = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/object_info")) return json(objectInfo({
        diffusion: [
          "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
          "minimax_h3_ref2va_pruned_int8_convrot.safetensors"
        ],
        textEncoders: ["qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"],
        vaes: ["minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae_fp32.safetensors"]
      }));
      if (url.endsWith("/prompt")) return json({ prompt_id: "p1" });
      if (url.includes("/history/")) {
        historyHits += 1;
        // 第一次"还在跑"，第二次给结果——只经历一次 3 秒轮询间隔
        if (historyHits < 2) return json({ p1: { outputs: {}, status: { status_str: "running" } } });
        return json({ p1: { outputs: { save: [{ filename: "out.mp4", type: "output" }] }, status: { status_str: "success" } } });
      }
      if (url.includes("/view?")) return new Response(new Uint8Array([0, 1, 2]), { status: 200 });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await adapter().generate(request, task, () => undefined);
    expect(result.outputPath).toContain("task-1.mp4");
    expect(historyHits).toBe(2);
  }, 15_000);
});

// 切换模式后 `request.*Path` 里的旧值仍在。图生视频模式若把残留尾帧也传进去，
// buildFl2vaWorkflow 会照样生成 lastImage 节点 —— 首帧来自参考图、尾帧却来自
// 上次文生视频残留的文件（实测确认该工作流会挂上 last_frame）。
describe("ComfyAdapter 按模式取素材", () => {
  it("image 模式只上传参考图，不碰残留的首帧/尾帧", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const pathMod = await import("node:path");
    const dir = await mkdtemp(pathMod.join(tmpdir(), "h3-comfy-"));
    const img = pathMod.join(dir, "ref.png");
    await writeFile(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const uploads: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/upload/image")) {
        const form = init?.body as FormData;
        const file = form.get("image") as File;
        uploads.push(file.name);
        return json({ name: file.name, subfolder: "", type: "input" });
      }
      if (url.endsWith("/object_info")) return json(objectInfo({
        diffusion: ["minimax_h3_fl2va_pruned_int8_convrot.safetensors", "minimax_h3_ref2va_pruned_int8_convrot.safetensors"],
        textEncoders: ["qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"],
        vaes: ["minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae_fp32.safetensors"]
      }));
      if (url.endsWith("/prompt")) return json({ prompt_id: "p1" });
      if (url.includes("/history/")) return json({ p1: { outputs: { save: [{ filename: "o.mp4", type: "output" }] }, status: { status_str: "success" } } });
      if (url.includes("/view?")) return new Response(new Uint8Array([0]), { status: 200 });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await adapter().generate(
      { ...request, mode: "image", sourceImagePath: img, firstFramePath: img, lastFramePath: img },
      task,
      () => undefined
    );

    // 只应上传一次（参考图）；首帧/尾帧的残留路径不该被碰
    expect(uploads).toHaveLength(1);
  });
});
