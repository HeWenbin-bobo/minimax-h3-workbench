// 决定性诊断：为什么 srcdoc iframe 里的内联脚本不跑？
// 在真实应用里并排测三种策略，一次定位成因与可行修法。
//   A. srcdoc + 内联 <script>（现状）
//   B. srcdoc + 自带 meta CSP 放开 unsafe-inline
//   C. blob: URL + 内联 <script>
// 同时打印 srcdoc 长度，排除"内容根本没进 iframe"这一可能。
import { withApp } from "../../.e2e/driver.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await withApp({}, async (cdp) => {
  await cdp.eval(`(() => {
    window.__probe = {};
    window.addEventListener("message", (e) => { if (e.data && e.data.kind === "probe") window.__probe[e.data.tag] = true; });
    return true;
  })()`);

  // 用数组 join 拼字符串，避免在 CDP 表达式的嵌套引号里反复转义（初版就是栽在这）。
  const result = await cdp.eval(`(() => {
    const Q = String.fromCharCode(39);          // 单引号
    const mk = (tag) => ["<!DOCTYPE html><html><body><script>",
      "parent.postMessage({kind:", Q + "probe" + Q + ",tag:" + Q + tag + Q + "}, " + Q + "*" + Q + ");",
      "<\\/script></body></html>"].join("");
    const out = {};

    // A. srcdoc + 内联脚本（现状）
    const a = document.createElement("iframe");
    a.sandbox = "allow-scripts";
    a.srcdoc = mk("A");
    document.body.appendChild(a);
    out.srcdocLength = a.srcdoc.length;

    // B. srcdoc + 自带 meta CSP 放开 inline
    const b = document.createElement("iframe");
    b.sandbox = "allow-scripts";
    b.srcdoc = ["<!DOCTYPE html><html><head><meta http-equiv=", Q + "Content-Security-Policy" + Q,
      " content=", Q + "script-src " + Q + "unsafe-inline" + Q + Q, "></head><body><script>",
      "parent.postMessage({kind:" + Q + "probe" + Q + ",tag:" + Q + "B" + Q + "}, " + Q + "*" + Q + ");",
      "<\\/script></body></html>"].join("");
    document.body.appendChild(b);

    // C. blob: URL
    const c = document.createElement("iframe");
    c.sandbox = "allow-scripts";
    c.src = URL.createObjectURL(new Blob([mk("C")], { type: "text/html" }));
    document.body.appendChild(c);

    return JSON.stringify(out);
  })()`);
  console.log("srcdoc 长度（应 > 0，排除内容没进 iframe）：" + JSON.parse(result).srcdocLength);

  await sleep(1500);
  const ran = JSON.parse(await cdp.eval(`JSON.stringify(window.__probe)`));
  console.log("--- 三种策略的脚本是否运行 ---");
  console.log(`  A. srcdoc + 内联脚本      : ${ran.A ? "运行" : "未运行"}`);
  console.log(`  B. srcdoc + 自带 meta CSP : ${ran.B ? "运行" : "未运行"}`);
  console.log(`  C. blob: URL + 内联脚本   : ${ran.C ? "运行" : "未运行"}`);

  await cdp.eval(`document.querySelectorAll('iframe').forEach((f) => { if (f.className !== 'pg-preview-frame') f.remove(); }); true`);

  console.log("-".repeat(60));
  console.log(ran.A ? "结论：A 能跑 → 与 CSP 继承假设不符，需另找原因" : "结论：A 不能跑（复现用户问题）");
  console.log(ran.B ? "  B 能跑 → iframe 自带 meta CSP 可放宽" : "  B 不能跑 → 继承的 CSP 无法被内部 meta 放宽（符合 CSP 语义）");
  console.log(ran.C ? "  C 能跑 → blob: 是可行修法" : "  C 不能跑 → blob: 也受同一限制");
});
