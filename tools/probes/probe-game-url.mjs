// 验证修法方向：URL 加载的 iframe（非 srcdoc）是否**不继承**宿主 CSP？
//
// 已知：srcdoc / blob: / data: 都继承宿主 CSP（script-src 'self' 拦内联）→ 游戏脚本不跑。
// 按 CSP 规范，**通过 URL 加载的文档用自己的 CSP**，不继承创建者。若成立，
// 修法就是"把预览 HTML 通过 URL 加载"，宿主 CSP 保持严格。
import { writeFileSync } from "node:fs";
import path from "node:path";
import { withApp } from "../../.e2e/driver.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HTML = `<!DOCTYPE html><html><body><div id="x">原始</div><script>document.getElementById("x").textContent="RAN";parent.postMessage({kind:"probe",tag:"URL"},"*");<\/script></body></html>`;

const tmpFile = path.join(process.env.TEMP || ".", `h3-preview-probe-${Date.now()}.html`);
writeFileSync(tmpFile, HTML, "utf8");
console.log("测试文件：" + tmpFile);

await withApp({}, async (cdp) => {
  await cdp.eval(`(() => { window.__probe = {}; window.addEventListener("message", (e) => { if (e.data && e.data.kind === "probe") window.__probe[e.data.tag] = true; }); return true; })()`);

  const fileUrl = "file:///" + tmpFile.replace(/\\/g, "/");
  await cdp.eval(`(() => {
    const a = document.createElement("iframe");
    a.sandbox = "allow-scripts";
    a.src = ${JSON.stringify(fileUrl)};
    a.id = "t-url";
    document.body.appendChild(a);
    return true;
  })()`);
  console.log("建 iframe：src=" + fileUrl);

  await sleep(1500);
  const probe = JSON.parse(await cdp.eval(`JSON.stringify(window.__probe)`));
  const divText = await cdp.eval(`(() => {
    const f = document.getElementById("t-url");
    try { const d = f.contentDocument; const x = d && d.getElementById("x"); return x ? x.textContent : "(读不到)"; }
    catch (e) { return "ERR:" + e.name; }
  })()`);
  console.log(`URL 加载的 iframe：postMessage=${probe.URL ? "收到" : "未收到"}  #x=${divText}`);
  console.log("-".repeat(60));
  console.log(probe.URL
    ? "结论：**URL 加载的 iframe 不受宿主 CSP 约束** → 可行修法：预览 HTML 走 URL 加载，宿主 CSP 保持严格。"
    : "结论：URL 加载也被拦 → 只能放宽宿主 CSP 或另寻他法。");

  await cdp.eval(`document.getElementById("t-url")?.remove(); true`);
});
