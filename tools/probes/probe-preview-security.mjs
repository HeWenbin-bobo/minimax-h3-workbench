// 端到端验证两条安全修复在**真实应用**里生效（单测证明不了响应头真的下发、也测不到 h3media）。
//  ① CSP 走响应头：预览页脚本照跑、网络被封，且能读到 Content-Security-Policy 头
//  ② 路径校验未误伤：正常产物仍能预览（realpath 改动不能把合法路径也拒掉）
import { withApp } from "../../.e2e/driver.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (label, ok, extra = "") => { if (!ok) failed += 1; console.log(`${ok ? "PASS" : "FAIL"} | ${label}${extra ? " | " + extra : ""}`); };

const PAGE = `<!DOCTYPE html><html><body><div id="k">—</div>
<script>
parent.postMessage({kind:"p", inlineRan:true}, "*");
fetch("https://example.com/ping").then(
  function(){ parent.postMessage({kind:"p", netBlocked:false}, "*"); },
  function(){ parent.postMessage({kind:"p", netBlocked:true}, "*"); }
);
</script></body></html>`;

await withApp({}, async (cdp) => {
  await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
  await sleep(400);

  const escaped = JSON.stringify(PAGE);
  await cdp.eval(`(() => {
    const key = Object.keys(localStorage).find(k => k.includes("sessions")) || "h3-playground-sessions";
    const now = new Date().toISOString();
    localStorage.setItem(key, JSON.stringify([{ id: "s-sec", title: "安全验证", createdAt: now, updatedAt: now, messages: [
      { id: "m1", role: "user", content: "写个网页" },
      { id: "m2", role: "assistant", content: "好的：\\n\\n\\\`\\\`\\\`html\\n" + ${escaped} + "\\n\\\`\\\`\\\`" }
    ]}]));
    location.reload();
  })()`);
  await sleep(1800);
  await cdp.eval(`(() => {
    window.__p = {};
    window.addEventListener("message", (e) => { if (e.data && e.data.kind === "p") Object.assign(window.__p, e.data); });
    return true;
  })()`);
  await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
  await sleep(500);

  // ② 正常产物仍能预览（realpath 校验不能误伤合法路径）
  await cdp.eval(`document.querySelector('.pg-artifact-card button').click()`);
  await sleep(2000);
  check("(2) 正常产物仍能打开预览（realpath 未误伤）", await cdp.eval(`Boolean(document.querySelector('.pg-preview-frame'))`));

  const got = JSON.parse(await cdp.eval(`JSON.stringify(window.__p)`));
  check("(1) 预览页内联脚本照常运行", got.inlineRan === true, `inlineRan=${got.inlineRan}`);
  check("(1) 网络出口被封", got.netBlocked === true, `netBlocked=${got.netBlocked}`);

  // ① 读响应头：证明 CSP 是「响应头」而非靠 <meta>（两者行为一样，头才算换对通道）
  const headers = JSON.parse(await cdp.eval(`(async () => {
    const f = document.querySelector('.pg-preview-frame');
    try {
      const r = await fetch(f.src);
      return JSON.stringify({
        status: r.status,
        csp: r.headers.get("content-security-policy"),
        nosniff: r.headers.get("x-content-type-options")
      });
    } catch (e) { return JSON.stringify({ err: String(e).slice(0, 100) }); }
  })()`));
  console.log(`      响应头：${JSON.stringify(headers)}`);
  check("(1) 响应头带 Content-Security-Policy", Boolean(headers.csp && headers.csp.includes("connect-src 'none'")));
  check("(1) 响应头带 X-Content-Type-Options: nosniff", headers.nosniff === "nosniff", String(headers.nosniff));

  // ② 越界路径被拒：直接请求产物目录外的路径
  const outside = JSON.parse(await cdp.eval(`(async () => {
    const evil = "h3preview://artifact/?path=" + encodeURIComponent("C:\\\\Windows\\\\win.ini");
    try { const r = await fetch(evil); return JSON.stringify({ status: r.status }); }
    catch (e) { return JSON.stringify({ err: String(e).slice(0, 60) }); }
  })()`));
  console.log(`      越界请求：${JSON.stringify(outside)}`);
  check("(2) 产物目录外路径被拒（非 200）", outside.status !== 200, JSON.stringify(outside));

  console.log("-".repeat(60));
  console.log(failed === 0 ? "=== 全部通过 ===" : `=== ${failed} 项失败 ===`);
});
if (failed > 0) process.exitCode = 1;
