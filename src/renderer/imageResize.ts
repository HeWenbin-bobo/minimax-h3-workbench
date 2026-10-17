/**
 * 附件图片压缩。
 *
 * 为什么必须做：主进程允许图片最大 15MB，而 base64 会膨胀到约 20MB。
 * 这些 data URL 直接进会话消息，而会话整体 `JSON.stringify` 进 localStorage
 * （配额约 5–10MB）。**一张照片就能让之后所有会话的持久化全部失败**——
 * 用户看到"本地存储空间不足"，但真实原因是某张图太大，重启后整段对话丢失。
 *
 * 长边压到 1568px 是视觉模型常用的输入上限附近（再大也只是烧 token），
 * JPEG 质量 0.85 在人眼几乎无损。一张 4000×3000 的手机照片通常从数 MB 降到数百 KB。
 *
 * 无法解码时（极少数格式、损坏文件）**原样返回**：宁可不压，也不能把用户的内容丢掉。
 */
export async function downscaleDataUrl(dataUrl: string, maxEdge = 1568, quality = 0.85): Promise<string> {
  if (!dataUrl.startsWith("data:image/")) return dataUrl;
  try {
    const image = await loadImage(dataUrl);
    const longEdge = Math.max(image.naturalWidth, image.naturalHeight);
    // 本来就不大：不重编码（避免无谓的二次有损压缩）。
    if (!longEdge || longEdge <= maxEdge) return dataUrl;

    const scale = maxEdge / longEdge;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return dataUrl;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    // PNG 透明图用 image/png 保住透明通道；其余一律 JPEG（体积优势最大）。
    const isPng = dataUrl.startsWith("data:image/png");
    const next = canvas.toDataURL(isPng ? "image/png" : "image/jpeg", quality);
    // 极端情况下重编码反而更大（小图、已高度压缩图）：保留较小的那个。
    return next.length < dataUrl.length ? next : dataUrl;
  } catch {
    return dataUrl;
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片解码失败"));
    image.src = src;
  });
}
