import type { GenerationRequest } from "./types";

/**
 * 画幅 + 分辨率 → 实际像素尺寸。
 *
 * 为什么必须现算：本地/SSH 的 ComfyUI 工作流与 RB 后端读的都是 `request.width/height`，
 * 而界面上的「画幅」「分辨率」下拉只改 `ratio` / `resolution` 两个字符串字段。
 * 此前 width/height 自初始值 1280×720 起再没变过——用户选 9:16 竖屏、选 2K，
 * 出片依然是 1280×720（实测：两个下拉的 onChange 都没碰这两个字段）。
 *
 * 取值规则：**短边固定**（720p 的定义），长边按比例算。
 * 这样 16:9 = 1280×720、4:3 = 960×720、1:1 = 720×720，符合"720P"的行业含义；
 * 用长边固定的话 21:9 会算出 1280×548（548 不是 8 的倍数，视频模型常要求 /8 对齐）。
 */
export function resolveDimensions(
  ratio: GenerationRequest["ratio"],
  resolution: GenerationRequest["resolution"]
): { width: number; height: number } {
  // 短边：768P 按 720、2K 按 1440（2K 显示器/DSLR 的通行定义，16:9 即 2560×1440）。
  const short = resolution === "2K" ? 1440 : 720;
  // adaptive 是"跟随输入素材"的语义（MiniMax 云端会按首帧自适应），
  // 本地工作流没有这个能力，落到最常用的 16:9。
  const [w, h] = (ratio === "adaptive" ? "16:9" : ratio).split(":").map(Number);
  if (!w || !h) return { width: align8((short * 16) / 9), height: short };
  const landscape = w >= h;
  return landscape
    ? { width: align8((short * w) / h), height: short }
    : { width: short, height: align8((short * h) / w) };
}

/** 视频模型对宽高通常要求 8 的倍数；向上取整避免出现 21:9 的 548 这种值。 */
function align8(value: number): number {
  return Math.ceil(value / 8) * 8;
}
