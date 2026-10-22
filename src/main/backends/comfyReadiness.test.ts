import { describe, expect, it } from "vitest";
import { H3_MODEL_REQUIREMENTS, inspectH3Readiness } from "./comfyReadiness";

/**
 * `/object_info` 的解析。
 *
 * 关键风险是**误报"模型缺失"**：本机模型装得好好的，界面却让用户去下载 5 个模型
 * （约 60GB）。而"第一项"的形状在不同 ComfyUI 版本里不一样：
 *
 * 1. 旧版裸数组：`[["a.safetensors", "b.safetensors"], {}]`
 * 2. 新版 COMBO：`[["COMBO", { options: ["a", "b"] }], {}]`
 * 3. 少数自定义节点：`[{ options: [...] }, {}]`
 *
 * 只认第 1 种时，第 2 种会被过滤成 `["COMBO"]` → 每个模型都判"不在列表里"。
 */

const NAMES = H3_MODEL_REQUIREMENTS.map((requirement) => requirement.name);

/** 按"裸数组"格式造一份齐全的 object_info。 */
function plainInfo() {
  return {
    MiniMaxH3ImageToVideo: {},
    MiniMaxH3ReferenceToVideo: {},
    UNETLoader: { input: { required: { unet_name: [[NAMES[0], NAMES[1]], {}] } } },
    CLIPLoader: { input: { required: { clip_name: [[NAMES[2]], {}] } } },
    VAELoader: { input: { required: { vae_name: [[NAMES[3], NAMES[4]], {}] } } }
  };
}

/** 按"新版 COMBO"格式造一份齐全的 object_info。 */
function comboInfo() {
  return {
    MiniMaxH3ImageToVideo: {},
    MiniMaxH3ReferenceToVideo: {},
    UNETLoader: { input: { required: { unet_name: [["COMBO", { options: [NAMES[0], NAMES[1]] }], {}] } } },
    CLIPLoader: { input: { required: { clip_name: [["COMBO", { options: [NAMES[2]] }], {}] } } },
    VAELoader: { input: { required: { vae_name: [["COMBO", { options: [NAMES[3], NAMES[4]] }], {}] } } }
  };
}

const requiredOf = (info: ReturnType<typeof plainInfo>, node: string, field: string): Record<string, unknown> =>
  (info as unknown as Record<string, { input: { required: Record<string, unknown> } }>)[node].input.required[field] as Record<string, unknown>;

