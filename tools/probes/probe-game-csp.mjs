// 探针：抓 iframe 内的 CSP 违规/脚本错误，确认"游戏脚本到底为什么没跑"。
// driver 的 Cdp 只按 id 处理响应、忽略事件，所以这里自己挂 cdp.ws 监听 Log/Console 事件。
import { withApp } from "../../.e2e/driver.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GAME = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<div id="out">脚本未运行</div>
<script>document.getElementById("out").textContent = "脚本已运行"; parent.postMessage({kind:"ran"},"*");</script>
</body></html>`;

await withApp({}, async (cdp) => {
  const logs = [];
  cdp.ws.addEventListener("message", (event) => {
    let msg = null;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.method === "Log.entryAdded" && msg.params && msg.params.entry) {
      logs.push(`[Log:${msg.params.entry.level}] ${msg.params.entry.text}`);
    }
    if (msg.method === "Runtime.consoleAPICalled") {
      const args = (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
      logs.push(`[console:${msg.params.type}] ${args}`);
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails || {};
      logs.push(`[exception] ${d.text || ""} ${(d.exception && d.exception.description) || ""}`);
    }
  });
  await cdp.send("Log.enable");
  await cdp.send("Runtime.enable");

  await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
  await sleep(400);

  const escaped = JSON.stringify(GAME);
  await cdp.eval(`(() => {
    const key = Object.keys(localStorage).find(k => k.includes("sessions")) || "h3-playground-sessions";
    const now = new Date().toISOString();
    localStorage.setItem(key, JSON.stringify([{ id: "s-csp", title: "CSP", createdAt: now, updatedAt: now, messages: [
      { id: "m1", role: "user", content: "写个网页" },
      { id: "m2", role: "assistant", content: "好的：\\n\\n\\\`\\\`\\\`html\\n" + ${escaped} + "\\n\\\`\\\`\\\`" }
    ]}]));
    location.reload();
  })()`);
  await sleep(1800);
  await cdp.eval(`(() => { window.__ran = false; window.addEventListener("message", (e) => { if (e.data && e.data.kind === "ran") window.__ran = true; }); return true; })()`);
  await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
  await sleep(500);

  const beforeCount = logs.length;
  await cdp.eval(`document.querySelector('.pg-artifact-card button').click()`);
  await sleep(1200);

  const ran = await cdp.eval(`Boolean(window.__ran)`);
  console.log(`iframe 内脚本是否运行：${ran ? "是" : "否"}`);
  console.log("--- 打开预览后新增的日志 ---");
  const fresh = logs.slice(beforeCount);
  if (fresh.length === 0) console.log("（无）");
  for (const line of fresh) console.log("  " + line);

  console.log("--- 宿主 document 的 CSP（srcdoc iframe 会继承它）---");
  console.log("  " + await cdp.eval(`(() => { const m = document.querySelector('meta[http-equiv="Content-Security-Policy"]'); return m ? m.getAttribute("content") : "（无 meta CSP）"; })()`));
  console.log("-".repeat(60));
  console.log(ran ? "结论：脚本能跑（CSP 继承假设不成立，需另找原因）" : "结论：脚本没跑——与'CSP 继承阻断内联脚本'的假设一致");
});
