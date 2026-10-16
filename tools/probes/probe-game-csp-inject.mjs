// 验证注入的预览 CSP 两个方向都对：
//   ① 内联脚本**照常跑**（游戏能动 —— 本次修复的目标）
//   ② 网络出口**被拦住**（fetch / 图片信标都发不出去 —— 新加的那层防护真的生效）
// 并验证宿主 CSP 未被放宽（预览 iframe 之外的范围照旧严格）。
import { withApp } from "../../.e2e/driver.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (label, ok, extra = "") => { if (!ok) failed += 1; console.log(`${ok ? "PASS" : "FAIL"} | ${label}${extra ? " | " + extra : ""}`); };

// 游戏：跑起来后立刻试外发网络，把两个结论都回报给宿主。
const GAME = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<div id="k">—</div>
<script>
window.__keys = [];
function report(extra) {
  parent.postMessage(Object.assign({ kind: "snake", inlineRan: true, keys: window.__keys.slice(), focus: document.hasFocus() }, extra || {}), "*");
}
document.addEventListener("keydown", function (e) { window.__keys.push(e.key); report(); });
// 试外发：CSP connect-src 'none' 时 fetch 必须 reject。
fetch("https://example.com/ping").then(
  function () { report({ netBlocked: false, netDetail: "fetch 成功了（CSP 未生效）" }); },
  function (e) { report({ netBlocked: true, netDetail: "fetch 被拒：" + (e && e.message ? e.message.slice(0, 60) : e) }); }
);
// 图片信标：connect-src 拦不到它，靠 img-src 拦。
var img = new Image();
img.onload = function () { report({ imgBlocked: false }); };
img.onerror = function () { report({ imgBlocked: true }); };
img.src = "https://example.com/beacon.png";
setTimeout(function () { report({}); }, 1200);
</script></body></html>`;

await withApp({}, async (cdp) => {
  await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
  await sleep(400);

  const escaped = JSON.stringify(GAME);
  await cdp.eval(`(() => {
    const key = Object.keys(localStorage).find(k => k.includes("sessions")) || "h3-playground-sessions";
    const now = new Date().toISOString();
    localStorage.setItem(key, JSON.stringify([{ id: "s-csp2", title: "CSP注入", createdAt: now, updatedAt: now, messages: [
      { id: "m1", role: "user", content: "写个贪吃蛇" },
      { id: "m2", role: "assistant", content: "好的：\\n\\n\\\`\\\`\\\`html\\n" + ${escaped} + "\\n\\\`\\\`\\\`" }
    ]}]));
    location.reload();
  })()`);
  await sleep(1800);
  await cdp.eval(`(() => {
    window.__got = {};
    window.addEventListener("message", (e) => {
      if (e.data && e.data.kind === "snake") {
        if (e.data.inlineRan) window.__got.inlineRan = true;
        if (e.data.netBlocked !== undefined) window.__got.netBlocked = e.data.netBlocked;
        if (e.data.netDetail) window.__got.netDetail = e.data.netDetail;
        if (e.data.imgBlocked !== undefined) window.__got.imgBlocked = e.data.imgBlocked;
        if (e.data.focus !== undefined) window.__got.focus = e.data.focus;
      }
    });
    return true;
  })()`);
  await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
  await sleep(500);
  await cdp.eval(`document.querySelector('.pg-artifact-card button').click()`);
  await sleep(2500);

  const got = JSON.parse(await cdp.eval(`JSON.stringify(window.__got)`));
  check("内联脚本照常运行（游戏能动）", got.inlineRan === true, `inlineRan=${got.inlineRan}`);
  check("fetch 外发被拦（connect-src 'none'）", got.netBlocked === true, String(got.netDetail || "（无回报）"));
  check("图片信标被拦（img-src 只放 data:/blob:）", got.imgBlocked === true, `imgBlocked=${got.imgBlocked}`);
  check("iframe 文档仍自动获得焦点", got.focus === true, `hasFocus=${got.focus}`);

  // 宿主 CSP 未被放宽：宿主自己的内联脚本仍应被拦
  const hostInline = await cdp.eval(`(() => {
    const s = document.createElement("script");
    s.textContent = "window.__hostInline = true";
    document.body.appendChild(s);
    return Boolean(window.__hostInline);
  })()`);
  check("宿主页面内联脚本仍被拦（script-src 未放宽）", hostInline === false, `hostInline=${hostInline}`);

  console.log("-".repeat(60));
  console.log(failed === 0 ? "=== 全部通过 ===" : `=== ${failed} 项失败 ===`);
});
if (failed > 0) process.exitCode = 1;
