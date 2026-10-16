// 继续缩小范围：三种策略全灭 → 排除 CSP 假设。逐个隔离变量。
//   1. 宿主页内联脚本能否 postMessage（验证通道本身）
//   2. 无 sandbox 的 srcdoc 能否跑
//   3. sandbox=allow-scripts 能否跑（靠 title 留痕，不依赖 postMessage）
//   4. sandbox=allow-scripts allow-same-origin 能否跑
import { withApp } from "../../.e2e/driver.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await withApp({}, async (cdp) => {
  await cdp.eval(`(() => { window.__probe = {}; window.addEventListener("message", (e) => { if (e.data && e.data.kind === "probe") window.__probe[e.data.tag] = true; }); return true; })()`);

  const info = await cdp.eval(`(() => {
    const Q = String.fromCharCode(39);
    const page = (body) => ["<!DOCTYPE html><html><body>", body, "</body></html>"].join("");
    const script = (tag) => ["<script>document.title=", Q + "RAN-" + tag + Q,
      ";parent.postMessage({kind:" + Q + "probe" + Q + ",tag:" + Q + tag + Q + "}, " + Q + "*" + Q + ");<\\/script>"].join("");
    const out = {};

    // 1. 宿主页直接 postMessage（验证通道本身）
    try { window.postMessage({ kind: "probe", tag: "HOST" }, "*"); } catch (e) { out.hostErr = String(e); }

    // 2. 无 sandbox 的 srcdoc
    const b = document.createElement("iframe");
    b.srcdoc = page(script("B"));
    b.id = "t-nosandbox";
    document.body.appendChild(b);

    // 3. sandbox=allow-scripts
    const c = document.createElement("iframe");
    c.sandbox = "allow-scripts";
    c.srcdoc = page(script("C"));
    c.id = "t-sandbox";
    document.body.appendChild(c);

    // 4. sandbox=allow-scripts allow-same-origin
    const d = document.createElement("iframe");
    d.sandbox = "allow-scripts allow-same-origin";
    d.srcdoc = page(script("D"));
    d.id = "t-sameorigin";
    document.body.appendChild(d);

    return JSON.stringify(out);
  })()`);
  console.log("宿主侧 info：" + info);

  await sleep(1500);
  const probe = JSON.parse(await cdp.eval(`JSON.stringify(window.__probe)`));
  console.log("--- postMessage 收到情况 ---");
  for (const tag of ["HOST", "B", "C", "D"]) console.log(`  ${tag}: ${probe[tag] ? "收到" : "未收到"}`);

  const titles = await cdp.eval(`(() => {
    const out = {};
    for (const id of ["t-nosandbox", "t-sandbox", "t-sameorigin"]) {
      const f = document.getElementById(id);
      try { out[id] = f.contentDocument ? f.contentDocument.title : "contentDocument=null"; } catch (e) { out[id] = "ERR:" + e.name; }
    }
    return JSON.stringify(out);
  })()`);
  console.log("--- iframe 的 title（RAN-x 表示脚本跑过）---");
  console.log("  " + titles);

  await cdp.eval(`document.querySelectorAll('iframe').forEach((f) => { if (f.className !== 'pg-preview-frame') f.remove(); }); true`);
  console.log("-".repeat(60));
});
