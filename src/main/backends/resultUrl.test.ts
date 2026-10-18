import { describe, expect, it } from "vitest";
import { assertPublicHttpUrl, assertPublicHttpUrlResolved, assertSafeResultUrl } from "./resultUrl";

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

  // **尾点绕过**（实测 probe-ssrf-trailing-dot）：`localhost.` 是 FQDN 的根锚定写法，
  // DNS 解析与 `localhost` 完全等价——实测 `http://localhost.:<port>/object_info`
  // 真的连上了本机服务并读回内容，而旧实现只比 `localhost` 字面量，直接放行。
  it("拒绝带尾点的内网域名（FQDN 根锚定写法）", () => {
    for (const url of [
      "http://localhost./object_info",
      "http://localhost../object_info",
      "http://foo.localhost./",
      "http://metadata.google.internal./latest/meta-data/",
      "http://printer.local./",
      "https://localhost./a.mp4"
    ]) {
      expect(() => (url.startsWith("https:") ? assertSafeResultUrl(url) : assertPublicHttpUrl(url)), url).toThrow(/内网/);
    }
  });

  it("尾点只去掉末尾的，公网域名照常放行", () => {
    expect(assertPublicHttpUrl("http://example.com./a").hostname).toBe("example.com.");
  });

  it("无效 URL 报中文错误", () => {
    expect(() => assertPublicHttpUrl("not a url")).toThrow(/无效/);
  });
});

// **字面 hostname 合法 ≠ 目标公网**。有一类免费通配 DNS 服务专门把 IP 编进域名：
// `127.0.0.1.nip.io`、`10.0.0.1.sslip.io`、`localtest.me` 都解析到对应内网地址。
// 实测（probe-ssrf-nipio）：旧的字面校验放行了 `http://127.0.0.1.nip.io:<port>/object_info`，
// 并且真的读回了本机服务的内容。`open_page` 因此改用带 DNS 校验的版本。
describe("assertPublicHttpUrlResolved（DNS 解析后校验）", () => {
  const resolvedTo = (address: string) => async () => [{ address }];

  it("解析到回环/私网时拒绝（通配 DNS 编 IP 的写法）", async () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "192.168.1.5", "169.254.169.254", "::1"]) {
      await expect(
        assertPublicHttpUrlResolved("https://looks-public.example.com/x", resolvedTo(address)),
        address
      ).rejects.toThrow(/内网/);
    }
  });

  it("多 A 记录里混一条内网地址同样拒绝", async () => {
    await expect(assertPublicHttpUrlResolved("https://multi.example.com/x", async () => [
      { address: "93.184.216.34" },
      { address: "127.0.0.1" }
    ])).rejects.toThrow(/内网/);
  });

  it("解析到公网时放行", async () => {
    await expect(assertPublicHttpUrlResolved("https://example.com/x", resolvedTo("93.184.216.34")))
      .resolves.toBeInstanceOf(URL);
  });

  it("解析失败给中文提示（不当成公网放行）", async () => {
    await expect(assertPublicHttpUrlResolved("https://nowhere.invalid/x", async () => {
      throw Object.assign(new Error("queryA ENOTFOUND"), { code: "ENOTFOUND" });
    })).rejects.toThrow(/无法解析/);
  });

  it("解析结果为空数组同样拒绝", async () => {
    await expect(assertPublicHttpUrlResolved("https://empty.example.com/x", async () => []))
      .rejects.toThrow(/无法解析/);
  });
});
