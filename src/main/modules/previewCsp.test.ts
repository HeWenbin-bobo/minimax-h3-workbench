import { describe, it, expect } from "vitest";
import { PREVIEW_CSP, injectPreviewCsp } from "./previewCsp";

describe("PREVIEW_CSP 策略内容", () => {
  it("默认全禁（default-src 'none'），再逐项放行", () => {
    expect(PREVIEW_CSP).toContain("default-src 'none'");
  });

  it("允许内联脚本（否则游戏/小工具动不了——这正是本次要修的问题）", () => {
    expect(PREVIEW_CSP).toContain("script-src 'unsafe-inline'");
  });

  it("封死网络出口：connect-src 为 none", () => {
    expect(PREVIEW_CSP).toContain("connect-src 'none'");
  });

  it("连常被忽略的两个出口也封掉（表单外发、base 改写）", () => {
    expect(PREVIEW_CSP).toContain("form-action 'none'");
    expect(PREVIEW_CSP).toContain("base-uri 'none'");
  });

  it("不出现任何通配或远程来源（逐项显式，漏一项就是一条出口）", () => {
    expect(PREVIEW_CSP).not.toMatch(/\*/);
    expect(PREVIEW_CSP).not.toMatch(/https?:/);
  });
});

describe("injectPreviewCsp 注入位置", () => {
  it("注入到 <head> 之后（meta CSP 只对其后解析的内容生效）", () => {
    const html = "<!DOCTYPE html><html><head><title>t</title></head><body><script>x()</script></body></html>";
    const out = injectPreviewCsp(html);
    const metaAt = out.indexOf("Content-Security-Policy");
    const scriptAt = out.indexOf("<script>");
    expect(metaAt).toBeGreaterThan(-1);
    expect(metaAt).toBeLessThan(scriptAt);
    // 仍在 head 内
    expect(out.indexOf("<head>")).toBeLessThan(metaAt);
    expect(metaAt).toBeLessThan(out.indexOf("</head>"));
  });

  it("有 <head 属性时也能插进去（<head profile=…> 这类写法）", () => {
    const out = injectPreviewCsp('<html><head profile="x"><body>hi</body></html>');
    expect(out).toContain('profile="x"><meta http-equiv="Content-Security-Policy"');
  });

  it("没有 <head> 但有 <html>：插在 <html> 之后", () => {
    const out = injectPreviewCsp("<html><body><script>x()</script></body></html>");
    expect(out.indexOf("Content-Security-Policy")).toBeLessThan(out.indexOf("<script>"));
    expect(out.startsWith("<html><meta")).toBe(true);
  });

  it("只有片段（无任何根标签）：前置注入，仍早于内容", () => {
    const out = injectPreviewCsp("<div>片段</div><script>x()</script>");
    expect(out.indexOf("Content-Security-Policy")).toBeLessThan(out.indexOf("<script>"));
  });

  it("大小写不敏感（模型常写 <HEAD> / <Html>）", () => {
    const out = injectPreviewCsp("<HTML><HEAD></HEAD><BODY></BODY></HTML>");
    expect(out).toContain("Content-Security-Policy");
  });

  it("不改动原 HTML 内容（只插入，不删改）", () => {
    const html = "<!DOCTYPE html><html><head></head><body><h1>标题</h1></body></html>";
    const out = injectPreviewCsp(html);
    expect(out.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")).toBe(html);
  });
});
