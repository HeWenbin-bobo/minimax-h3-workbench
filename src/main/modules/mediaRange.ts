/**
 * Range 请求解析（h3media 协议用）。
 *
 * 为什么必须自己做：`net.fetch(pathToFileURL(...))` 拿到的响应**不支持 Range**——
 * 实测（探针 h3media-range）带 `Range: bytes=100-199` 仍返回 200、524288 字节，
 * 且没有 Content-Range / Accept-Ranges。后果是视频**拖动进度条失效**
 * （浏览器拿不到 206，只能从头播），用户以为视频坏了或软件卡了。
 *
 * 只服务本地已校验路径的文件，只需处理单区间（多区间用不到，按整文件回即可）。
 */

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * @param header `Range` 请求头原文，如 `bytes=0-1023`、`bytes=1024-`、`bytes=-512`
 * @param size 文件总字节数
 * @returns 合法区间 / `"invalid"`（语法对但不可满足，应回 416） / `undefined`（无 Range 或语法不认，回整文件）
 */
export function parseByteRange(header: string | null | undefined, size: number): ByteRange | "invalid" | undefined {
  if (!header || size <= 0) return undefined;
  // 只处理单区间，且必须是 bytes 单位。多区间（`bytes=0-1,5-6`）按整文件回，
  // 因为 <video> 从不用它，实现多段反而增加出错面。
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return undefined;

  // `bytes=-N`：最后 N 字节。
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= size) return "invalid";
  // `bytes=N-`：从 N 到文件末尾。
  if (!rawEnd) return { start, end: size - 1 };

  const end = Math.min(Number(rawEnd), size - 1);
  if (!Number.isFinite(end) || end < start) return "invalid";
  return { start, end };
}

/** 文件扩展名 → MIME。生成结果可能是 mp4/mov/webm/mkv，也可能是音频（ComfyUI 的 H3 出音轨）。 */
export function mediaMime(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".mkv")) return "video/x-matroska";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".flac")) return "audio/flac";
  // 未知类型交给浏览器嗅探：之前的 net.fetch 也是这么做的，不要硬塞 text/plain。
  return "application/octet-stream";
}
