// 决定性验证：CSP 继承是不是"脚本不跑"的元凶？
//
// 已在前面几轮排除：sandbox（无 sandbox 也不跑）、blob:（也不跑）、内容没进 iframe（srcdoc 有长度）。
// 剩下最符合全部观察的假设：srcdoc/blob: iframe **继承宿主 CSP**，而宿主是 script-src 'self'
// （无 'unsafe-inline'）→ 内联 <script> 被拦。且子文档的 meta CSP 只能收紧不能放宽（B 策略失败符合此语义）。
//
// 手法：运行时移除宿主的 CSP meta（按 HTML 规范，移除 meta 会移除该策略），
// 再建同样的 srcdoc iframe。跑起来 → 确认 CSP 继承。
// HTML 在 Node 侧用 JSON.stringify 生成，彻底避开嵌套引号转义问题。
import { withApp } from "../../.e2e/driver.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkHtml = (tag) => `<!DOCTYPE html><html><body><script>parent.postMessage({kind:"probe",tag:"${tag}"}, "*");<\/script></body></html>`;

const makeIframeExpr = (tag, sandboxed) => `(() => {
  const f = document.createElement("iframe");
  ${sandboxed ? 'f.sandbox = "allow-scripts";' : ""}
  f.srcdoc = ${JSON.stringify(mkHtml(tag))};
  f.id = "probe-" + ${JSON.stringify(tag)};
  document.body.appendChild(f);
  return true;
})()`;

await withApp({}, async (cdp) => {
  await cdp.eval(`(() => { window.__probe = {}; window.addEventListener("message", (e) => { if (e.data && e.data.kind === "probe") window.__probe[e.data.tag] = true; }); return true; })()`);

  const readProbe = async () => JSON.parse(await cdp.eval(`JSON.stringify(window.__probe)`));

  // 阶段 1：CSP 在场（现状）
  await cdp.eval(makeIframeExpr("WITH_CSP", true));
  await sleep(900);
  const withCsp = await readProbe();

  // 阶段 2：移除 meta CSP 后再建一个（移除 meta 会移除该策略，故新 iframe 不再继承）
  const removed = await cdp.eval(`(() => {
    const m = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    if (!m) return false;
    m.remove();
    return true;
  })()`);
  await cdp.eval(makeIframeExpr("NO_CSP", true));
  await sleep(900);
  const noCsp = await readProbe();

  console.log(`阶段 1（CSP 在场，sandbox）    ：WITH_CSP ${withCsp.WITH_CSP ? "脚本跑了" : "脚本没跑"}`);
  console.log(`阶段 2（已移除 meta=${removed}，sandbox）：NO_CSP   ${noCsp.NO_CSP ? "脚本跑了" : "脚本没跑"}`);

  // 顺带确认移除 meta 后，真实预览 iframe 是否也能跑（重建它）
  await cdp.eval(`document.querySelectorAll('iframe[id^="probe-"]').forEach((f) => f.remove()); true`);
  console.log("-".repeat(60));
  if (!withCsp.WITH_CSP && noCsp.NO_CSP) {
    console.log("结论：**确认 CSP 继承**。srcdoc iframe 继承宿主 script-src 'self'，内联脚本被拦 →");
    console.log("      修法必须让预览内容不继承宿主 CSP（换独立源），或放宽宿主 CSP。");
  } else if (!noCsp.NO_CSP) {
    console.log("结论：移除 meta 后仍不跑 → CSP 不是元凶（或 meta 移除对新建 iframe 不生效），需另找原因。");
  } else {
    console.log("结论：两者都跑 → 与预期不符，需重新审视假设。");
  }
});
