import { describe, expect, it } from "vitest";
import { describeError, isNetworkError } from "./errors";

// 背景：undici 的裸 "fetch failed" 会一路透传到卡片/toast/聊天气泡，用户看不懂也定位不了。
// 这里固化"网络层英文异常必须翻成中文、业务异常必须原样保留"两条契约。
function withCause(code: string): Error {
  const error = new Error("fetch failed");
  (error as { cause?: unknown }).cause = { code };
  return error;
}

describe("describeError", () => {
  it("把 undici 的 fetch failed 翻成中文并给出排查方向", () => {
    const text = describeError(new Error("fetch failed"), "兜底");
    expect(text).toContain("网络连接失败");
    expect(text).toContain("请检查地址");
    expect(text).not.toContain("fetch failed");
  });

  it("按 cause.code 区分连接被拒/域名解析失败", () => {
    expect(describeError(withCause("ECONNREFUSED"), "兜底")).toContain("连接被拒绝");
    expect(describeError(withCause("ENOTFOUND"), "兜底")).toContain("域名无法解析");
  });

  it("未收录的 errno 也保持中文骨架，不吐裸英文码", () => {
    const text = describeError(withCause("EWEIRD"), "兜底");
    expect(text).toContain("网络错误 EWEIRD");
    expect(text).toContain("请检查地址");
  });

  // AI SDK 的 APICallError 把 errno 拼在 message 里而不是 cause.code——
  // 实测 "Cannot connect to API: read ECONNRESET" 曾以裸英文透传到游乐场气泡。
  it("识别 message 内嵌的 errno（AI SDK APICallError 形态）", () => {
    const text = describeError(new Error("Cannot connect to API: read ECONNRESET"), "兜底");
    expect(text).toContain("连接被对方重置");
    expect(text).not.toContain("ECONNRESET");
    expect(describeError(new Error("Cannot connect to API"), "兜底")).toContain("网络连接失败");
  });

  it("超时与用户主动取消分开表述", () => {
    expect(describeError(new DOMException("x", "TimeoutError"), "兜底")).toContain("连接超时");
    expect(describeError(new DOMException("x", "AbortError"), "兜底")).toBe("操作已取消。");
  });

  it("业务异常（本来就是中文）原样返回，不被二次包装", () => {
    expect(describeError(new Error("尚未保存瞬映卡密。"), "兜底")).toBe("尚未保存瞬映卡密。");
  });

  // AI SDK 的包裹层把真实原因藏起来了：重试失败只留 "Failed after N attempts. Last error: ..."，
  // 流失败更是只剩 "No output generated"，两者直接透传对用户都等于没信息。
  it("展开 AI SDK 的重试包裹，保留真实原因", () => {
    const text = describeError(new Error("Failed after 2 attempts. Last error: AI_APICallError: Internal Server Error"), "兜底");
    expect(text).toContain("Internal Server Error");
    expect(text).toContain("已重试");
    expect(text).not.toContain("Failed after");
  });

  it("AI SDK 的无输出占位文案换成可读说明", () => {
    const text = describeError(new Error("No output generated. Check the stream for errors."), "兜底");
    expect(text).toContain("上游未返回任何内容");
    expect(text).not.toContain("No output generated");
  });

  it("非 Error 且为空时用兜底文案", () => {
    expect(describeError(undefined, "操作失败")).toBe("操作失败");
    expect(describeError("", "操作失败")).toBe("操作失败");
    expect(describeError("自定义字符串", "操作失败")).toBe("自定义字符串");
  });
});

// 背景：智能体是多步工具循环，中转偶发连接重置会把整轮打挂并回落普通对话（用户报的
// "智能体模式请求失败：连接被对方重置…已自动改用普通对话模式"）。主进程据此判定是否"整轮重试"，
// 所以"哪些异常算网络错误"必须判准：漏判 → 不重试；误判 → 把 5xx 也重试、拖慢失败反馈。
describe("isNetworkError", () => {
  it("识别 errno（cause.code）与 undici 形态", () => {
    const econn = Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } });
    expect(isNetworkError(econn)).toBe(true);
    const undici = Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
    expect(isNetworkError(undici)).toBe(true);
  });

  // 流式中途被对端断开时，undici 的 cause 是 message="terminated"（没有 code），
  // AI SDK 只抛 "Failed to process successful response" —— 早期实现只认 cause.code 会漏判。
  it("识别流式中途断开（cause.message=terminated，无 code）", () => {
    const mid = Object.assign(new Error("Failed to process successful response"), { name: "AI_APICallError", cause: new Error("terminated") });
    expect(isNetworkError(mid)).toBe(true);
    expect(describeError(mid, "兜底")).toContain("网络连接失败");
    expect(describeError(mid, "兜底")).not.toContain("terminated");
  });

  it("兼容 cause 为字符串的形态", () => {
    const mid = Object.assign(new Error("Failed to process successful response"), { cause: "terminated" });
    expect(isNetworkError(mid)).toBe(true);
  });

  it("识别 AI SDK 包裹层里的网络原因", () => {
    expect(isNetworkError(new Error("Failed after 2 attempts. Last error: AI_APICallError: read ECONNRESET"))).toBe(true);
  });

  it("超时算网络错误、用户取消不算", () => {
    expect(isNetworkError(new DOMException("x", "TimeoutError"))).toBe(true);
    expect(isNetworkError(new DOMException("x", "AbortError"))).toBe(false);
  });

  it("HTTP 5xx 与业务异常不算网络错误（避免把服务端报错也整轮重试）", () => {
    expect(isNetworkError(new Error("Failed after 2 attempts. Last error: AI_APICallError: Internal Server Error"))).toBe(false);
    expect(isNetworkError(new Error("尚未保存瞬映卡密。"))).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
  });
});

// 文件系统 errno 也必须翻成中文：保存产物 / 写设置 / 删回收站文件都会碰到，
// 裸英文（"ENOSPC: no space left on device, write"）用户看不懂也不知道该怎么办。
describe("describeError 文件系统错误", () => {
  const fsError = (message: string, code?: string) => Object.assign(new Error(message), code ? { code } : {});

  it("磁盘满 → 中文原因 + 英文细节", () => {
    const text = describeError(fsError("ENOSPC: no space left on device, write", "ENOSPC"), "兜底");
    expect(text).toContain("磁盘空间不足");
    expect(text).toContain("no space left");
  });

  it("权限不足（EACCES / EPERM）", () => {
    expect(describeError(fsError("EACCES: permission denied", "EACCES"), "兜底")).toContain("没有访问权限");
    expect(describeError(fsError("EPERM: operation not permitted", "EPERM"), "兜底")).toContain("权限不足");
  });

  it("文件被占用 / 路径是目录", () => {
    expect(describeError(fsError("EBUSY: resource busy", "EBUSY"), "兜底")).toContain("被其他程序占用");
    expect(describeError(fsError("EISDIR: illegal operation on a directory", "EISDIR"), "兜底")).toContain("是一个目录");
  });

  it("没有 code 字段时按 message 里的 errno 令牌识别", () => {
    expect(describeError(fsError("ENOSPC: no space left on device, write"), "兜底")).toContain("磁盘空间不足");
  });

  it("普通业务异常仍原样返回（不误判）", () => {
    expect(describeError(new Error("尚未保存瞬映卡密。"), "兜底")).toBe("尚未保存瞬映卡密。");
  });
});
