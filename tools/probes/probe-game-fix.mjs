// 候选修法验证：宿主 CSP = script-src 'self'（拦内联），srcdoc 继承它。
// 什么方式能让预览里的内联脚本跑起来？
//   A. srcdoc + iframe 的 csp 属性（给子文档设策略）
//   B. data: URL + sandbox
//   C. data: URL 无 sandbox（对照）
import { withApp } from "../../.e2e/driver.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HTML = `<!DOCTYPE html><html><body><div id="x">原始</div><script>document.getElementById("x").textContent="RAN";parent.postMessage({kind:"probe",tag:"TAG"},"*");<\/script></body></html>`;

await withApp({}, async (cdp) => {
  await cdp.eval(`(() => { window.__probe = {}; window.addEventListener("message", (e) => { if (e.data && e.data.kind === "probe") window.__probe[e.data.tag] = true; }); return true; })()`);

  const built = await cdp.eval(`(() => {
    const html = ${JSON.stringify(HTML)};
    const res = {};
    try {
      const a = document.createElement("iframe");
      a.sandbox = "allow-scripts";
      a.setAttribute("csp", "script-src 'unsafe-inline'");
      a.srcdoc = html.replace("TAG", "A");
      a.id = "t-A";
      document.body.appendChild(a);
      res.A = "已建";
    } catch (e) { res.A = "ERR:" + e.message; }
    try {
      const b = document.createElement("iframe");
      b.sandbox = "allow-scripts";
      b.src = "data:text/html;charset=utf-8," + encodeURIComponent(html.replace("TAG", "B"));
      b.id = "t-B";
      document.body.appendChild(b);
      res.B = "已建";
    } catch (e) { res.B = "ERR:" + e.message; }
    try {
      const c = document.createElement("iframe");
      c.src = "data:text/html;charset=utf-8," + encodeURIComponent(html.replace("TAG", "C"));
      c.id = "t-C";
      document.body.appendChild(c);
      res.C = "已建";
    } catch (e) { res.C = "ERR:" + e.message; }
    return JSON.stringify(res);
  })()`);
  console.log("建 iframe：" + built);

  await sleep(1500);
  const probe = JSON.parse(await cdp.eval(`JSON.stringify(window.__probe)`));
  const dom = JSON.parse(await cdp.eval(`(() => {
    const r = {};
    for (const id of ["t-A", "t-B", "t-C"]) {
      const f = document.getElementById(id);
      try { const d = f.contentDocument; const x = d && d.getElementById("x"); r[id] = x ? x.textContent : "(读不到)"; }
      catch (e) { r[id] = "ERR:" + e.name; }
    }
    return JSON.stringify(r);
  })()`));

  console.log("--- 各策略结果 ---");
  const labels = { A: "srcdoc + iframe csp 属性", B: "data: URL + sandbox", C: "data: URL 无 sandbox" };
  for (const tag of ["A", "B", "C"]) {
    console.log(`  ${tag}. ${labels[tag]}: postMessage=${probe[tag] ? "收到" : "未收到"}  #x=${dom["t-" + tag]}`);
  }

  await cdp.eval(`document.querySelectorAll('iframe[id^="t-"]').forEach((f) => f.remove()); true`);
  console.log("-".repeat(60));
  const working = ["A", "B", "C"].filter((t) => probe[t]);
  console.log("可用修法：" + (working.length ? working.map((t) => `${t}(${labels[t]})`).join("、") : "（无——需自定义协议或放宽宿主 CSP）"));
});
