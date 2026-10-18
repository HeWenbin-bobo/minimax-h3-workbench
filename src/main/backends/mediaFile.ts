import { readFile, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

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

/**
 * 把下载响应**流式**写入文件。
 *
 * 为什么不能沿用 `writeFile(target, Buffer.from(await response.arrayBuffer()))`：
 * 那是把整段视频先读进内存——2K 长片动辄数百 MB，主进程会被直接压垮，
 * 而 Electron 是**静默闪退**（连"下载失败"都来不及提示）。
 * ComfyUI / MiniMax / RB 三个后端都有这条下载路径，所以抽到一处。
 *
 * `Readable.fromWeb` 只做转换不缓冲，`pipeline` 负责背压与错误传递；
 * 中途失败会删掉半截文件，避免留下一个打不开却占盘的文件。
 */
export async function saveResponseToFile(response: Response, targetPath: string): Promise<void> {
  if (!response.body) throw new Error("下载响应没有内容。");
  try {
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(targetPath));
  } catch (error) {
    await rm(targetPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