describe("inspectH3Readiness", () => {
  it("H3 节点齐全 + 5 个模型齐全时没有任何缺失", () => {
    expect(inspectH3Readiness(plainInfo()).missingModels).toEqual([]);
    expect(inspectH3Readiness(plainInfo()).hasH3Nodes).toBe(true);
  });

  /**
   * **核心回归**：新版 COMBO 格式不能被判成"全部缺失"。
   * 只认裸数组时，这里会返回 5 个缺失（用户被迫去下 60GB）。
   */
  it('新版 COMBO 格式（["COMBO", {options}]) 同样能识别出模型齐全', () => {
    const result = inspectH3Readiness(comboInfo());
    expect(result.hasH3Nodes).toBe(true);
    expect(result.missingModels.map((item) => item.name)).toEqual([]);
  });

  it("{options:[...]} 包一层的写法也认", () => {
    const info = plainInfo();
    (info.UNETLoader.input.required as Record<string, unknown>).unet_name = [{ options: [NAMES[0], NAMES[1]] }, {}];
    expect(inspectH3Readiness(info).missingModels).toEqual([]);
  });

  /**
   * `values` 是**防御性兜底**，不是"某个版本的真实格式"。
   *
   * 已按真实源码核对（ComfyUI 0.3.47 `comfy_api/latest/_io.py`）：`Combo.Input.as_dict()`
   * 产出的键是 `options`，`add_to_dict_v1()` 把输入序列化成 `(类型, as_dict())`；
   * 全仓搜索**没有** `values` 这个键。早先的注释写成"少数分支这么做"是没有依据的猜测。
   *
   * 仍然保留兼容：读一个不存在的键没有副作用，而漏判会让那类用户被要求去下 60GB 模型。
   * 测试锁的是"兜底不会把坏键当成空列表"，不构成"官方支持这种格式"的声明。
   */
  it('COMBO 的选项放在 values 里时也能读到（防御性兜底）', () => {
    const info = plainInfo();
    (info.UNETLoader.input.required as Record<string, unknown>).unet_name = [["COMBO", { values: [NAMES[0], NAMES[1]] }], {}];
    (info.CLIPLoader.input.required as Record<string, unknown>).clip_name = [["COMBO", { values: [NAMES[2]] }], {}];
    (info.VAELoader.input.required as Record<string, unknown>).vae_name = [["COMBO", { values: [NAMES[3], NAMES[4]] }], {}];
    expect(inspectH3Readiness(info).missingModels).toEqual([]);
  });

  it("被包一层的 values 同样能读到", () => {
    const info = plainInfo();
    (info.UNETLoader.input.required as Record<string, unknown>).unet_name = [{ values: [NAMES[0], NAMES[1]] }, {}];
    expect(inspectH3Readiness(info).missingModels).toEqual([]);
  });

  it("options 存在但不是数组时回落到 values（不能因为坏键就判全缺）", () => {
    const info = plainInfo();
    (info.UNETLoader.input.required as Record<string, unknown>).unet_name = [["COMBO", { options: "坏的", values: [NAMES[0], NAMES[1]] }], {}];
    expect(inspectH3Readiness(info).missingModels).toEqual([]);
  });

  it("确实缺模型时要如实报出缺哪几个（不能一律）", () => {
    const info = plainInfo();
    (info.UNETLoader.input.required as Record<string, unknown>).unet_name = [[NAMES[0]], {}];
    (info.CLIPLoader.input.required as Record<string, unknown>).clip_name = [[], {}];
    const missing = inspectH3Readiness(info).missingModels.map((item) => item.name);
    expect(missing).toContain(NAMES[2]);
    expect(missing).not.toContain(NAMES[0]);
  });

  it("子目录形式的模型名也算命中（ComfyUI 会带相对路径）", () => {
    const info = plainInfo();
    (info.UNETLoader.input.required as Record<string, unknown>).unet_name = [[`minimax/${NAMES[0]}`, `minimax\\${NAMES[1]}`], {}];
    expect(inspectH3Readiness(info).missingModels).toEqual([]);
  });

  it("缺少 H3 节点时，5 个模型一律算缺失（没有节点就无从加载）", () => {
    const info = plainInfo();
    delete (info as Record<string, unknown>).MiniMaxH3ImageToVideo;
    const result = inspectH3Readiness(info);
    expect(result.hasH3Nodes).toBe(false);
    expect(result.missingModels).toHaveLength(H3_MODEL_REQUIREMENTS.length);
  });

  it("非对象输入按「没有 H3 节点」处理，不抛英文 TypeError", () => {
    for (const bad of [null, undefined, "ok", 42, [], true]) {
      expect(() => inspectH3Readiness(bad)).not.toThrow();
      expect(inspectH3Readiness(bad).hasH3Nodes, JSON.stringify(bad)).toBe(false);
    }
  });
});

/**
 * **真实形态夹具**（按本机 ComfyUI 0.3.47 源码抄下来的，不是想象出来的）：
 *
 * `nodes.py` 里 `UNETLoader.INPUT_TYPES()` 返回
 *   `{"required": {"unet_name": (folder_paths.get_filename_list("diffusion_models"), ), ...}}`
 * 而 `get_filename_list()` 的返回类型是 `list[str]`。Python 元组 `(list,)` 经 JSON 序列化后
 * 就是 `[[...], {}]`——**裸数组**，不是 `["COMBO", {...}]`。
 *
 * 这一条锁的是：普通节点（老式 `INPUT_TYPES`）走裸数组这条路，必须能读出来。
 * 它与上面的 `["COMBO", {options}]` 是**两条并存**的路径，不是"新旧版二选一"——
 * 老式节点在 0.3.47 里仍然大量存在（UNETLoader / CLIPLoader / VAELoader 都是）。
 * 早先我把 COMBO 当成"新版唯一写法"，这个夹具就是为了防止那种误解再被写回代码。
 */
describe("真实 /object_info 形态（按 ComfyUI 0.3.47 源码）", () => {
  it("普通节点走裸数组：[[...], {}] 能读出模型名", () => {
    const info = plainInfo();
    const required = info.UNETLoader.input.required as Record<string, unknown>;
    // 与 Python `(list,)` 的 JSON 序列化完全一致：第一项是数组、第二项是空对象
    required.unet_name = [[NAMES[0], NAMES[1]], {}];
    (info.VAELoader.input.required as Record<string, unknown>).vae_name = [[NAMES[3], NAMES[4]], {}];
    expect(inspectH3Readiness(info).missingModels.map((item) => item.name)).toEqual([]);
  });

  it("两种形态混在同一份 /object_info 里也要都对（真实站点就是混的）", () => {
    const info = plainInfo();
    (info.UNETLoader.input.required as Record<string, unknown>).unet_name = [[NAMES[0], NAMES[1]], {}];
    (info.CLIPLoader.input.required as Record<string, unknown>).clip_name = [["COMBO", { options: [NAMES[2]] }], {}];
    (info.VAELoader.input.required as Record<string, unknown>).vae_name = [["COMBO", { options: [NAMES[3], NAMES[4]] }], {}];
    expect(inspectH3Readiness(info).missingModels.map((item) => item.name)).toEqual([]);
  });
});
