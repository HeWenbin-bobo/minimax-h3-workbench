// 验证「CSP 由响应头下发」——用 CDP Network 域读响应头。
//
// 走过的两条弯路（都留在注释里，避免以后重蹈）：
// ① 宿主侧 fetch(h3preview:…) → opaque failed response，读不到头（.e2e/test-05 已记录该现象）。
// ② 预览页 fetch 自身 → 也被拒，因为 connect-src 'none' 连自身请求都封（这反证 CSP 生效，
//    但拿不到头）。
// CDP Network.responseReceived 是权威通道：它读的是浏览器实际收到的响应头。
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
  // 先开 Network 域（必须在 iframe 加载前），收集 h3preview 的响应头
  const captured = [];
  cdp.ws.addEventListener("message", (event) => {
    let msg = null;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.method === "Network.responseReceived") {
      const r = msg.params && msg.params.response;
      if (r && typeof r.url === "string" && r.url.startsWith("h3preview:")) {
        captured.push({ status: r.status, url: r.url.slice(0, 60), headers: r.headers });
      }
    }
  });
  await cdp.send("Network.enable");

  await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
  await sleep(400);
  const escaped = JSON.stringify(PAGE);
  await cdp.eval(`(() => {
    const key = Object.keys(localStorage).find(k => k.includes("sessions")) || "h3-playground-sessions";
    const now = new Date().toISOString();
    localStorage.setItem(key, JSON.stringify([{ id: "s-hdr", title: "响应头验证", createdAt: now, updatedAt: now, messages: [
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
  await cdp.eval(`document.querySelector('.pg-artifact-card button').click()`);
  await sleep(2500);

  const got = JSON.parse(await cdp.eval(`JSON.stringify(window.__p)`));
  check("预览页内联脚本照常运行", got.inlineRan === true, `inlineRan=${got.inlineRan}`);
  check("外发网络被封", got.netBlocked === true, `netBlocked=${got.netBlocked}`);

  console.log(`      捕获到 ${captured.length} 条 h3preview 响应`);
  for (const c of captured) console.log(`        status=${c.status} csp=${(c.headers["Content-Security-Policy"] || c.headers["content-security-policy"] || "(无)").slice(0, 70)}`);

  const first = captured.find((c) => c.status === 200);
  const headerCsp = first && (first.headers["Content-Security-Policy"] || first.headers["content-security-policy"]);
  const headerNosniff = first && (first.headers["X-Content-Type-Options"] || first.headers["x-content-type-options"]);
  check("响应头确实带 Content-Security-Policy（走头而非 meta）", Boolean(headerCsp && headerCsp.includes("connect-src 'none'")), String(headerCsp || "(无)"));
  check("响应头带 X-Content-Type-Options: nosniff", headerNosniff === "nosniff", String(headerNosniff));

  console.log("-".repeat(60));
  console.log(failed === 0 ? "=== 全部通过 ===" : `=== ${failed} 项失败 ===`);
});
if (failed > 0) process.exitCode = 1;
