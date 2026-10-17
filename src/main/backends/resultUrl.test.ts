import { describe, expect, it } from "vitest";
import { assertPublicHttpUrl, assertSafeResultUrl } from "./resultUrl";

describe("assertSafeResultUrl", () => {
  it("放行公网 HTTPS 结果地址", () => {
    expect(assertSafeResultUrl("https://cdn.example.com/video.mp4").hostname).toBe("cdn.example.com");
    expect(assertSafeResultUrl("https://8.8.8.8/a.mp4").hostname).toBe("8.8.8.8");
    expect(assertSafeResultUrl("https://[2606:4700::1111]/a.mp4").hostname).toBe("[2606:4700::1111]");
  });

  it("拒绝非 HTTPS 与无效地址", () => {
    expect(() => assertSafeResultUrl("http://example.com/a.mp4")).toThrow(/HTTPS/);
    expect(() => assertSafeResultUrl("file:///etc/passwd")).toThrow(/HTTPS/);
    expect(() => assertSafeResultUrl("not a url")).toThrow(/无效/);
  });

  it("拒绝内网域名与 IPv4 私网/回环", () => {
    for (const url of [
      "https://localhost/a.mp4",
      "https://foo.localhost/a.mp4",
      "https://metadata.google.internal/a.mp4",
      "https://printer.local/a.mp4",
      "https://127.0.0.1/a.mp4",
      "https://127.1/a.mp4",
      "https://0x7f.0.0.1/a.mp4",
      "https://2130706433/a.mp4",
      "https://10.1.2.3/a.mp4",
      "https://172.16.0.1/a.mp4",
      "https://192.168.1.1/a.mp4",
      "https://100.64.0.1/a.mp4",
      "https://169.254.169.254/latest/meta-data/",
      "https://224.0.0.1/a.mp4"
    ]) {
      expect(() => assertSafeResultUrl(url), url).toThrow(/内网/);
    }
  });

  // 这些写法都能绕过只认 "::ffff:" 前缀的旧实现（实测），一条都不能放行。
  it("拒绝 IPv6 内嵌 IPv4 的私网地址", () => {
    for (const url of [
      "https://[::ffff:127.0.0.1]/a.mp4", // IPv4 映射
      "https://[::ffff:7f00:1]/a.mp4", // 规范化后的同一地址
      "https://[::127.0.0.1]/a.mp4", // IPv4 兼容
      "https://[::7f00:1]/a.mp4",
      "https://[::ffff:0:127.0.0.1]/a.mp4", // IPv4 翻译
      "https://[::ffff:0:7f00:1]/a.mp4",
      "https://[64:ff9b::127.0.0.1]/a.mp4", // NAT64
      "https://[64:ff9b::a00:1]/a.mp4",
      "https://[64:ff9b:1::1]/a.mp4", // NAT64 本地
      "https://[2002:7f00:1::]/a.mp4", // 6to4
      "https://[2002:a9fe:a9fe::]/a.mp4",
      "https://[2001:0:4136:e378:8000:63bf:80ff:fffe]/a.mp4" // Teredo 内嵌 127.0.0.1
    ]) {
      expect(() => assertSafeResultUrl(url), url).toThrow(/内网/);
    }
  });

  it("拒绝 IPv6 回环/唯一本地/链路本地/组播", () => {
    for (const url of [
      "https://[::1]/a.mp4",
      "https://[::]/a.mp4",
      "https://[fd00::1]/a.mp4",
      "https://[fc00::1]/a.mp4",
      "https://[fe80::1]/a.mp4",
      "https://[feb0::1]/a.mp4",
      "https://[ff02::1]/a.mp4"
    ]) {
      expect(() => assertSafeResultUrl(url), url).toThrow(/内网/);
    }
  });

  it("不误伤公网 IPv6 与普通域名", () => {
    for (const url of [
      "https://[2402:4e00::1]/a.mp4",
      "https://[2001:4860:4860::8888]/a.mp4",
      "https://storage.example.com/a.mp4"
    ]) {
      expect(() => assertSafeResultUrl(url), url).not.toThrow();
    }
  });
});

// open_page 用的校验：允许 http/https，但内网地址一律拒绝。
// 该工具的 URL 由模型生成（还可能被刚抓到的网页提示注入诱导），浏览器窗口以主进程身份发请求。
describe("assertPublicHttpUrl", () => {
  it("放行公网 http 与 https", () => {
    expect(assertPublicHttpUrl("http://example.com/a").hostname).toBe("example.com");
    expect(assertPublicHttpUrl("https://example.com/a").hostname).toBe("example.com");
  });

  it("拒绝非 http/https 协议", () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/a", "javascript:alert(1)", "data:text/html,x"]) {
      expect(() => assertPublicHttpUrl(url), url).toThrow(/只允许打开/);
    }
  });

  it("拒绝回环、私网、链路本地与云元数据地址", () => {
    for (const url of [
      "http://127.0.0.1:8188/object_info",
      "http://localhost:8188/",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://100.64.0.1/",
      "http://[::1]/",
      "http://[::ffff:7f00:1]/"
    ]) {
      expect(() => assertPublicHttpUrl(url), url).toThrow(/内网/);
    }
  });

  it("拒绝 .internal / .local 域名", () => {
    for (const url of ["http://metadata.google.internal/", "http://printer.local/"]) {
      expect(() => assertPublicHttpUrl(url), url).toThrow(/内网/);
    }
  });

  it("无效 URL 报中文错误", () => {
    expect(() => assertPublicHttpUrl("not a url")).toThrow(/无效/);
  });
});
