import { readFile, stat } from "node:fs/promises";

/**
 * 参考素材单文件上限。取自 PRD 的 V2V 约束（"单文件不超过 50MB"），
 * 与 MiniMax 云 API 的既有校验一致。
 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * 读取待上传的素材文件，**先验大小再读**。
 *
 * 为什么顺序重要：三个后端（local/ssh 的 ComfyUI、RB、MiniMax）都需要把文件整个
 * 读进内存再塞进 multipart / data URL。旧实现是"先 `readFile` 再判大小"——
 * 用户选了一个几 GB 的视频时，判断还没执行，进程内存已经被撑爆
 * （Electron 主进程 OOM 会直接闪退，连错误提示都来不及给）。
 *
 * 用 `stat` 拿到大小只花一次元数据查询，代价可忽略。
 */
export async function readUploadFile(filePath: string, label = "参考素材"): Promise<Buffer> {
  const info = await stat(filePath).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`${label}不存在或不是文件。`);
  if (info.size > MAX_UPLOAD_BYTES) {
    throw new Error(`${label}超过 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB 上限，请压缩或改用公网 URL。`);
  }
  return readFile(filePath);
}
