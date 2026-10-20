import { describe, expect, it } from "vitest";
import { decodeTextBytes, decodeTextPreview } from "./textFile";

/**
 * 这些字节都是**真实文件**的形态，不是编出来的：
 * - GBK：Windows 记事本「另存为 → 编码：ANSI」在中文系统上的输出；
 * - UTF-16LE/BE：记事本「编码：Unicode」；
 * - UTF-8 BOM：记事本「编码：UTF-8（带 BOM）」。
 *
 * 两条路径（对话附件 `attachment:read` 与产物预览 `artifact:read`）共用这个函数——
 * 分开写的时候只会修其中一处（实测：附件修好了，预览仍是乱码）。
 */
const GBK_ZHONGWEN = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]); // 中文测试
const utf16 = (text: string, endian: "le" | "be") => {
  const body = Buffer.from(text, "utf16le");
  const bytes = endian === "le" ? body : Buffer.from(body).swap16();
  return Buffer.concat([Buffer.from(endian === "le" ? [0xff, 0xfe] : [0xfe, 0xff]), bytes]);
};
const HEAD = "测试测试测试测试"; // 8 个汉字

describe("decodeTextBytes", () => {
  it("UTF-8 原样解出中文", () => {
    expect(decodeTextBytes(Buffer.from(HEAD, "utf8"))).toBe(HEAD);
  });

  it("GBK（记事本「ANSI」）不再是一片乱码", () => {
    expect(decodeTextBytes(GBK_ZHONGWEN)).toBe("中文测试");
  });

  // 实测：UTF-16LE 的字节恰好也能被 GB18030 解出来（不抛错），
  // 于是旧实现给出 `��-N噀Km諎`——比解不开更糟，因为它不报错。
  it("UTF-16LE（记事本「Unicode」）按 BOM 判定，跳过 BOM 解码", () => {
    expect(decodeTextBytes(utf16(HEAD, "le"))).toBe(HEAD);
  });

  it("UTF-16BE 同样按 BOM 判定", () => {
    expect(decodeTextBytes(utf16(HEAD, "be"))).toBe(HEAD);
  });

  it("UTF-8 BOM 被剥掉（正文首个字符不是不可见的 U+FEFF）", () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(HEAD, "utf8")]);
    const text = decodeTextBytes(withBom);
    expect(text).toBe(HEAD);
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
  });

  it("纯 ASCII 不受影响", () => {
    expect(decodeTextBytes(Buffer.from("hello, world", "utf8"))).toBe("hello, world");
  });

  it("空文件返回空串（不抛错）", () => {
    expect(decodeTextBytes(Buffer.alloc(0))).toBe("");
  });
});

describe("decodeTextPreview", () => {
  it("未超上限时整份解码", () => {
    const bytes = Buffer.from(HEAD, "utf8");
    expect(decodeTextPreview(bytes, 1024)).toEqual({ text: HEAD, truncated: false });
  });

  it("超上限时截断，且如实标记 truncated", () => {
    const full = HEAD.repeat(100);
    const { text, truncated } = decodeTextPreview(Buffer.from(full, "utf8"), 100);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThan(full.length);
  });

  // 按字节切会把多字节字符劈成两半，末尾留下 U+FFFD。
  // 旧实现两处各写了一行 `.replace(/�+$/, "")`，抽进函数后不能漏。
  it("截断点在多字节字符中间时，尾部不留 U+FFFD", () => {
    // 3 字节一个汉字：101 字节必然切在第二个字中间。
    const { text, truncated } = decodeTextPreview(Buffer.from(HEAD.repeat(10), "utf8"), 101);
    expect(truncated).toBe(true);
    expect(text.endsWith("�")).toBe(false);
  });

  it("预览也要按 BOM 判 UTF-16（用户另存后再回来预览）", () => {
    expect(decodeTextPreview(utf16(HEAD, "le"), 1024).text).toBe(HEAD);
  });
});
