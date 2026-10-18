import { describe, expect, it, vi } from "vitest";

/**
 * `browserFetch` 的重定向守卫：`will-redirect` / `will-navigate` 是同步事件，
 * 只能比字面 hostname；而 `127.0.0.1.nip.io` / `localtest.me` 这类通配 DNS
 * 把内网 IP 编进域名，字面完全正常、解析后落到回环地址（实测 probe-ssrf-nipio
 * 真的读回了本机服务内容）。所以额外在 `webRequest.onBeforeRequest`（异步回调）
 * 里做 DNS 校验。
 *
 * 这里只锁定「守卫确实装上、并且会 cancel」——DNS 判定本身由 resultUrl.test 覆盖。
 */

type Listener = (
  details: { url: string; resourceType: string },
  callback: (response: { cancel?: boolean }) => void
) => void;

const registered: { listener?: Listener } = {};

vi.mock("electron", () => ({
  BrowserWindow: class { static getAllWindows() { return []; } },
  session: {
    fromPartition: () => ({
      webRequest: {
        onBeforeRequest: (listener: Listener) => { registered.listener = listener; }
      },
      setPermissionRequestHandler: () => undefined,
      setPermissionCheckHandler: () => undefined,
      clearCache: async () => undefined
    })
  }
}));

const { installNavigationDnsGuardForTest } = await import("./browserFetch");

/** 装一个守卫并跑一次请求，返回它给出的响应。 */
async function runGuard(
  url: string,
  resourceType: string,
  resolveTo: string
): Promise<{ cancel?: boolean }> {
  const session = { webRequest: { onBeforeRequest: (listener: Listener) => { registered.listener = listener; } } };
  installNavigationDnsGuardForTest(session as never, async () => [{ address: resolveTo }]);
  const listener = registered.listener!;
  return new Promise((resolve) => listener({ url, resourceType }, resolve));
}

describe("browserFetch 导航 DNS 守卫", () => {
  it("主框架导航解析到内网时取消", async () => {
    await expect(runGuard("http://127.0.0.1.nip.io:8080/object_info", "mainFrame", "127.0.0.1"))
      .resolves.toEqual({ cancel: true });
  });

  it("子资源不校验（避免每个页面逐条 DNS 把加载拖慢）", async () => {
    await expect(runGuard("http://127.0.0.1.nip.io:8080/a.png", "image", "127.0.0.1"))
      .resolves.toEqual({});
  });

  it("非 http(s) scheme 放行（预览页的 data/blob 不过网络）", async () => {
    await expect(runGuard("blob:https://example.com/abc", "mainFrame", "127.0.0.1"))
      .resolves.toEqual({});
  });

  it("解析到公网时放行", async () => {
    await expect(runGuard("https://example.com/x", "mainFrame", "93.184.216.34"))
      .resolves.toEqual({});
  });
});

// 产物自检报告是模型唯一能看到的东西：措辞错了它会得出错误结论
// （把"没报错"读成"画面好看"，或者把"没画布"当成正常）。
const { formatProbeReport, formatConsoleLine } = await import("./browserFetch");

// 这两条过滤都是真机踩出来的：不滤的话每个干净产物都会被报成"有警告"，
// 模型会为一条与它无关的框架提示反复改代码。
describe("自检日志过滤（formatConsoleLine）", () => {
  it("滤掉 Electron 自己的安全警告（每个页面都会打一条）", () => {
    expect(formatConsoleLine("warning", "%cElectron Security Warning (Insecure Content-Security-Policy) font-weight: bold; …")).toBeUndefined();
  });

  it("只收 error / warning，log 与 info 不进报告", () => {
    expect(formatConsoleLine("log", "普通日志")).toBeUndefined();
    expect(formatConsoleLine("info", "普通信息")).toBeUndefined();
    expect(formatConsoleLine("debug", "调试")).toBeUndefined();
  });

  it("清掉 NUL 等控制字符，但保留换行（多行着色器报错要看得懂）", () => {
    const line = formatConsoleLine("error", "第一行\n第二行\u0000");
    expect(line).toBe("错误：第一行\n第二行");
  });

  it("超长消息被截断（着色器编译错误常一次吐几千字符）", () => {
    const line = formatConsoleLine("error", "x".repeat(5_000))!;
    expect(line.length).toBeLessThanOrEqual(410);
  });

  it("真实报错原样保留", () => {
    expect(formatConsoleLine("error", "Uncaught ReferenceError: _near is not defined"))
      .toBe("错误：Uncaught ReferenceError: _near is not defined");
  });
});

describe("产物自检报告（formatProbeReport）", () => {
  it("加载失败时给出失败原因与下一步，不说页面正常", () => {
    const text = formatProbeReport({
      loaded: false, title: "", consoleErrors: ["页面加载失败：ERR_FILE_NOT_FOUND（-6）"],
      canvases: [], textLength: 0, elementCount: 0
    });
    expect(text).toContain("自检失败");
    expect(text).toContain("ERR_FILE_NOT_FOUND");
    expect(text).not.toContain("没有任何 error/warning");
  });

  it("有报错时逐条列出，并要求改完重新生成", () => {
    const text = formatProbeReport({
      loaded: true, title: "鹈鹕", consoleErrors: ["错误：Uncaught ReferenceError: _near is not defined"],
      canvases: [], textLength: 0, elementCount: 12
    });
    expect(text).toContain("_near is not defined");
    expect(text).toContain("修改后重新生成");
  });

  it("无报错时明确区分「运行状态」与「画面效果」——不能让它宣称看过截图", () => {
    const text = formatProbeReport({
      loaded: true, title: "鹈鹕骑自行车", consoleErrors: [],
      canvases: [{ width: 1280, height: 800, webgl: true }], textLength: 40, elementCount: 300
    });
    expect(text).toContain("WebGL 上下文正常");
    expect(text).toContain("不要声称看过画面效果");
  });

  it("既无画布也无文本时提示脚本可能没跑起来", () => {
    const text = formatProbeReport({
      loaded: true, title: "", consoleErrors: [], canvases: [], textLength: 0, elementCount: 3
    });
    expect(text).toContain("脚本很可能压根没跑起来");
  });
});
