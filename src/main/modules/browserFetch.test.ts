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

  // 真机证据：模型拿到报错却不知道在哪一行，把 2100 行的文件分 5 次读完再逐段比对，
  // 光读文件就吃掉 5 步。Chromium 早就把行号给了我们，之前丢掉了。
  it("带上行号，模型才能直接跳到出错那一段", () => {
    expect(formatConsoleLine("error", "Uncaught ReferenceError: x is not defined", 126))
      .toBe("错误（第 126 行）：Uncaught ReferenceError: x is not defined");
    expect(formatConsoleLine("warning", "deprecated API", 42)).toBe("警告（第 42 行）：deprecated API");
  });

  it("行号缺失或非法时不硬拼（旧事件兼容）", () => {
    expect(formatConsoleLine("error", "boom")).toBe("错误：boom");
    expect(formatConsoleLine("error", "boom", 0)).toBe("错误：boom");
    expect(formatConsoleLine("error", "boom", "12")).toBe("错误：boom");
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

  // 实测缺口：数组被 MAX_LOGS(12) 截断，报告却写"共 12 条"。
  // 循环报错 40 次的页面会被说成只报 12 条——模型以为已掌握全部问题，
  // 改完就宣布"自检通过"，用户打开还是报错。
  it("报错被截断时说明真实总数与只列出了前几条", () => {
    const text = formatProbeReport({
      loaded: true, title: "循环报错", consoleErrors: Array.from({ length: 12 }, (_, i) => `错误：boom ${i}`),
      consoleErrorTotal: 40,
      canvases: [], textLength: 10, elementCount: 20
    });
    expect(text).toContain("去重后共 40 条");
    expect(text).toContain("只列出前 12 条");
    expect(text).not.toContain("共 12 条，已去重");
  });

  it("没有截断时仍报「共 N 条，已去重」（不制造虚假的截断说明）", () => {
    const text = formatProbeReport({
      loaded: true, title: "x", consoleErrors: ["错误：a", "错误：b"],
      canvases: [], textLength: 10, elementCount: 20
    });
    expect(text).toContain("共 2 条，已去重");
    expect(text).not.toContain("只列出前");
  });

  it("无报错时明确区分「运行状态」与「画面效果」——不能让它宣称看过截图", () => {
    const text = formatProbeReport({
      loaded: true, title: "鹈鹕骑自行车", consoleErrors: [],
      canvases: [{ width: 1280, height: 800, clientWidth: 1280, clientHeight: 800, context: "webgl" }], textLength: 40, elementCount: 300
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

  // 假通过防线：零控制台报错**不等于**画出来了。真机实测空白页/纯色清屏页
  // 主色占比都是 100%，旧版自检会说"页面已实际运行且未报错"。
  it("整屏纯色且零报错时，明确说是空画面而不是通过", () => {
    const text = formatProbeReport({
      loaded: true, title: "空白", consoleErrors: [],
      canvases: [{ width: 800, height: 600, clientWidth: 800, clientHeight: 600, context: "webgl" }], textLength: 0, elementCount: 6,
      pixel: { dominant: 1, brightness: 255, sampled: 56_765 }
    });
    expect(text).toContain("什么都没画出来");
    expect(text).toContain("不要");
    expect(text).not.toContain("页面已实际运行且未报错");
  });

  it("画面有内容且零报错时才允许说'已运行且未报错'", () => {
    const text = formatProbeReport({
      loaded: true, title: "有内容", consoleErrors: [],
      canvases: [{ width: 800, height: 600, clientWidth: 800, clientHeight: 600, context: "webgl" }], textLength: 0, elementCount: 6,
      pixel: { dominant: 0.83, brightness: 218, sampled: 56_765 }
    });
    expect(text).not.toContain("什么都没画出来");
    expect(text).toContain("页面已实际运行且未报错");
  });

  it("拿不到截图时不误判（pixel 缺省照常给结论）", () => {
    const text = formatProbeReport({
      loaded: true, title: "x", consoleErrors: [],
      canvases: [{ width: 10, height: 10, clientWidth: 10, clientHeight: 10, context: "webgl" }], textLength: 5, elementCount: 4
    });
    expect(text).not.toContain("什么都没画出来");
    expect(text).toContain("页面已实际运行且未报错");
  });

  // 真机证据：模型连续 5 次修改都提示"画面是空的"，它在回复里自己怀疑
  // 「canvas 尺寸为 0 导致 clientWidth=0」，但当时自检只报缓冲区尺寸，它无从验证。
  // 现在必须**明确报出布局尺寸为 0**，并把结论说清楚。
  it("缓冲区有尺寸但布局为 0 时，明确指出来", () => {
    const text = formatProbeReport({
      loaded: true, title: "全空", consoleErrors: [],
      canvases: [{ width: 1920, height: 1080, clientWidth: 0, clientHeight: 0, context: "webgl" }],
      textLength: 0, elementCount: 8,
      pixel: { dominant: 1, brightness: 12, sampled: 1000 }
    });
    expect(text).toContain("布局尺寸为 0");
    expect(text).toContain("画布不占面积");
    expect(text).toContain("clientWidth=0");
  });

  it("布局尺寸正常时只报数字，不加警告", () => {
    const text = formatProbeReport({
      loaded: true, title: "ok", consoleErrors: [],
      canvases: [{ width: 1920, height: 1080, clientWidth: 1920, clientHeight: 1080, context: "webgl" }],
      textLength: 0, elementCount: 8,
      pixel: { dominant: 0.5, brightness: 90, sampled: 1000 }
    });
    expect(text).not.toContain("画布不占面积");
    expect(text).toContain("布局 1920×1080");
  });

  // 真机验证（probe-motion）：动画页 motion=1、静止页 motion=0。
  // 模型此前分不清"循环没启动"和"页面本来就静止"，只能反复改代码试（连改 5 次）。
  it("纯色 + 两帧完全没变 → 直说渲染循环很可能没在跑", () => {
    const text = formatProbeReport({
      loaded: true, title: "空", consoleErrors: [],
      canvases: [{ width: 800, height: 600, clientWidth: 800, clientHeight: 600, context: "webgl" }],
      textLength: 0, elementCount: 6,
      pixel: { dominant: 1, brightness: 30, sampled: 1000 },
      motion: 0
    });
    expect(text).toContain("几乎完全相同");
    expect(text).toContain("根本没有在跑");
    expect(text).toContain("requestAnimationFrame");
  });

  it("纯色但两帧在变 → 说明循环在跑，指向尺寸/裁剪问题", () => {
    const text = formatProbeReport({
      loaded: true, title: "空", consoleErrors: [],
      canvases: [{ width: 800, height: 600, clientWidth: 800, clientHeight: 600, context: "webgl" }],
      textLength: 0, elementCount: 6,
      pixel: { dominant: 1, brightness: 30, sampled: 1000 },
      motion: 0.42
    });
    expect(text).toContain("确实在运行");
    expect(text).not.toContain("根本没有在跑");
  });

  it("画面不是纯色时不报画面变化（省掉这条噪声）", () => {
    const text = formatProbeReport({
      loaded: true, title: "ok", consoleErrors: [],
      canvases: [{ width: 800, height: 600, clientWidth: 800, clientHeight: 600, context: "webgl" }],
      textLength: 0, elementCount: 6,
      pixel: { dominant: 0.4, brightness: 90, sampled: 1000 },
      motion: 0
    });
    expect(text).not.toContain("画面变化");
  });

  it("单元素页面不会被纯色判据误伤（只有 html/body 时不算'没画出来'）", () => {
    const text = formatProbeReport({
      loaded: true, title: "x", consoleErrors: [], canvases: [], textLength: 0, elementCount: 1,
      pixel: { dominant: 1, brightness: 255, sampled: 100 }
    });
    expect(text).not.toContain("什么都没画出来");
  });
});
