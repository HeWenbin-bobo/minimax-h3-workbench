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

function inputChoices(nodes: JsonObject, className: string, inputName: string): string[] {
  const node = objectValue(nodes[className]);
  const input = objectValue(node?.input);
  const required = objectValue(input?.required);
  const definition = required?.[inputName];
  if (!Array.isArray(definition)) return [];
  const choices = definition[0];
  return Array.isArray(choices) ? choices.filter((value): value is string => typeof value === "string") : [];
}

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}
