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

/**
 * **无表头文件的表头检测**（实测缺陷 2026-10-21）。
 *
 * Excel 导出的 CSV 常常没有表头，第一行就是数据。旧实现无条件把首行当表头丢掉——
 * 用户统计 3 行只得到 2 行，而且**界面上看不出少了什么**（数字看起来正常，只是错的）。
 * 这种静默少算比报错更糟。
 *
 * 判据：只在**按列序号**访问、且首行每一格都能解析成数字时才判定"没有表头"。
 * 按列名访问说明调用方知道表头长什么样，那时首行仍该当表头。
 */
describe("extractColumn：无表头文件", () => {
  const dataOnly = "10,20,30\n40,50,60\n70,80,90";

  it("按列序号访问时，首行数据不能被当成表头丢掉", () => {
    expect(extractColumn(dataOnly, 0)).toEqual(["10", "40", "70"]);
    expect(extractColumn(dataOnly, 2)).toEqual(["30", "60", "90"]);
  });

  it("无表头时统计行数正确（不是少一行）", () => {
    const summary = summarizeColumn(extractColumn(dataOnly, 0) ?? []);
    expect(summary.count).toBe(3); // 旧实现会是 2
    expect(summary.sum).toBe(120);
    expect(summary.min).toBe(10);
    expect(summary.max).toBe(70);
  });

  it("有表头时行为不变（首行仍是表头，不参与统计）", () => {
    const withHeader = "温度,湿度\n24.9,50\n18.2,60";
    expect(extractColumn(withHeader, "温度")).toEqual(["24.9", "18.2"]);
    expect(extractColumn(withHeader, 0)).toEqual(["24.9", "18.2"]);
  });

  it("表头本身也是数字时，按列名访问仍当表头（不能误判成无表头）", () => {
    const numericHeader = "1,2\n10,20\n30,40";
    expect(extractColumn(numericHeader, "1")).toEqual(["10", "30"]);
  });

  it("无表头时按列名访问返回 undefined（本来就无从匹配）", () => {
    expect(extractColumn(dataOnly, "温度")).toBeUndefined();
  });
});

/**
 * **真实数据形态**：混合列（既有序号也有文字列），而不是"全数字"的理想数据。
 *
 * 这条是补漏的——此前的无表头用例都用 `10,20,30` 这种全数字行，
 * 而真实 CSV 的数据行几乎总是混合的（`1,城市1,24.9,31.0,7.4,2026-10-02`）。
 * 我第一版判据要求"每格都是数字"才认作无表头，正是栽在这个差异上：
 * 全数字用例能过，真实数据却永远被当成有表头、少算一行（真机 5000 → 4999）。
 */
describe("真实形态：混合列的无表头文件", () => {
  // 与真实 CSV 同形：序号 + 文字 + 若干度量值 + 日期
  const rows = [
    "1,城市1,24.9,31.0,7.4,2026-10-02",
    "2,城市2,36.2,36.0,5.2,2026-10-03",
    "3,城市3,18.5,42.0,3.1,2026-10-04"
  ];
  const headerless = rows.join("\n");

  it("首行是混合列数据时，不能被当成表头", () => {
    // 第 3 列（序号 2）是温度
    expect(extractColumn(headerless, 2)).toEqual(["24.9", "36.2", "18.5"]);
  });

  it("统计行数等于真实数据行数（不是少一行）", () => {
    const summary = summarizeColumn(extractColumn(headerless, 2) ?? []);
    expect(summary.count).toBe(3);
    expect(summary.min).toBe(18.5);
    expect(summary.max).toBe(36.2);
  });

  it("同形数据加上真实表头时，行为仍然正确（不能矫枉过正）", () => {
    const withHeader = ["序号,城市,温度,湿度,风速,日期", ...rows].join("\n");
    expect(extractColumn(withHeader, "温度")).toEqual(["24.9", "36.2", "18.5"]);
    expect(extractColumn(withHeader, 2)).toEqual(["24.9", "36.2", "18.5"]);
  });

  it("CRLF 换行（Windows 导出）时同样正确", () => {
    const crlf = rows.join("\r\n");
    expect(extractColumn(crlf, 2)).toEqual(["24.9", "36.2", "18.5"]);
  });
});
