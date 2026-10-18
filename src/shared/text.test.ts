import { describe, expect, it } from "vitest";
import { sliceSafe } from "./text";

// 回归护栏：`String#slice` 按 UTF-16 码元切，emoji 会被劈成孤立代理项（渲染成 �）。
// 实测 `"😀😀😀".slice(0, 3)` → `"😀�"`。
describe("sliceSafe", () => {
  it("普通文本与 slice 等价", () => {
    expect(sliceSafe("abcdef", 3)).toBe("abc");
    expect(sliceSafe("中文测试", 2)).toBe("中文");
  });

  it("不超过上限时原样返回（同一引用语义上等价）", () => {
    expect(sliceSafe("abc", 10)).toBe("abc");
    expect(sliceSafe("", 5)).toBe("");
  });

  it("切点落在代理对中间时退一位，不留孤立代理项", () => {
    const text = "😀😀😀";
    const cut = sliceSafe(text, 3);
    expect(cut).toBe("😀");
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut)).toBe(false);
  });

  it("各种奇数切点都不产生孤立代理项", () => {
    const text = "😀😀😀😀😀😀";
    for (let max = 1; max <= text.length; max += 1) {
      const cut = sliceSafe(text, max);
      expect(cut.length).toBeLessThanOrEqual(max);
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut), `max=${max}`).toBe(false);
    }
  });

  it("上限为 0 或负数时返回空串", () => {
    expect(sliceSafe("abc", 0)).toBe("");
    expect(sliceSafe("abc", -1)).toBe("");
  });

  it("混合中英 emoji 时仍按码元安全截断", () => {
    const text = "中文😀test";
    const cut = sliceSafe(text, 3); // "中" "文" 后面正好是高代理项
    expect(cut).toBe("中文");
  });
});
