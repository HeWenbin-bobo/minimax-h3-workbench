import { describe, it, expect } from "vitest";
import { normalizeHistory, supportsImages } from "./historyNormalize";
import type { ChatMessage } from "../../shared/types";

const msg = (role: ChatMessage["role"], content: string, images?: string[]): ChatMessage => ({ role, content, images });

describe("supportsImages", () => {
  it("视觉模型家族识别为支持图片", () => {
    expect(supportsImages("qwen-vl-max")).toBe(true);
    expect(supportsImages("gpt-4o")).toBe(true);
    expect(supportsImages("claude-sonnet-4")).toBe(true);
    expect(supportsImages("glm-4v")).toBe(true);
  });

  it("纯文本模型识别为不支持", () => {
    expect(supportsImages("deepseek-chat")).toBe(false);
    expect(supportsImages("glm-4.6")).toBe(false);
    expect(supportsImages("")).toBe(false);
  });
});

describe("normalizeHistory", () => {
  it("支持图片的模型原样保留图片", () => {
    const result = normalizeHistory([msg("user", "看这张", ["data:image/png;base64,AAA"])], { model: "qwen-vl-max" });
    expect(result.messages[0].images).toHaveLength(1);
    expect(result.notes).toEqual([]);
  });

  it("不支持图片的模型剥掉图片，并如实告知（静默改动用户输入不可接受）", () => {
    const result = normalizeHistory([msg("user", "看这张", ["data:image/png;base64,AAA"])], { model: "deepseek-chat" });
    expect(result.messages[0].images).toBeUndefined();
    expect(result.messages[0].content).toBe("看这张");
    expect(result.notes[0]).toContain("不支持图片输入");
    expect(result.notes[0]).toContain("1 张");
  });

  it("剥图后内容为空时补占位（否则又变回空 content，等于没修）", () => {
    const result = normalizeHistory([msg("user", "", ["data:image/png;base64,AAA"])], { model: "deepseek-chat" });
    expect(result.messages[0].content).toContain("不支持图片输入");
  });

  it("视觉模型下纯图片消息的占位文案不能说「不支持图片输入」（图还在，会误导模型拒答）", () => {
    const result = normalizeHistory([msg("user", "", ["data:image/png;base64,AAA"])], { model: "gpt-4o" });
    expect(result.messages[0].images).toHaveLength(1);
    expect(result.messages[0].content).not.toContain("不支持图片输入");
    // 仍须是非空 content（部分上游拒绝空 content）
    expect(result.messages[0].content.trim().length).toBeGreaterThan(0);
  });

  it("allowImages=false 时即便模型支持也剥图", () => {
    const result = normalizeHistory([msg("user", "看", ["img"])], { model: "gpt-4o", allowImages: false });
    expect(result.messages[0].images).toBeUndefined();
  });

  it("空白消息一律丢（流式途中关窗留下的残留会让上游 400）", () => {
    const result = normalizeHistory([msg("user", "在吗"), msg("assistant", ""), msg("user", "   ")], { model: "deepseek-chat" });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe("在吗");
  });

  it("首条不得是 assistant（部分上游拒绝以 assistant 开场）", () => {
    const result = normalizeHistory([msg("assistant", "上一轮失败了"), msg("user", "再来一次")], { model: "deepseek-chat" });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
  });

  it("中间位置的 assistant 消息不受影响（多轮对话正常保留）", () => {
    const input = [msg("user", "A"), msg("assistant", "B"), msg("user", "C")];
    expect(normalizeHistory(input, { model: "deepseek-chat" }).messages).toHaveLength(3);
  });

  it("不改原数组（纯函数）", () => {
    const input = [msg("user", "看", ["img"])];
    normalizeHistory(input, { model: "deepseek-chat" });
    expect(input[0].images).toHaveLength(1);
  });

  it("全空历史返回空数组，不抛错", () => {
    expect(normalizeHistory([], { model: "deepseek-chat" }).messages).toEqual([]);
  });
});

// 漏判的代价：用户上传的图会被**静默剥掉**，只留一句"当前模型不支持图片输入"，
// 而用户明明选了视觉模型。这里锁定几类专用视觉家族。
describe("supportsImages 视觉家族覆盖", () => {
  it("专用视觉家族被识别", () => {
    for (const model of ["llava-v1.6-34b", "llava-llama3", "pixtral-12b", "idefics2", "fuyu-8b", "molmo-7b", "step-1v-8k", "cogvlm2"]) {
      expect(supportsImages(model), model).toBe(true);
    }
  });

  it("同家族的纯文本变体不被误判", () => {
    for (const model of ["llama-3.1-70b", "mistral-large", "yi-34b", "step-2-16k", "command-r-plus", "ernie-4.0", "deepseek-chat"]) {
      expect(supportsImages(model), model).toBe(false);
    }
  });
});
