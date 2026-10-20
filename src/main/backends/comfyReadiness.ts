import { H3_MODELS } from "./workflows";

type JsonObject = Record<string, unknown>;

export const H3_MODEL_REQUIREMENTS = [
  { key: "fl2va", name: H3_MODELS.fl2va, loader: "UNETLoader", input: "unet_name", directory: "ComfyUI/models/diffusion_models/" },
  { key: "ref2va", name: H3_MODELS.ref2va, loader: "UNETLoader", input: "unet_name", directory: "ComfyUI/models/diffusion_models/" },
  { key: "clip", name: H3_MODELS.clip, loader: "CLIPLoader", input: "clip_name", directory: "ComfyUI/models/text_encoders/" },
  { key: "videoVae", name: H3_MODELS.videoVae, loader: "VAELoader", input: "vae_name", directory: "ComfyUI/models/vae/" },
  { key: "audioVae", name: H3_MODELS.audioVae, loader: "VAELoader", input: "vae_name", directory: "ComfyUI/models/vae/" }
] as const;

/**
 * 判断 ComfyUI `/object_info` 里是否有 H3 节点与 5 个模型。
 *
 * **入参类型是 `unknown` 而不是 `JsonObject`**：三个调用方都直接喂 `await response.json()`。
 * ComfyUI 前面若有反向代理/门户页/错误页，返回的 JSON 可能是字符串、数组或 null——
 * 而 `"x" in "ok"` 会抛英文 `TypeError: Cannot use 'in' operator to search for ... in ok`，
 * 这条错误会原样透到界面（"测试连接"的失败原因完全不可读）。
 * 非对象一律按"没有 H3 节点"处理，语义等同"连上了但不是 ComfyUI"。
 */
export function inspectH3Readiness(input: unknown): {
  hasH3Nodes: boolean;
  missingModels: Array<(typeof H3_MODEL_REQUIREMENTS)[number]>;
} {
  const nodes = objectValue(input) ?? {};
  const hasH3Nodes = "MiniMaxH3ImageToVideo" in nodes && "MiniMaxH3ReferenceToVideo" in nodes;
  const missingModels = hasH3Nodes ? H3_MODEL_REQUIREMENTS.filter((requirement) => {
    const choices = inputChoices(nodes, requirement.loader, requirement.input);
    return !choices.some((choice) => choice === requirement.name || choice.endsWith(`/${requirement.name}`) || choice.endsWith(`\\${requirement.name}`));
  }) : [...H3_MODEL_REQUIREMENTS];
  return { hasH3Nodes, missingModels };
}

/**
 * 从 `/object_info` 的一个输入定义里取出**可选值列表**。
 *
 * 定义形如 `[<第一项>, { ...输入元信息 }]`，而"第一项"在不同 ComfyUI 版本里有三种写法：
 *
 * 1. **裸数组**（旧版）：`[["a.safetensors", "b.safetensors"], {}]`
 * 2. **COMBO 类型 + options**（新版）：`[["COMBO", { options: ["a", "b"] }], {}]`
 * 3. **字符串类型**（非下拉，例如 `["STRING", {...}]`）—— 不是选项列表，返回空
 *
 * **只认第 1 种会误报"模型缺失"**：新版返回第 2 种时，`choices` 是 `["COMBO", {...}]`，
 * 过滤出字符串后只剩 `["COMBO"]`，于是每个模型都判成"不在列表里"——
 * 用户本机模型装得好好的，界面却让他去下载 5 个模型（约 60GB）。
 * 这类"看不见版本差异就误报"的错误比不检测更糟，所以三种都要认。
 */
function inputChoices(nodes: JsonObject, className: string, inputName: string): string[] {
  const node = objectValue(nodes[className]);
  const input = objectValue(node?.input);
  const required = objectValue(input?.required);
  const definition = required?.[inputName];
  if (!Array.isArray(definition)) return [];
  const first = definition[0];
  // ① 裸数组：元素都是字符串
  if (Array.isArray(first)) {
    const strings = first.filter((value): value is string => typeof value === "string");
    // ② 新版 `["COMBO", { options: [...] }]`：首元素是类型名、次元素带 options
    if (strings.length === 1 && strings[0].toUpperCase() === "COMBO") {
      const meta = objectValue(first[1]);
      const options = meta?.options;
      return Array.isArray(options)
        ? options.filter((value): value is string => typeof value === "string")
        : [];
    }
    return strings;
  }
  // ③ `[{ options: [...] }, {...}]`（少数自定义节点把 choices 包成对象）
  const wrapped = objectValue(first);
  const options = wrapped?.options;
  return Array.isArray(options)
    ? options.filter((value): value is string => typeof value === "string")
    : [];
}

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}
