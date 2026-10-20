import { describe, expect, it } from "vitest";
import { backendAvailability, normalizeBackendKind } from "./adapterRegistry";

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

/**
 * 实测缺陷（probe-nocred-backend，2026-10-20）：用户说"用云端生成"，模型调
 * `generate_video({backend:"minimax"})`，而这台机器没存 MiniMax Key。
 * `submit()` 只校验参数就把任务建出来 → 回执「已创建 1 个视频生成任务」→
 * 随后 runTask 抛「请先保存 АРI keys」→ 模型据此对用户说"已经帮你提交了"，
 * 卡片却是 failed。这条判定必须**在 submit 之前**回答"这个后端现在能不能用"。
 */
describe("backendAvailability", () => {
  const settings = { localComfyUrl: "", ssh: { host: "", username: "" } };
  const none = async () => false;

  it("什么都没配时四个都不可用，且各自给出原因", async () => {
    const list = await backendAvailability(settings, none);
    expect(list.map((e) => e.kind)).toEqual(["local", "ssh", "minimax", "rb"]);
    for (const entry of list) expect(entry.reason, entry.kind).toBeTruthy();
    // 原因要能直接给用户看：必须指向具体的配置项，不能只说"不可用"。
    expect(list.find((e) => e.kind === "minimax")!.reason).toContain("MiniMax");
    expect(list.find((e) => e.kind === "rb")!.reason).toContain("瞬映");
    expect(list.find((e) => e.kind === "local")!.reason).toContain("ComfyUI");
    expect(list.find((e) => e.kind === "ssh")!.reason).toContain("SSH");
  });

  it("配好之后对应后端不再带 reason（调用方据此筛出可选项）", async () => {
    const list = await backendAvailability(
      { localComfyUrl: "http://127.0.0.1:8188", ssh: { host: "10.0.0.2", username: "me" } },
      async (name) => name === "rbCardCode"
    );
    expect(list.filter((e) => !e.reason).map((e) => e.kind)).toEqual(["local", "ssh", "rb"]);
  });

  it("只有主机没有用户名时 SSH 仍算不可用（连不上，等于没配）", async () => {
    const list = await backendAvailability({ localComfyUrl: "", ssh: { host: "10.0.0.2", username: "" } }, none);
    expect(list.find((e) => e.kind === "ssh")!.reason).toBeTruthy();
  });

  it("hasSecret 抛错时算「没有」，不能把异常冒成整轮失败", async () => {
    // 换机器 / Local State 丢失时 safeStorage 解不开，hasSecret 会抛。
    // 让异常穿出去会连"告诉模型哪些可用"这一步都做不成。
    const list = await backendAvailability(
      { localComfyUrl: "http://127.0.0.1:8188", ssh: { host: "", username: "" } },
      async () => {
        throw new Error("decrypt failed");
      }
    );
    expect(list.filter((e) => !e.reason).map((e) => e.kind)).toEqual(["local"]);
  });
});
