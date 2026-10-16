// 上游 /models 通、模型名正确，但对话返回空 → 抓「应用发出的请求」与「上游回的响应体」。
// 不打印密钥（只看 Authorization 是否存在）。
import { withApp } from "../../.e2e/driver.mjs";
import { cloneUserData } from "../harness.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { dir } = await cloneUserData();

await withApp({ H3_USER_DATA: dir }, async (cdp) => {
  const reqs = [];
  const resps = [];
  cdp.ws.addEventListener("message", (event) => {
    let m = null;
    try { m = JSON.parse(event.data); } catch { return; }
    if (m.method === "Network.requestWillBeSent") {
      const r = m.params.request;
      if (r && /chat\/completions/.test(String(r.url))) {
        reqs.push({
          id: m.params.requestId,
          url: r.url,
          hasAuth: Boolean(r.headers && (r.headers.Authorization || r.headers.authorization)),
          body: String(r.postData || "")
        });
      }
    }
    if (m.method === "Network.responseReceived") {
      const r = m.params.response;
      if (r && /chat\/completions/.test(String(r.url))) resps.push({ id: m.params.requestId, status: r.status, mime: r.mimeType });
    }
  });
  await cdp.send("Network.enable");

  for (let i = 0; i < 25; i++) {
    const ok = await cdp.eval(`(() => { const b = document.querySelector('[data-page="playground"]'); if (!b) return false; b.click(); return true; })()`);
    if (ok) break;
    await sleep(400);
  }
  await sleep(800);

  // 关掉智能体，走最简普通对话（排除 tools 干扰）
  await cdp.eval(`(() => {
    const chips = [...document.querySelectorAll(".pg-chip")];
    const agent = chips.find((c) => (c.title || "").includes("智能体"));
    if (agent && agent.className.includes("on")) agent.click();
    return true;
  })()`);
  await sleep(400);

  await cdp.eval(`(() => {
    const ta = document.querySelector(".pg-input-row textarea");
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    set.call(ta, "只回复两个字：你好");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  await cdp.eval(`document.querySelector(".pg-input-row .primary").click()`);
  await sleep(8000);

  console.log(`\n=== 捕获到 ${reqs.length} 个 chat/completions 请求 ===`);
  for (const r of reqs) {
    console.log(`  URL: ${r.url}`);
    console.log(`  Authorization 头：${r.hasAuth ? "存在（不打印）" : "缺失"}`);
    try {
      const b = JSON.parse(r.body);
      console.log(`  model=${b.model}  stream=${b.stream}  messages=${(b.messages || []).length} 条  tools=${b.tools ? b.tools.length : "无"}`);
      console.log(`  body 片段：${r.body.slice(0, 240)}`);
    } catch {
      console.log(`  body 非 JSON（前 240 字）：${r.body.slice(0, 240)}`);
    }
  }

  console.log(`\n=== 响应 ===`);
  for (const r of resps) console.log(`  status=${r.status} mime=${r.mime}`);

  if (reqs.length) {
    const got = await cdp.send("Network.getResponseBody", { requestId: reqs[reqs.length - 1].id }).catch((e) => ({ error: String(e) }));
    const raw = got && got.body ? got.body : JSON.stringify(got);
    console.log(`\n=== 最后一个响应体（前 600 字）===\n${String(raw).slice(0, 600)}`);
  }

  const ui = await cdp.eval(`(() => [...document.querySelectorAll(".pg-msg.assistant .pg-bubble")].map((b) => b.textContent || "").join("\\n---\\n"))()`);
  console.log(`\n=== 界面气泡（前 300 字）===\n${ui.slice(0, 300) || "（空）"}`);
});
