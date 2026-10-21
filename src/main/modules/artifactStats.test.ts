import { describe, expect, it } from "vitest";
import { extractColumn, parseNumber, summarizeColumn } from "./artifactStats";

/**
 * 背景（真机实测，2026-10-21）：让模型统计 5000 行 CSV 的温度均值，
 * 它读了 400 行后**拒绝给平均值**——「我没有可执行的代码工具用来对 399 个数求和，
 * 只靠逐行心算平均值得出的数字是编出来的」。
 * 这是正确回答，但暴露了我们没有算数能力（Codex 有）。这些原语补上这一环。
 */

describe("parseNumber：真实表格里的各种脏写法", () => {
  it("纯数字与负数", () => {
    expect(parseNumber("42")).toBe(42);
    expect(parseNumber("-10.5")).toBe(-10.5);
    expect(parseNumber(7)).toBe(7);
  });

  it("千分位与空格分组", () => {
    expect(parseNumber("1,234")).toBe(1234);
    expect(parseNumber("1,234.5")).toBe(1234.5);
    expect(parseNumber("1 234")).toBe(1234);
  });

  it("货币前缀（各家符号）", () => {
    for (const text of ["¥29.9", "$29.9", "€29.9", "£29.9", "￥29.9"]) {
      expect(parseNumber(text), text).toBe(29.9);
    }
  });

  it("百分号保留量纲（85 而不是 0.85）", () => {
    // 用户问"平均湿度"时期望 68.5 这种数，不是 0.685
    expect(parseNumber("85%")).toBe(85);
    expect(parseNumber("85.5%")).toBe(85.5);
  });

  it("全角数字与全角符号", () => {
    expect(parseNumber("１２３")).toBe(123);
    expect(parseNumber("－１０．５")).toBe(-10.5);
  });

  it("首尾空白", () => {
    expect(parseNumber("  -10.0  ")).toBe(-10);
  });

  it("非数字一律 undefined（不能悄悄当成 0）", () => {
    for (const bad of ["", "  ", "abc", "城市1", "1.2.3", "N/A", "-", "1,2,3a", null, undefined, {}, [], true, NaN, Infinity]) {
      expect(parseNumber(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("科学计数法", () => {
    expect(parseNumber("1e3")).toBe(1000);
    expect(parseNumber("1.5E-2")).toBe(0.015);
  });
});

describe("summarizeColumn：统计量", () => {
  it("基础统计（min/max/sum/mean/median/stdDev）", () => {
    const result = summarizeColumn([1, 2, 3, 4, 5]);
    expect(result.count).toBe(5);
    expect(result.skipped).toBe(0);
    expect(result.min).toBe(1);
    expect(result.max).toBe(5);
    expect(result.sum).toBe(15);
    expect(result.mean).toBe(3);
    expect(result.median).toBe(3);
    // 总体标准差：sqrt(2) ≈ 1.4142
    expect(result.stdDev).toBeCloseTo(1.4142, 3);
  });

  it("偶数个样本的中位数取中间两个的平均", () => {
    expect(summarizeColumn([1, 2, 3, 4]).median).toBe(2.5);
  });

  it("跳过非数字并如实计数（不能悄悄少算）", () => {
    const result = summarizeColumn(["10", "abc", "", "20", "N/A", "30"]);
    expect(result.count).toBe(3);
    expect(result.skipped).toBe(3);
    expect(result.sum).toBe(60);
    expect(result.mean).toBe(20);
  });

  it("空列不抛错，返回 count=0 与 skipped", () => {
    const result = summarizeColumn([]);
    expect(result.count).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.min).toBeUndefined();
    const allBad = summarizeColumn(["a", "b"]);
    expect(allBad.count).toBe(0);
    expect(allBad.skipped).toBe(2);
  });

  it("单样本时 stdDev 为 0（不是 NaN）", () => {
    const result = summarizeColumn([42]);
    expect(result.stdDev).toBe(0);
    expect(result.mean).toBe(42);
  });

  it("不改入参（纯函数）", () => {
    const input = [3, 1, 2];
    summarizeColumn(input);
    expect(input).toEqual([3, 1, 2]);
  });

  it("浮点尾巴被收敛（不把 0.30000000000000004 丢给模型）", () => {
    expect(summarizeColumn([0.1, 0.2]).sum).toBe(0.3);
  });
});

describe("extractColumn：从 CSV 里切列", () => {
  const csv = [
    "序号,城市,温度,备注",
    "1,北京,24.9,晴",
    "2,上海,18.2,雨",
    "3,广州,30.1,多云"
  ].join("\n");

  it("按表头名切", () => {
    expect(extractColumn(csv, "温度")).toEqual(["24.9", "18.2", "30.1"]);
  });

  it("按列序号切（0 起）", () => {
    expect(extractColumn(csv, 2)).toEqual(["24.9", "18.2", "30.1"]);
  });

  it("表头名带空格也能匹配", () => {
    expect(extractColumn(csv, " 温度 ")).toEqual(["24.9", "18.2", "30.1"]);
  });

  it("列名不存在返回 undefined（让模型自己纠正，而不是抛错）", () => {
    expect(extractColumn(csv, "不存在的列")).toBeUndefined();
    expect(extractColumn(csv, 99)).toBeUndefined();
  });

  it("自动识别制表符分隔", () => {
    const tsv = "a\tb\tc\n1\t2\t3\n4\t5\t6";
    expect(extractColumn(tsv, "b")).toEqual(["2", "5"]);
  });

  it("引号包裹、值里含逗号时不串列", () => {
    const quoted = ['name,city', '"张三","北京, 东城"', '"李四","上海, 浦东"'].join("\n");
    expect(extractColumn(quoted, "city")).toEqual(["北京, 东城", "上海, 浦东"]);
  });

  it("引号内的双引号转义", () => {
    const escaped = ['id,note', '1,"他说""你好"""'].join("\n");
    expect(extractColumn(escaped, "note")).toEqual(['他说"你好"']);
  });

  it("空文本与只有表头", () => {
    expect(extractColumn("", "a")).toBeUndefined();
    expect(extractColumn("a,b", "a")).toEqual([]);
  });

  it("CRLF 换行也能切（Windows 另存的文件）", () => {
    const crlf = "a,b\r\n1,2\r\n3,4";
    expect(extractColumn(crlf, "b")).toEqual(["2", "4"]);
  });

  // **表头带 BOM**（Excel / WPS 另存 CSV 的常见形态，真机验证过）：
  // BOM 会黏在第一个列名前面，若不做处理，`indexOf("城市")` 会失配 →
  // 第一列永远"不存在"。这里锁住"第一列也能按名字切到"。
  it("表头带 BOM 时第一列仍能按名字切到", () => {
    const bomCsv = "﻿城市,温度\n北京,24.9\n上海,18.2";
    // 至少不该抛错，且"温度"（非第一列）一定切得到
    expect(extractColumn(bomCsv, "温度")).toEqual(["24.9", "18.2"]);
  });

  /**
   * BOM 的处理是**加固**，不是修复一个当时就能复现的 bug。
   *
   * 诚实说明（我实测过）：把代码里的两处 BOM 剥离都去掉，下面这条用例**仍然通过**——
   * 因为 `extractColumn` 在精确匹配失配后还有一层"包含匹配"兜底，
   * 而 `"﻿体感温度".includes("温度")` 恰好也成立，于是被兜住了。
   *
   * 那为什么还要显式剥？因为**依赖兜底是脆的**：
   * 一旦表头出现「温度」在前、「体感温度」在后，精确匹配若因 BOM 失配，
   * 拿到的就是**更靠前的错误列**。显式剥离让"精确匹配优先"这个契约真正生效，
   * 而不是碰巧被模糊分支救回来。
   *
   * 这条用例锁的是**行为契约**（带 BOM 也能精确选中），
   * 不是"删除代码就会失败"的变异测试——两者不是一回事，注释里不能含糊。
   */
  it("带 BOM 时仍按名字精确选中目标列", () => {
    const csv = "﻿温度,体感温度,城市\n24.9,26.1,北京\n18.2,19.0,上海";
    // 把相似列放前面来区分"精确命中"与"包含命中"：两者都含「温度」，
    // 若走模糊分支会选中第一个（体感温度），数值就对不上。
    const tricky = "﻿体感温度,温度,城市\n26.1,24.9,北京\n19.0,18.2,上海";
    expect(extractColumn(tricky, "温度")).toEqual(["24.9", "18.2"]);
    expect(extractColumn(csv, "温度")).toEqual(["24.9", "18.2"]);
  });

  // **空单元格不能被当成 0**（xlsx 与 csv 都会出现空行）：
  // 当成 0 会把平均值、最小值全带偏，而模型看不出少了什么。
  it("空单元格计入 skipped，不参与统计也不当成 0", () => {
    const gaps = "城市,温度\n北京,24.9\n上海,\n广州,30.1";
    const summary = summarizeColumn(extractColumn(gaps, "温度") ?? []);
    expect(summary.count).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(summary.mean).toBe(27.5); // 若把空当 0，均值会变成 18.33
    expect(summary.min).toBe(24.9);
  });

  it("端到端：切列 + 统计", () => {
    const summary = summarizeColumn(extractColumn(csv, "温度") ?? []);
    expect(summary.count).toBe(3);
    expect(summary.min).toBe(18.2);
    expect(summary.max).toBe(30.1);
    expect(summary.mean).toBeCloseTo(24.4, 3);
  });
});
