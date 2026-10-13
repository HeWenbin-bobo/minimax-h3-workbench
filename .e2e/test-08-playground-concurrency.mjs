// 测试 08：游乐场多会话并发（并发运行 / 生成中标识 / 最近使用置顶 / 单会话停止不连坐）
// 用本地 mock LLM，避免真机网络波动干扰；并发语义与真实上游一致。
import { createServer } from "node:http";
import { withApp } from "./driver.mjs";
import { setTimeout as delay } from "node:timers/promises";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`); };
const setReactInput = `(() => {
  const ta = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  window.__set = (el, v) => { ta.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
})()`;

// 每个请求按 prompt 关键词流式回固定内容；"慢"请求持续约 12 秒，便于观察并发状态。
const server = createServer((req, res) => {
  if (req.method === "GET" && req.url.endsWith("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "mock-a" }] }));
    return;
  }
  if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) { res.writeHead(404); res.end(); return; }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const slow = body.includes("慢");
    const tag = body.includes("苹果") ? "苹果好" : body.includes("香蕉") ? "香蕉好" : "通用回复";
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const push = (content) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    const finish = () => res.end("data: [DONE]\n\n");
    if (!slow) { push(tag); finish(); return; }
    let n = 0;
    const timer = setInterval(() => {
      push(`${tag}-${n++} `);
      if (n >= 12) { clearInterval(timer); finish(); }
    }, 1000);
    // 客户端真正断开才清理（req 的 close 在请求体读完时就触发，用 res 的 close 才对应连接断开）。
    res.on("close", () => clearInterval(timer));
  });
});
await new Promise((r) => server.listen(18930, "127.0.0.1", r));

const setInput = (cdp, t) => cdp.eval(`(() => { ${setReactInput}; window.__set(document.querySelector('.pg-input-row textarea'), ${JSON.stringify(t)}); })()`);
const snap = async (cdp) => JSON.parse(await cdp.eval(`(() => {
  const sessions = Array.from(document.querySelectorAll('.pg-session')).map((s) => ({
    title: s.querySelector('.pg-session-body strong')?.textContent || '',
    sub: s.querySelector('.pg-session-body small')?.textContent || '',
    running: s.className.includes('running'),
    active: s.className.includes('active')
  }));
  const msgs = Array.from(document.querySelectorAll('.pg-msg')).map((m) => ({ role: m.className.replace('pg-msg ', ''), err: m.className.includes('error'), text: (m.querySelector('.pg-bubble')?.textContent || '') }));
  return JSON.stringify({ sessions, msgs, stopVisible: document.querySelector('.pg-chip.stop') !== null, btn: document.querySelector('.pg-input-row .primary').textContent });
})()`));
const waitAllIdle = async (cdp, max = 60) => {
  for (let i = 0; i < max; i++) { await delay(1000); if (await cdp.eval(`document.querySelector('.pg-session.running') === null`)) return true; }
  return false;
};

await withApp({}, async (cdp) => {
  await cdp.eval(`document.querySelector('[data-page="connections"]').click()`);
  await delay(300);
  await cdp.eval(`(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const card = Array.from(document.querySelectorAll('.connection-card')).find((c) => c.textContent.includes('游乐场 LLM'));
    const b = card.querySelector('input[placeholder="https://api.example.com/v1"]');
    setter.call(b, 'http://127.0.0.1:18930/v1'); b.dispatchEvent(new Event('input', { bubbles: true }));
    const m = card.querySelector('input[placeholder="deepseek-chat"]');
    setter.call(m, 'mock-a'); m.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await cdp.eval(`document.querySelector('.page-title .primary').click()`);
  await delay(600);
  await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
  await delay(400);
  // 关掉智能体：本用例测并发机制本身，普通流式路径更可控
  await cdp.eval(`document.querySelector('.pg-chip[title*="智能体"]').click()`);
  await delay(200);

  // ===== 会话 A：慢回复 =====
  await setInput(cdp, "慢：苹果");
  await cdp.eval(`document.querySelector('.pg-input-row .primary').click()`);
  await delay(1500);
  let s = await snap(cdp);
  check("生成中会话带 running 标识", s.sessions.some((x) => x.running), JSON.stringify(s.sessions.map((x) => x.running)));
  check("生成中会话副标题显示正在回复", s.sessions.some((x) => x.running && x.sub.includes("正在回复")), JSON.stringify(s.sessions.map((x) => x.sub)));

  // ===== 会话 B：A 仍在生成时并发发送 =====
  await cdp.eval(`document.querySelector('.page-title .primary').click()`);
  await delay(300);
  await setInput(cdp, "慢：香蕉");
  await cdp.eval(`document.querySelector('.pg-input-row .primary').click()`);
  await delay(2000);
  s = await snap(cdp);
  check("两个会话可同时生成（并发）", s.sessions.filter((x) => x.running).length === 2, JSON.stringify(s.sessions.map((x) => x.running)));
  check("刚使用的会话排在列表最前并选中", Boolean(s.sessions[0]?.running && s.sessions[0]?.active), JSON.stringify(s.sessions.map((x) => x.title.slice(0, 6))));
  const toast = await cdp.eval(`document.querySelector('.toast')?.textContent || '(无)'`);
  check("并发发送未被并发守卫拒绝", !/还在进行中/.test(toast), toast);

  // ===== 只停止当前会话（B），A 必须继续 =====
  await cdp.eval(`document.querySelector('.pg-chip.stop').click()`);
  await delay(1500);
  s = await snap(cdp);
  check("停止当前会话后它不再生成中", !s.sessions.find((x) => x.active)?.running, JSON.stringify(s.sessions.map((x) => `${x.title.slice(-2)}:${x.running}`)));
  check("另一会话未被连坐中止（仍生成中）", s.sessions.filter((x) => x.running).length === 1, JSON.stringify(s.sessions.map((x) => x.running)));
  check("当前会话停止后无错误气泡", !s.msgs.some((m) => m.err), JSON.stringify(s.msgs.map((m) => m.err)));

  check("未停止的会话能正常收尾", await waitAllIdle(cdp), "仍卡在生成中");
  s = await snap(cdp);
  check("全部收尾后列表无 running 标识", s.sessions.every((x) => !x.running) && !s.stopVisible, JSON.stringify(s.sessions.map((x) => x.running)));

  // ===== 两个会话内容互不串台 =====
  // 停在 B（当前会话为"苹果"，已被用户停止 → 气泡为空是预期）；切到 A 看内容是否完整。
  const otherIdx = s.sessions.findIndex((x) => !x.active);
  await cdp.eval(`document.querySelectorAll('.pg-session .pg-session-body')[${otherIdx}].click()`);
  await delay(400);
  const o = await snap(cdp);
  const aText = o.msgs.filter((m) => m.role === "assistant").pop()?.text || "";
  check("未被停止的会话内容完整", aText.trim().length > 0, JSON.stringify(aText.slice(0, 40)));
  check("内容属于该会话自己的主题（未串台）", aText.includes("苹果"), JSON.stringify(aText.slice(0, 30)));
  check("停止的会话不显示错误气泡", !o.msgs.some((m) => m.err) || aText.trim().length > 0, JSON.stringify(o.msgs.map((m) => m.err)));

  // ===== 最近使用排序：新建会话置顶 =====
  await cdp.eval(`document.querySelector('.page-title .primary').click()`);
  await delay(300);
  await setInput(cdp, "苹果");
  await cdp.eval(`document.querySelector('.pg-input-row .primary').click()`);
  await waitAllIdle(cdp);
  await delay(300);
  const titles = JSON.parse(await cdp.eval(`JSON.stringify(Array.from(document.querySelectorAll('.pg-session .pg-session-body strong')).map((e) => e.textContent))`));
  check("最新使用的会话排在最前", titles[0] === "苹果", JSON.stringify(titles));

  // ===== 刷新后排序持久化、不残留生成中状态 =====
  await cdp.send("Page.reload");
  await delay(2000);
  await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
  await delay(500);
  const after = JSON.parse(await cdp.eval(`JSON.stringify(Array.from(document.querySelectorAll('.pg-session .pg-session-body strong')).map((e) => e.textContent))`));
  check("刷新后仍按最近使用排序", after[0] === "苹果", JSON.stringify(after));
  check("刷新后无残留 running 标识（不卡在生成中）", await cdp.eval(`document.querySelector('.pg-session.running') === null`));
});

server.close();
console.log(`\n=== 结果: ${results.filter((r) => r.ok).length}/${results.length} 通过 ===`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
