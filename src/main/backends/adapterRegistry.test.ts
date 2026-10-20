import { describe, expect, it } from "vitest";
import { normalizeBackendKind } from "./adapterRegistry";

/**
 * 背景（实测真机，2026-10-20）：用户输入一段视频描述后，智能体**直接**用「连接设置」
 * 里的默认后端（常见是本机 ComfyUI）开跑，从没问过"想用哪个方式生成"。
 * `generate_video` 的后端原先是写死的 `turn.value.defaultBackend`，模型即使想按用户
 * 的选择走也没有参数可传。
 *
 * 修法是给工具加 `backend` 参数，并在这里归一——**不能用 `z.enum`**：
 * 模型写「本机」「ComfyUI」时枚举会在 `parseToolCall` 阶段拒掉整个调用
 * （本会话已修 19 处"schema 硬校验静默打死整轮"）。
 */
describe("normalizeBackendKind", () => {
  it("四个规范值原样通过", () => {
    expect(normalizeBackendKind("local")).toBe("local");
    expect(normalizeBackendKind("ssh")).toBe("ssh");
    expect(normalizeBackendKind("minimax")).toBe("minimax");
    expect(normalizeBackendKind("rb")).toBe("rb");
  });

  it("大小写与首尾空白都能容忍", () => {
    expect(normalizeBackendKind("  LOCAL  ")).toBe("local");
    expect(normalizeBackendKind("MiniMax")).toBe("minimax");
    expect(normalizeBackendKind("RB")).toBe("rb");
  });

  it("模型/用户的口语叫法也要认（否则只能报错）", () => {
    for (const [value, expected] of [
      ["comfy", "local"],
      ["comfyui", "local"],
      ["本机", "local"],
      ["本地", "local"],
      ["remote", "ssh"],
      ["远程", "ssh"],
      ["云", "minimax"],
      ["云端", "minimax"],
      ["云api", "minimax"],
      ["瞬映", "rb"],
      ["卡密", "rb"]
    ] as const) {
      expect(normalizeBackendKind(value), value).toBe(expected);
    }
  });

  it("认不出来返回 undefined（让调用方回一句可选清单，而不是悄悄用默认后端）", () => {
    // **这是关键契约**：静默回落会让"用户以为选了云端、实际跑在本机"——
    // 账与结果都完全不同，而且用户看不出任何异常。
    for (const value of ["openai", "gpt", "", "   ", "cloud-x", "midjourney"]) {
      expect(normalizeBackendKind(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it("非字符串输入不抛错（参数来自模型，类型没有保证）", () => {
    for (const value of [null, undefined, 42, {}, [], true]) {
      expect(normalizeBackendKind(value)).toBeUndefined();
    }
  });
});
