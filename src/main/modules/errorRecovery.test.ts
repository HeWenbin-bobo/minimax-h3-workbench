import { describe, it, expect } from "vitest";
import { contentFilterNotice, isContentFilterError, parseRetryAfter, retryDelayMs, retryNotice } from "./errorRecovery";

describe("parseRetryAfter", () => {
  it("读 retry-after 响应头（秒数）", () => {
    expect(parseRetryAfter({ responseHeaders: { "retry-after": "20" } })).toBe(20);
  });

  it("兼容大小写不同的头名", () => {
    expect(parseRetryAfter({ responseHeaders: { "Retry-After": "5" } })).toBe(5);
  });

  it("兼容 HTTP-date 格式", () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    const parsed = parseRetryAfter({ responseHeaders: { "retry-after": future } });
    expect(parsed).toBeGreaterThan(25);
    expect(parsed).toBeLessThan(35);
  });

  it("上游只写在文案里时也能提取", () => {
    expect(parseRetryAfter({ message: "Rate limited. Please retry after 12 seconds." })).toBe(12);
  });

  it("拿不到时返回 undefined（不猜）", () => {
    expect(parseRetryAfter({ message: "boom" })).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("字符串错误")).toBeUndefined();
  });
});

describe("retryDelayMs", () => {
  it("服务端建议更久时听服务端的", () => {
    expect(retryDelayMs({ responseHeaders: { "retry-after": "15" } }, 3_000)).toBe(15_000);
  });

  it("服务端没建议时用自己的退避（背靠背重试会撞进同一个抖动窗口）", () => {
    expect(retryDelayMs({}, 3_000)).toBe(3_000);
  });

  it("服务端建议比自己的退避更短时用自己的（不提前撞墙）", () => {
    expect(retryDelayMs({ responseHeaders: { "retry-after": "1" } }, 3_000)).toBe(3_000);
  });

  it("服务端建议过长时不采纳——我们不延长重试次数，等 5 分钟等于放弃这一轮", () => {
    expect(retryDelayMs({ responseHeaders: { "retry-after": "300" } }, 3_000)).toBe(3_000);
  });

  it("上限可按需放宽", () => {
    expect(retryDelayMs({ responseHeaders: { "retry-after": "60" } }, 3_000, 120_000)).toBe(60_000);
  });
});

describe("isContentFilterError", () => {
  it("识别安全策略类措辞", () => {
    expect(isContentFilterError({ message: "Request flagged by content filter" })).toBe(true);
    expect(isContentFilterError({ message: "The content was flagged for policy violation" })).toBe(true);
    expect(isContentFilterError({ data: { error: { message: "safety system rejected" } } })).toBe(true);
  });

  it("网络错误不误判为内容过滤（否则会白烧一次改写重试）", () => {
    expect(isContentFilterError({ message: "fetch failed ECONNRESET" })).toBe(false);
    expect(isContentFilterError({ message: "Internal Server Error" })).toBe(false);
    expect(isContentFilterError(null)).toBe(false);
  });

  // 这个函数跑在"上游已经出错"的路径上。`JSON.stringify(error.data)` 对循环引用 /
  // BigInt / 抛错的 toJSON 都会抛出——判定函数自己炸掉，一次本该"改写措辞后重试"的
  // 内容拒绝就变成未捕获异常，重试逻辑整段跳过。实测（probe-filter-circular）三种都复现。
  it("错误体不可序列化时不抛错（循环引用 / BigInt / 抛错的 toJSON）", () => {
    const circular: Record<string, unknown> = { message: "x" };
    circular.self = circular;
    const hostile = (data: unknown) => Object.assign(new Error("upstream failed"), { data });

    for (const data of [circular, { n: 10n }, { toJSON() { throw new Error("nope"); } }]) {
      expect(() => isContentFilterError(hostile(data))).not.toThrow();
      expect(isContentFilterError(hostile(data))).toBe(false);
    }
  });
});

describe("用户可见的提示文案", () => {
  it("重试提示带次数与等待秒数（状态可见，否则用户以为卡死）", () => {
    expect(retryNotice(2, 3, 15_000)).toContain("15 秒后重试 2/3");
  });

  it("内容被拒提示带改写说明", () => {
    expect(contentFilterNotice(1, 2)).toContain("改写措辞后重试 1/2");
  });
});
