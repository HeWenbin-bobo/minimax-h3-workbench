// CDP E2E 驱动：启动 Electron（remote debugging）→ 连接 → 模拟人类操作 → 断言
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const ELECTRON = process.platform === "win32"
  ? "node_modules/electron/dist/electron.exe"
  : "node_modules/.bin/electron";
const PORT = 9222;

export async function launchApp(extraEnv = {}) {
  const child = spawn(ELECTRON, [".", `--remote-debugging-port=${PORT}`], {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", () => {});
  // 等调试端口就绪
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return { child, wsUrl: page.webSocketDebuggerUrl };
    } catch {}
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
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
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
