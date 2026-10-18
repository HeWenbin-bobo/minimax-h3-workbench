import { stat } from "node:fs/promises";
import path from "node:path";
import { H3_MODEL_REQUIREMENTS } from "../backends/comfyReadiness";
import type { ResourceLink } from "../../shared/types";

export interface LocalModelStatus {
  id: string;
  name: string;
  directory: string; // ComfyUI 根的相对目录，如 "models/diffusion_models/"
  fullPath: string; // 期望的绝对路径
  present: boolean;
  sizeBytes?: number;
  downloadUrl?: string;
}

// RESOURCE_LINKS 中 id → H3 模型 key 的对应（用于补下载链接）。
const LINK_BY_KEY: Record<string, (typeof H3_MODEL_REQUIREMENTS)[number]["key"]> = {
  "h3-fl2va-int8": "fl2va",
  "h3-ref2va-int8": "ref2va",
  "h3-text-encoder": "clip",
  "h3-video-vae": "videoVae",
  "h3-audio-vae": "audioVae"
};

// 检查用户指定 ComfyUI 根目录下 5 个 H3 模型文件是否已放好。根目录为空时返回未配置状态。
export async function checkLocalModels(comfyuiRoot: string, links: ResourceLink[]): Promise<LocalModelStatus[]> {
  if (!comfyuiRoot) return [];
  // **根目录不存在就返回空数组**，而不是"5 个模型都不在"。
  // 用户选错目录（选成了上级目录、或盘符已卸载）时逐个 stat 会全部失败，
  // 界面显示「0 / 5 个模型已就位 + 请点击下方下载模型」，把他引向"去下载模型"——
  // 而真实问题是目录根本不对，下载了也放不进去。
  // 空数组在界面上对应「未能读取模型清单（目录不可访问或检查失败），请重新选择」。
  const rootInfo = await stat(comfyuiRoot).catch(() => undefined);
  if (!rootInfo?.isDirectory()) return [];
  const byLink = new Map(links.filter((l) => l.action === "download").map((l) => [l.id, l]));
  return Promise.all(
    H3_MODEL_REQUIREMENTS.map(async (requirement) => {
      const linkId = Object.entries(LINK_BY_KEY).find(([, key]) => key === requirement.key)?.[0];
      const link = linkId ? byLink.get(linkId) : undefined;
      const subDir = requirement.directory.replace(/^ComfyUI\//, "");
      const fullPath = path.join(comfyuiRoot, subDir, requirement.name);
      let present = false;
      let sizeBytes: number | undefined;
      try {
        const info = await stat(fullPath);
        present = info.isFile();
        sizeBytes = info.size;
      } catch {
        present = false;
      }
      return {
        id: linkId ?? requirement.key,
        name: requirement.name,
        directory: subDir,
        fullPath,
        present,
        sizeBytes,
        downloadUrl: link?.url
      };
    })
  );
}
