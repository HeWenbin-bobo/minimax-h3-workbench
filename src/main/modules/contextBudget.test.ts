import { describe, expect, it } from "vitest";
import {
  advanceWindow,
  createContextWindowState,
  estimateTokens,
  growthTokens,
  looksLikeContextOverflow,
  markWindowExceeded,
  recordBaseline,
  scopeTokens,
  shouldCompact
} from "./contextBudget";

const LIMIT = 128_000;

describe("estimateTokens", () => {
  it("空文本为 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("中文按 1.6 字符/token 估算，明显高于英文的 4 字符/token", () => {
    const zh = estimateTokens("你好世界你好世界");
    const en = estimateTokens("abcdefgh");
    expect(zh).toBeGreaterThan(en);
  });
});

describe("growthTokens（BodyAfterPrefix 记账）", () => {
  it("无基线时退回总量", () => {
    expect(growthTokens(500, createContextWindowState())).toBe(0);
  });

  it("有基线时只算增量——系统提示词不反复占预算", () => {
    const state = recordBaseline(createContextWindowState(), 120, "server");
    expect(growthTokens(180, state)).toBe(60);
  });

  it("总量低于基线时不出现负数", () => {
    const state = recordBaseline(createContextWindowState(), 500, "server");
    expect(growthTokens(300, state)).toBe(0);
  });
});

describe("recordBaseline 优先级", () => {
  // 对齐 Codex 单测 tracks_prefill_and_window_boundaries 的核心断言
  it("服务端观测值锁定后，估算不得覆盖", () => {
    let state = recordBaseline(createContextWindowState(), 150, "estimated");
    expect(state.baselineInputTokens).toBe(150);
    state = recordBaseline(state, 120, "server");
    expect(state.baselineInputTokens).toBe(120);
    expect(state.baselineSource).toBe("server");
    // 服务端已锁定：后续估算与新的服务端值都不再改动
    expect(recordBaseline(state, 90, "estimated").baselineInputTokens).toBe(120);
    expect(recordBaseline(state, 130, "server").baselineInputTokens).toBe(120);
  });

  it("估算值之间允许互相刷新（Codex 的 set_estimated_prefill 只对服务端值早退）", () => {
    let state = recordBaseline(createContextWindowState(), 150, "estimated");
    state = recordBaseline(state, 200, "estimated");
    expect(state.baselineInputTokens).toBe(200);
  });

  it("负值被夹到 0", () => {
    expect(recordBaseline(createContextWindowState(), -5, "server").baselineInputTokens).toBe(0);
  });
});

describe("advanceWindow", () => {
  it("窗口号 +1 且清空基线，等下一轮重新锁定", () => {
    let state = recordBaseline(createContextWindowState(), 1000, "server");
    state = advanceWindow(state);
    expect(state.windowNumber).toBe(1);
    expect(state.baselineInputTokens).toBeUndefined();
    expect(state.baselineSource).toBe("none");
  });
});

describe("scopeTokens 双模式（对齐 Codex AutoCompactTokenLimitScope）", () => {
  it("首个窗口用总量——从未压缩过的长历史必须能被拦住", () => {
    const state = recordBaseline(createContextWindowState(), 200_000, "server");
    // 若错用增长量（BodyAfterPrefix），这里会是 0，永远不触发
    expect(scopeTokens(50_000, state)).toBe(50_000);
  });

  it("压缩过的窗口只用增长量——避免压完立刻再压（抖动）", () => {
    const state = recordBaseline(advanceWindow(createContextWindowState()), 120, "server");
    expect(scopeTokens(180, state)).toBe(60);
  });
});

