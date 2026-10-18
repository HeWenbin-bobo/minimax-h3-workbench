import { describe, expect, it } from "vitest";
import { mediaMime, parseByteRange } from "./mediaRange";

describe("parseByteRange", () => {
  const size = 1000;

  it("无 Range 头时返回 undefined（回整文件）", () => {
    expect(parseByteRange(null, size)).toBeUndefined();
    expect(parseByteRange(undefined, size)).toBeUndefined();
    expect(parseByteRange("", size)).toBeUndefined();
  });

  it("识别标准区间", () => {
    expect(parseByteRange("bytes=0-99", size)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange("bytes=100-199", size)).toEqual({ start: 100, end: 199 });
  });

  // <video> 首次请求常常是 open-ended：`bytes=0-`
  it("开放上界 `bytes=N-` 到文件末尾", () => {
    expect(parseByteRange("bytes=500-", size)).toEqual({ start: 500, end: 999 });
    expect(parseByteRange("bytes=0-", size)).toEqual({ start: 0, end: 999 });
  });

  it("后缀式 `bytes=-N` 取最后 N 字节", () => {
    expect(parseByteRange("bytes=-100", size)).toEqual({ start: 900, end: 999 });
    // 后缀超过文件长度时从 0 开始（RFC 7233）
    expect(parseByteRange("bytes=-5000", size)).toEqual({ start: 0, end: 999 });
  });

  it("上界超过文件长度时夹到末尾", () => {
    expect(parseByteRange("bytes=900-99999", size)).toEqual({ start: 900, end: 999 });
  });

  it("不可满足的区间返回 invalid（应回 416）", () => {
    expect(parseByteRange("bytes=1000-", size)).toBe("invalid");
    expect(parseByteRange("bytes=2000-3000", size)).toBe("invalid");
    expect(parseByteRange("bytes=-0", size)).toBe("invalid");
  });

  it("上界小于下界返回 invalid", () => {
    expect(parseByteRange("bytes=500-100", size)).toBe("invalid");
  });

  it("多区间与非 bytes 单位按整文件回（undefined）", () => {
    expect(parseByteRange("bytes=0-1,5-6", size)).toBeUndefined();
    expect(parseByteRange("items=0-1", size)).toBeUndefined();
    expect(parseByteRange("bytes=", size)).toBeUndefined();
  });

  it("空文件不做区间处理", () => {
    expect(parseByteRange("bytes=0-10", 0)).toBeUndefined();
  });
});

describe("mediaMime", () => {
  it("覆盖生成结果可能出现的视频/音频/图片格式", () => {
    expect(mediaMime("F:\\out\\a.mp4")).toBe("video/mp4");
    expect(mediaMime("/tmp/a.webm")).toBe("video/webm");
    expect(mediaMime("/tmp/a.MOV")).toBe("video/quicktime");
    expect(mediaMime("/tmp/a.mkv")).toBe("video/x-matroska");
    expect(mediaMime("/tmp/a.mp3")).toBe("audio/mpeg");
    expect(mediaMime("/tmp/a.png")).toBe("image/png");
  });

  it("未知扩展名回落到 octet-stream（交给浏览器嗅探）", () => {
    expect(mediaMime("/tmp/a.xyz")).toBe("application/octet-stream");
    expect(mediaMime("/tmp/noext")).toBe("application/octet-stream");
  });
});
