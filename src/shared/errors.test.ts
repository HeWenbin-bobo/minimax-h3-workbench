import { describe, expect, it } from "vitest";
import { describeError, isNetworkError, isRetriableLoadAbort } from "./errors";

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

  // **cause 非空 ≠ 网络错误**（实测缺口）。业务代码普遍用 `new Error(msg, { cause })`，
  // AI SDK 的 JSONParseError 也把 SyntaxError 塞在 cause 里（上游返回 HTML 错误页时）。
  // 旧实现只要 `cause.code ?? cause.message` 非空就拼成「网络连接失败」，
  // 用户被引去查端口，真实原因（配额用尽 / 被网关拦截）一个字都看不到。
  it("业务异常带自己的 cause 时不误报成网络错误", () => {
    const quota = new Error("保存失败", { cause: Object.assign(new Error("配额已用尽"), { code: "ERR_QUOTA" }) });
    expect(describeError(quota, "兜底")).toBe("保存失败");
    expect(isNetworkError(quota)).toBe(false);
  });

  it("上游返回 HTML 错误页（AI_JSONParseError）时不报成网络故障", () => {
    const jsonParse = Object.assign(
      new Error("JSON parsing failed: Text: <html><body>502 Bad Gateway</body></html>"),
      { name: "AI_JSONParseError", cause: new SyntaxError("Unexpected token '<'") }
    );
    const text = describeError(jsonParse, "兜底");
    expect(text).not.toContain("网络连接失败");
    expect(text).not.toContain("请检查地址");
    expect(isNetworkError(jsonParse)).toBe(false);
  });

  // fetch 对被禁端口（WHATWG bad port 清单）直接拒绝，抛的是**无 code**、
  // cause.message 为 "bad port" 的 TypeError。实测（probe-badport）未收录时界面显示
  // 「网络错误 bad port」——中英混排，且用户不知道是自己填的端口有问题。
  it("被禁端口（bad port）给出中文提示，不透出英文 bad port", () => {
    const error = new Error("fetch failed");
    (error as { cause?: unknown }).cause = new Error("bad port");
    const text = describeError(error, "兜底");
    expect(text).toContain("端口");
    expect(text).not.toContain("bad port");
  });

  // 地址漏写 http:// 时 undici 抛 `TypeError: Failed to parse URL from abc/v1/models`，
  // cause 是 "Invalid URL"。旧实现会拼成「网络错误 Invalid URL。请检查地址、端口与服务是否已启动。」
  // ——中英混排，还把用户引向"服务没起来"，而真实原因是地址格式不对。
  it("地址格式错误时给出可执行的提示，不出现 Invalid URL 或端口排查建议", () => {
    const error = new Error("Failed to parse URL from abc/v1/models");
    (error as { cause?: unknown }).cause = new Error("Invalid URL");
    const text = describeError(error, "兜底");
    expect(text).toContain("接口地址格式不正确");
    expect(text).toContain("http://");
    expect(text).not.toContain("Invalid URL");
    expect(text).not.toContain("端口");
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
/**
 * 用户报「工作台启动失败」时截的图里，弹窗内容是
 * `ERR_ABORTED (-3) loading 'file:///…/dist/index.html'`。
 *
 * 这个码的语义是**本次导航被取消**，不是文件不存在（-6）。受控复现（Electron 43）：
 * 加载发起后 30ms 再发起一次导航 → 首次 loadFile 立刻 -3 失败 → 紧接着重试一次就成功。
 * 所以它是"再来一次就好"的那类，必须在 loadApp 里自动重试，而不是弹窗把用户挡在门外。
 */
describe("isRetriableLoadAbort", () => {
  it("ERR_ABORTED（code 字段）判定为可重试", () => {
    const error = Object.assign(new Error("ERR_ABORTED (-3) loading 'file:///x/dist/index.html'"), { code: "ERR_ABORTED" });
    expect(isRetriableLoadAbort(error)).toBe(true);
  });

  it("只有 message 带 ERR_ABORTED 也认（Electron 有些路径不带 code）", () => {
    expect(isRetriableLoadAbort(new Error("ERR_ABORTED (-3) loading 'file:///x/dist/index.html'"))).toBe(true);
  });

  it("文件不存在不能当成可重试（重试必然同样失败，白让用户等）", () => {
    const error = Object.assign(new Error("ERR_FILE_NOT_FOUND (-6) loading 'file:///x/dist/index.html'"), { code: "ERR_FILE_NOT_FOUND" });
    expect(isRetriableLoadAbort(error)).toBe(false);
  });

  it("其它加载失败码都不重试", () => {
    for (const code of ["ERR_ACCESS_DENIED", "ERR_CONNECTION_REFUSED", "ERR_FAILED", "ERR_NAME_NOT_RESOLVED"]) {
      expect(isRetriableLoadAbort(Object.assign(new Error(code), { code })), code).toBe(false);
    }
  });

  it("脏入参不抛错（错误对象可能不是 Error、甚至不是对象）", () => {
    for (const value of [null, undefined, 0, "", "ERR_ABORTED", [], {}]) {
      expect(() => isRetriableLoadAbort(value)).not.toThrow();
    }
    // 字符串形式（非对象）不认——那是调用方传错，不该据此触发重试
    expect(isRetriableLoadAbort("ERR_ABORTED (-3)")).toBe(false);
  });
});
