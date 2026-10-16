import { describe, it, expect } from "vitest";
import { PREVIEW_CSP } from "./previewCsp";

// 注意：这里**不再**测"注入 <meta>"——那条路已被安全审查否决并删除。
// 靠正则找 <head> 再插 meta，会匹到注释/脚本里的假 <head>，让安全策略静默失效；
// 改为由协议处理器通过 HTTP 响应头下发（权威、产物 HTML 无法构造影响）。
// 响应头那条链路由探针 probe-game-csp-inject.mjs 在真实应用里验证。
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

  it("是合法的响应头值：单行、无换行（响应头里换行会导致头注入）", () => {
    expect(PREVIEW_CSP).not.toMatch(/[\r\n]/);
  });
});
