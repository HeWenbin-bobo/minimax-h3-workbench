// CDP E2E 驱动：启动 Electron（remote debugging）→ 连接 → 模拟人类操作 → 断言
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ELECTRON = process.platform === "win32"
  ? "node_modules/electron/dist/electron.exe"
  : "node_modules/.bin/electron";

export async function launchApp(extraEnv = {}) {
  // 每次启动用独立临时 userData：settings/secrets/tasks/localStorage 全隔离，测试互不污染。
  //
  // **调用方可以覆盖它**（`withApp({ H3_USER_DATA: dir })`，`tools/harness.mjs` 的
  // `cloneUserData()` 就是这么用的）。这里必须尊重那个覆盖值：只建一个新目录的话，
  // 克隆来的 settings/secrets 根本不在这条路径上，探针会以"密钥无法解密"收场——
  // 而那只说明**没有真实 Key**，不说明产品有问题（实测：probe-doc-case 4 项假 FAIL）。
  const userData = extraEnv.H3_USER_DATA ?? await mkdtemp(path.join(tmpdir(), "h3-e2e-"));
  // **端口必须由本次实例自己决定，不能写死 9222**（实测踩到，2026-10-20）：
  // 上一轮残留的 electron 还占着 9222 时，下面的 `fetch(/json/list)` 会**连到那个旧实例**
  // 并立刻拿到 page 返回——探针于是跑在**旧构建**上。实测表现：test-01 假红了 3 条
  // （`.hero .primary` 明明存在、RB 预设明明正确），杀掉残留进程后同一份代码 21/21 全绿。
  // 更糟的方向是反过来的：旧构建恰好全绿，于是"改完验证通过"是假的。
  // 用 `--remote-debugging-port=0` 让 Electron 自选空闲端口，再读它写进 profile 的
  // `DevToolsActivePort`（两行：端口 + 浏览器 ws 路径）——端口必然属于**我们刚起的这个**。
  //
  // **`--user-data-dir` 不能省**（实测 2026-10-20）：`DevToolsActivePort` 是 Chromium
  // **在应用主进程执行 `app.setPath("userData", …)` 之前**就写好的，落在它自己的 profile
  // 目录里。只设 `H3_USER_DATA` 时它跑去默认的 `%APPDATA%\minimax-h3-workbench`，
  // 临时目录里根本没这个文件（探针实测：60 次重试后仍不可达）。
  // 把 Chromium 的 `--user-data-dir` 指向**同一个**目录，两侧才一致——这也正是克隆
  // `Local State` 能生效的前提（safeStorage 的密钥材料在那里）。
  const child = spawn(ELECTRON, [".", "--remote-debugging-port=0", `--user-data-dir=${userData}`], {
    cwd: process.cwd(),
    env: { ...process.env, H3_USER_DATA: userData, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", () => {});
  const portFile = path.join(userData, "DevToolsActivePort");
  for (let i = 0; i < 60; i++) {
    try {
      const port = Number((await readFile(portFile, "utf8")).split("\n")[0]);
      if (!port) throw new Error("端口文件还没有内容");
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return { child, wsUrl: page.webSocketDebuggerUrl, port };
    } catch { /* 还没起来，继续等 */ }
    await delay(500);
  }
  child.kill();
  throw new Error("CDP 端口 60 次重试后仍不可达");
}

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    // 事件订阅（`Network.responseReceived` 这类）。此前只处理带 id 的响应，
    // 事件被静默丢弃——想断言"响应头里到底有什么"只能靠页面内 fetch，
    // 而页面自身的 CSP 会把跨 scheme 请求挡掉，得到的是假结果。
    this.listeners = new Set();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const listener of this.listeners) {
          try { listener(msg.method, msg.params); } catch { /* 订阅方异常不影响其它订阅 */ }
        }
      }
    });
  }
  /** 订阅 CDP 事件。返回取消订阅函数。 */
  on(handler) {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`页面脚本异常: ${detail}`);
    }
    return result.result?.value;
  }
  close() { this.ws.close(); }
}

export function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => resolve(new Cdp(ws)));
    ws.addEventListener("error", reject);
  });
}

export async function withApp(extraEnv, fn) {
  const { child, wsUrl } = await launchApp(extraEnv);
  try {
    const cdp = await connect(wsUrl);
    await delay(1500); // 等 React 挂载
    return await fn(cdp, child);
  } finally {
    child.kill();
  }
}