describe("shouldCompact 双阈值", () => {
  it("增长低于阈值不触发", () => {
    const state = recordBaseline(createContextWindowState(), 10_000, "server");
    const decision = shouldCompact({ activeInputTokens: 80_000, state, modelLimitTokens: LIMIT });
    expect(decision.compact).toBe(false);
    expect(decision.reason).toBe("none");
  });

  it("压缩过的窗口：增长触达 80% 限额触发 scope", () => {
    // 先压缩一次（窗口号 >0 才走 BodyAfterPrefix），再锚定基线
    const state = recordBaseline(advanceWindow(createContextWindowState()), 10_000, "server");
    // 限额 = 128000 * 0.8 = 102400；增长需 >= 102400 → active >= 112400
    expect(shouldCompact({ activeInputTokens: 112_399, state, modelLimitTokens: LIMIT }).compact).toBe(false);
    const hit = shouldCompact({ activeInputTokens: 112_400, state, modelLimitTokens: LIMIT });
    expect(hit.compact).toBe(true);
    expect(hit.reason).toBe("scope");
  });

  it("压缩过的窗口：总量低于阈值时即便基线很高也不触发", () => {
    const state = recordBaseline(advanceWindow(createContextWindowState()), 10_000, "server");
    const decision = shouldCompact({ activeInputTokens: 80_000, state, modelLimitTokens: LIMIT });
    expect(decision.compact).toBe(false);
    expect(decision.reason).toBe("none");
  });

  it("总量触达模型硬窗口触发 hard-window（即便增长量还小）", () => {
    // 基线设得很高，增长接近 0；但总量已越界
    const state = recordBaseline(createContextWindowState(), 127_000, "server");
    const decision = shouldCompact({ activeInputTokens: 128_500, state, modelLimitTokens: LIMIT });
    expect(decision.compact).toBe(true);
    expect(decision.reason).toBe("hard-window");
  });

  it("模型窗口未知（0）时不触发，避免除零误判", () => {
    const state = createContextWindowState();
    expect(shouldCompact({ activeInputTokens: 999_999, state, modelLimitTokens: 0 }).compact).toBe(false);
  });

  it("返回的百分比可用于 UI 展示", () => {
    const state = recordBaseline(createContextWindowState(), 0, "server");
    // 增长 51200 = 限额 102400 的一半
    const decision = shouldCompact({ activeInputTokens: 51_200, state, modelLimitTokens: LIMIT });
    expect(decision.percent).toBe(50);
  });

  it("buffer 会推迟触发点", () => {
    const state = recordBaseline(createContextWindowState(), 0, "server");
    // 限额 102400 + buffer 10000 = 112400。取 110000：无 buffer 已触发，有 buffer 尚不触发。
    const active = 110_000;
    expect(shouldCompact({ activeInputTokens: active, state, modelLimitTokens: LIMIT }).compact).toBe(true);
    expect(shouldCompact({ activeInputTokens: active, state, modelLimitTokens: LIMIT, bufferTokens: 10_000 }).compact).toBe(false);
  });

  it("上游报过超窗后无条件压缩（不再相信本地估算）", () => {
    const state = markWindowExceeded(createContextWindowState());
    const decision = shouldCompact({ activeInputTokens: 10, state, modelLimitTokens: LIMIT });
    expect(decision.compact).toBe(true);
    expect(decision.reason).toBe("hard-window");
  });

  it("首个窗口即使基线很高也按全量判定——长历史必须能被拦住", () => {
    // 复现探针抓到的真实 bug：基线 = 当前量时增量恒为 0，导致永不触发
    const state = recordBaseline(createContextWindowState(), 60_000, "server");
    const decision = shouldCompact({ activeInputTokens: 60_000, state, modelLimitTokens: 64_000 });
    expect(decision.compact).toBe(true); // 60000 / (64000*0.8=51200) > 100%
    expect(decision.percent).toBeGreaterThanOrEqual(100);
  });
});

describe("looksLikeContextOverflow", () => {
  it("认得出各家超窗措辞", () => {
    for (const message of [
      "This model's maximum context length is 128000 tokens",
      "context_length_exceeded",
      "Request too large: too many tokens",
      "超出上下文长度限制",
      "上下文超长，请缩减输入"
    ]) {
      expect(looksLikeContextOverflow(message)).toBe(true);
    }
  });

  it("不误伤限流与鉴权错误（否则会错误地触发压缩）", () => {
    for (const message of [
      "rate limit exceeded, please retry later",
      "401 Unauthorized: invalid api key",
      "quota exceeded for this billing period"
    ]) {
      expect(looksLikeContextOverflow(message)).toBe(false);
    }
  });
});
