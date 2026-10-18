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
  //
  // **不能用页面里的 `fetch(f.src)`**：宿主页自己的 CSP 是
  // `connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*`，不含 `h3preview:`，
  // 这个 fetch 在发出前就被浏览器挡掉（TypeError: Failed to fetch）。
  // 旧探针据此断言"拿不到头"（当成产品 bug），越界那条又把"被 CSP 拦"当成"被拒"（假 PASS）。
  // 正确做法：用 CDP 的 `Network.responseReceived` 事件读浏览器真实收到的响应。
  await cdp.send("Network.enable").catch(() => undefined);

  /** 在 action 执行期间收集符合条件的响应（最多等 timeoutMs）。 */
  async function captureResponses(predicate, action, timeoutMs = 6000) {
    const found = [];
    const off = cdp.on((method, params) => {
      if (method === "Network.responseReceived" && predicate(params.response)) found.push(params.response);
    });
    try {
      await action();
      const started = Date.now();
      while (found.length === 0 && Date.now() - started < timeoutMs) await sleep(200);
    } finally {
      off();
    }
    return found;
  }

  const headerOf = (headers, name) => {
    const key = Object.keys(headers ?? {}).find((k) => k.toLowerCase() === name);
    return key ? headers[key] : undefined;
  };

  // 点「↻ 重新加载」：nonce 变化会重挂 iframe，从而真实再发一次 h3preview 请求。
  const previewResponses = await captureResponses(
    (r) => String(r?.url ?? "").startsWith("h3preview://"),
    async () => { await cdp.eval(`document.querySelector('.pg-preview-actions button[title="重新加载"]')?.click()`); }
  );
  const first = previewResponses[0];
  const csp = headerOf(first?.headers, "content-security-policy");
  const nosniff = headerOf(first?.headers, "x-content-type-options");
  console.log(`      预览响应：status=${first?.status} csp=${csp ? "有" : "无"} nosniff=${nosniff}`);
  check("(1) 预览响应带 Content-Security-Policy（含 connect-src 'none'）", Boolean(csp && csp.includes("connect-src 'none'")), String(csp).slice(0, 160));
  check("(1) 预览响应带 X-Content-Type-Options: nosniff", nosniff === "nosniff", String(nosniff));

  // ② 越界路径被拒：让主框架**直接导航**到 h3preview 的越界 URL（页面内 fetch 会被宿主 CSP 先拦掉），
  // 由 Network 事件读真实状态码。这一步放在最后——导航会离开应用页面。
  const evilUrl = "h3preview://artifact/?path=" + encodeURIComponent("C:\\Windows\\win.ini");
  const outsideResponses = await captureResponses(
    (r) => String(r?.url ?? "").startsWith("h3preview://") && String(r.url).includes("win.ini"),
    async () => { await cdp.send("Page.navigate", { url: evilUrl }).catch(() => undefined); }
  );
  const outsideStatus = outsideResponses[0]?.status;
  console.log(`      越界请求：status=${outsideStatus}（收到 ${outsideResponses.length} 个响应）`);
  check("(2) 产物目录外路径被拒（403，不是 200）", outsideStatus === 403, String(outsideStatus));

  console.log("-".repeat(60));
  console.log(failed === 0 ? "=== 全部通过 ===" : `=== ${failed} 项失败 ===`);
});
if (failed > 0) process.exitCode = 1;
