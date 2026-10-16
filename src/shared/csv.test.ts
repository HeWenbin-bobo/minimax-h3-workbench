import { describe, it, expect } from "vitest";
import { parseCsvRow } from "./csv";

describe("parseCsvRow", () => {
  it("无引号：按逗号分隔", () => {
    expect(parseCsvRow("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("无引号：按制表符分隔", () => {
    expect(parseCsvRow("a\tb\tc")).toEqual(["a", "b", "c"]);
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
