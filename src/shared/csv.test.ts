import { describe, it, expect } from "vitest";
import { parseCsvRow, parseCsvRows } from "./csv";

describe("parseCsvRow", () => {
  it("无引号：按逗号分隔", () => {
    expect(parseCsvRow("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("无引号：分隔符由 parseCsvRows 推断（TSV 传制表符）", () => {
    expect(parseCsvRow("a\tb\tc", "\t")).toEqual(["a", "b", "c"]);
    // 逗号是默认分隔符；制表符在 CSV 里是普通字符
    expect(parseCsvRow("a\tb,c")).toEqual(["a\tb", "c"]);
  });

  it("引号包裹：含逗号字段不被切开", () => {
    // SheetJS 对含逗号字段会输出 "a,\"b,c\",d"；旧朴素 split 错切为 ["a", "\"b", "c\"", "d"]。
    expect(parseCsvRow("a,\"b,c\",d")).toEqual(["a", "b,c", "d"]);
  });

  it("引号包裹：含双引号用 \"\" 转义", () => {
    expect(parseCsvRow("\"He said \"\"hi\"\"\"")).toEqual(['He said "hi"']);
  });

  it("引号内制表符视为普通字符", () => {
    expect(parseCsvRow("\"a\tb\",c")).toEqual(["a\tb", "c"]);
  });

  it("末尾空字段保留", () => {
    expect(parseCsvRow("a,b,")).toEqual(["a", "b", ""]);
  });

  it("字段两侧空白被 trim", () => {
    expect(parseCsvRow("  a , b  ")).toEqual(["a", "b"]);
  });
});

// 引号内的换行不是行尾（SheetJS 对含换行的字段会加引号跨行输出）。
describe("parseCsvRows / splitCsvLines 跨行字段", () => {
  it("含换行的单元格不被劈成两行", () => {
    expect(parseCsvRows('A,B\n"多行\n内容",x\nC,D')).toEqual([
      ["A", "B"],
      ["多行\n内容", "x"],
      ["C", "D"]
    ]);
  });

  it("CRLF 换行与引号内 CRLF 都正确处理", () => {
    expect(parseCsvRows('A,B\r\n"多\n行",x\r\n')).toEqual([
      ["A", "B"],
      ["多\n行", "x"]
    ]);
  });

  it("引号内的 \"\" 转义不破坏切行", () => {
    expect(parseCsvRows('a\n"say ""hi""\nnow",b')).toEqual([
      ["a"],
      ['say "hi"\nnow', "b"]
    ]);
  });

  it("空行被忽略", () => {
    expect(parseCsvRows("A,B\n\n\n1,2\n")).toEqual([["A", "B"], ["1", "2"]]);
  });
});

// 行非空就至少有一个字段。旧写法在"整行只有一个空引号字段"时返回 []，
// 让这一行被当成 0 列（与 `a,"",d` 里同一种字段的行为不一致）。
describe("parseCsvRow 单空引号字段", () => {
  it(`"" 解析为一个空字段`, () => {
    expect(parseCsvRow(`""`)).toEqual([""]);
  });

  it("空行仍返回空数组（真的一列都没有）", () => {
    expect(parseCsvRow("")).toEqual([]);
  });

  it("与 a,\"\",d 里的空字段行为一致", () => {
    expect(parseCsvRow(`a,"",d`)).toEqual(["a", "", "d"]);
  });
});
