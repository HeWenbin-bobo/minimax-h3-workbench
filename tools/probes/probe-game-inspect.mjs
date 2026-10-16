// 停止猜测，直接读回 iframe **实际解析出的 DOM** + 宿主自身能否跑内联脚本。
// 已排除：sandbox、blob:、srcdoc 为空、CSP meta 移除（移除后仍不跑）。
// 现在要回答：srcdoc 的 <script> 到底有没有进 DOM、宿主自身的内联脚本能否执行。
import { withApp } from "../../.e2e/driver.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HTML = `<!DOCTYPE html><html><body><div id="x">原始</div><script>document.getElementById("x").textContent="被脚本改过";<\/script></body></html>`;

await withApp({}, async (cdp) => {
  const info = JSON.parse(await cdp.eval(`(() => {
    const out = {};
    // 1. 宿主自身能否执行内联脚本（判断宿主 CSP 是否真的在拦内联）
    try {
      const s = document.createElement("script");
      s.textContent = "window.__hostInlineRan = true";
      document.body.appendChild(s);
      out.hostInlineRan = Boolean(window.__hostInlineRan);
    } catch (e) { out.hostInlineError = String(e); }

    // 2. 宿主 CSP meta
    out.cspMetas = [...document.querySelectorAll('meta[http-equiv]')].map((m) => m.getAttribute("http-equiv"));

    // 3. 建无 sandbox 的 srcdoc iframe
    const f = document.createElement("iframe");
    f.srcdoc = ${JSON.stringify(HTML)};
    f.id = "inspect";
    document.body.appendChild(f);
    return JSON.stringify(out);
  })()`));
  console.log("宿主内联脚本是否执行：" + (info.hostInlineRan ? "执行了" : "没执行" + (info.hostInlineError || "")));
  console.log("宿主 meta 数：" + info.cspMetas.length + " " + JSON.stringify(info.cspMetas));

  await sleep(1200);
  const parsed = await cdp.eval(`(() => {
    const f = document.getElementById("inspect");
    try {
      const doc = f.contentDocument;
      if (!doc) return "contentDocument=null";
      const x = doc.getElementById("x");
      return JSON.stringify({
        divText: x ? x.textContent : "(无 #x)",
        hasScriptEl: Boolean(doc.querySelector("script")),
        scriptCount: doc.querySelectorAll("script").length,
        outer: doc.documentElement.outerHTML.slice(0, 300)
      });
    } catch (e) { return "ERR:" + e.name; }
  })()`);
  console.log("--- iframe 解析结果 ---");
  console.log("  " + parsed);

  await cdp.eval(`document.getElementById("inspect")?.remove(); true`);
  console.log("-".repeat(60));
  const p = JSON.parse(parsed.startsWith("ERR") ? "{}" : parsed);
  if (p.divText === "被脚本改过") console.log("结论：脚本执行了（前几轮的失败是探针自身的问题）");
  else if (p.hasScriptEl) console.log("结论：<script> 在 DOM 里但没执行 → 执行被拦（CSP 继承或等效机制）");
  else console.log("结论：<script> 压根没进 DOM → 解析阶段就被丢弃");
});
