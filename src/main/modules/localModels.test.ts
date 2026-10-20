import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { H3_MODEL_REQUIREMENTS } from "../backends/comfyReadiness";
import { checkLocalModels } from "./localModels";
import type { ResourceLink } from "../../shared/types";

/**
 * 模型「是否就位」的判定。
 *
 * 实测缺口（2026-10-21）：H3 的 5 个模型从 605MB 到 21GB 不等
 * （见 `shared/resourceLinks.ts` 的 sizeBytes）。下载中断留下的 **0 字节**
 * 或**半截**文件在磁盘上同样是"一个普通文件"，旧判定 `info.isFile()` 会算成"已就位"。
 *
 * 用户于是看到「✓ 已就位 / 5 / 5 个模型已就位，全部就绪」，
 * 直到点生成才失败——而 ComfyUI 对坏文件的报错往往难以读懂。
 */

/**
 * 合成链接：用**小体积**代替真实 GB 级的 sizeBytes。
 *
 * 为什么不照抄真实体积（20.9GB 等）：跑测试不可能真写一个 21GB 文件。
 * 判定逻辑只关心"实际体积 / 预期体积"这个**比例**，所以等比例缩小后语义完全一致
 * （真实值见 `shared/resourceLinks.ts`，那里是 605MB–21GB）。
 */
const LINKS: ResourceLink[] = [
  { id: "h3-fl2va-int8", label: "FL2VA", category: "model", action: "download", url: "https://example.invalid/a.safetensors", description: "", targetDirectory: "models/diffusion_models/", sizeBytes: 2048 },
  { id: "h3-ref2va-int8", label: "Ref2VA", category: "model", action: "download", url: "https://example.invalid/b.safetensors", description: "", targetDirectory: "models/diffusion_models/", sizeBytes: 2048 },
  { id: "h3-text-encoder", label: "CLIP", category: "model", action: "download", url: "https://example.invalid/c.safetensors", description: "", targetDirectory: "models/text_encoders/", sizeBytes: 2048 },
  { id: "h3-video-vae", label: "VideoVAE", category: "model", action: "download", url: "https://example.invalid/d.safetensors", description: "", targetDirectory: "models/vae/", sizeBytes: 2048 },
  { id: "h3-audio-vae", label: "AudioVAE", category: "model", action: "download", url: "https://example.invalid/e.safetensors", description: "", targetDirectory: "models/vae/", sizeBytes: 2048 }
];

/** 在临时目录里按 `H3_MODEL_REQUIREMENTS` 造出模型文件（体积可控）。 */
async function makeRoot(sizes: Record<string, number>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "h3-models-"));
  for (const requirement of H3_MODEL_REQUIREMENTS) {
    const subDir = requirement.directory.replace(/^ComfyUI\//, "");
    const dir = path.join(root, subDir);
    await mkdir(dir, { recursive: true });
    const size = sizes[requirement.key] ?? 0;
    await writeFile(path.join(root, subDir, requirement.name), Buffer.alloc(size));
  }
  return root;
}

describe("checkLocalModels", () => {
  it("根目录为空时返回空数组（未配置，不是「全部缺失」）", async () => {
    expect(await checkLocalModels("", LINKS)).toEqual([]);
  });

  it("根目录不存在时也返回空数组（目录选错 ≠ 模型没下）", async () => {
    const missing = path.join(tmpdir(), "h3-definitely-not-here-" + Date.now());
    expect(await checkLocalModels(missing, LINKS)).toEqual([]);
  });

  it("全部就位时 present 为 true", async () => {
    const root = await makeRoot(Object.fromEntries(H3_MODEL_REQUIREMENTS.map((r) => [r.key, 1024])));
    const status = await checkLocalModels(root, LINKS);
    expect(status).toHaveLength(5);
    expect(status.every((entry) => entry.present)).toBe(true);
  });

  /**
   * **核心回归**：0 字节文件是"下载被中断/创建了空文件"，不是"已就位"。
   * 旧实现 `info.isFile()` 对它返回 true，界面显示「✓ 已就位」。
   */
  it("0 字节文件不算已就位（下载中断会留下这种文件）", async () => {
    const root = await makeRoot({}); // 全部 0 字节
    const status = await checkLocalModels(root, LINKS);
    for (const entry of status) {
      expect(entry.present, `${entry.name}（${entry.sizeBytes} 字节）不该算已就位`).toBe(false);
      // 但文件确实存在：要能区分"没下载"与"下载坏了"，否则用户不知道该重下还是去找文件。
      expect(entry.sizeBytes).toBe(0);
    }
  });

  /**
   * **半截文件同样不算**：真实场景是 20.9GB 的模型下到 1KB 就断了，`isFile()` 依然为 true。
   * 判据是"至少达到预期体积的一半"（这里预期 2048，故 <1024 才算没下完）。
   */
  it("远小于预期体积的文件不算已就位", async () => {
    const root = await makeRoot({ fl2va: 512, ref2va: 512, clip: 512, videoVae: 512, audioVae: 512 });
    const status = await checkLocalModels(root, LINKS);
    // 预期 2048，实际 512（不足一半）→ 全部判为不可用
    expect(status.every((entry) => entry.present)).toBe(false);
    // 体积要如实报出来（用户据此判断"下到一半断了"）
    expect(status[0].sizeBytes).toBe(512);
  });

  it("刚好过半时算就位（留足余量，不误伤量化版本差异）", async () => {
    const root = await makeRoot({ fl2va: 1024, ref2va: 1024, clip: 1024, videoVae: 1024, audioVae: 1024 });
    const status = await checkLocalModels(root, LINKS);
    expect(status.every((entry) => entry.present)).toBe(true);
  });

  it("下载链接按 id 对应上（缺链接时退化为 key）", async () => {
    const root = await makeRoot({});
    const status = await checkLocalModels(root, LINKS);
    expect(status[0].downloadUrl).toBe("https://example.invalid/a.safetensors");
    // 不传链接时不该抛错
    const bare = await checkLocalModels(root, []);
    expect(bare).toHaveLength(5);
    expect(bare[0].downloadUrl).toBeUndefined();
  });
});
