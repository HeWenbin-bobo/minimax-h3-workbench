// 测试 12：游乐场「生成中切页」——组件卸载期间的事件丢失与回来后的补齐。
//
// 为什么单独测：游乐场页在 `App.tsx` 里是 `{page === "playground" && <PlaygroundPage …/>}`，
// **切到别的页就等于整个组件卸载**，那段时间 `llm:chunk` / `llm:tool` / `llm:tasks` /
// `llm:done` 四个事件全都没有订阅者，直接被丢弃。
// 后果按严重程度排：
//   ① `llm:done` 丢失 → 会话永久停在「生成中」，`■ 停止` 一直在，且再也发不出新消息；
//   ② 正文中间缺一段（用户看到半截回答）；
//   ③ 中途建出的任务卡片 / 工具步骤全丢（"AI 说做了 3 件事，卡片上 0 件"）。
//
// 主进程为此保留了「本轮收尾状态」+ 补齐通道。本套件验证这条通道在**真实切页**
// （而不是靠内存活态侥幸不丢）下确实工作。
//
// 与 test-08 的区别：test-08 只在生成**前后**切页，流式期间不切走；这里在流式**中途**切走再切回。
import { createServer } from "node:http";
import { withApp } from "./driver.mjs";
import { setTimeout as delay } from "node:timers/promises";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`); };

// 慢速流式：每 600ms 推一段，共 7 段 ≈ 4.2 秒。
const SEGMENTS = 7;
const server = createServer((req, res) => {
  if (req.method === "GET" && req.url.endsWith("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "mock-away" }] }));
    return;
  }
  if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) { res.writeHead(404); res.end(); return; }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const push = (content) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    const finish = () => res.end("data: [DONE]\n\n");
    let n = 0;
    // 每段都带序号，回来时能一眼看出中间有没有缺段。
    const timer = setInterval(() => {
      push(`段${n} `);
      n += 1;
      if (n >= SEGMENTS) { clearInterval(timer); finish(); }
    }, 600);
    // 清理挂在 res 的 close 上：req 的 close 在请求体读完后就会触发，会把定时器提前掐掉。
    res.on("close", () => clearInterval(timer));
  });
});
await new Promise((r) => server.listen(18932, "127.0.0.1", r));

const setPrompt = (cdp, text) => cdp.eval(`(() => {
  const ta = document.querySelector('.pg-input-row textarea');
  const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  set.call(ta, ${JSON.stringify(text)}); ta.dispatchEvent(new Event('input', { bubbles: true }));
})()`);

await withApp({}, async (cdp) => {
  await cdp.eval(`window.h3.updateSettings({ llm: { provider: "custom", baseUrl: "http://127.0.0.1:18932/v1", model: "mock-away", systemPrompt: "" } }).then(r => r.ok)`);
  await cdp.eval(`window.h3.setSecret("llmApiKey", "k").then(r => r.ok)`);
  await cdp.send("Page.reload");
  await delay(2500);
  await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
  await delay(1200);

  await setPrompt(cdp, "切页测试");
  await delay(200);
  await cdp.eval(`document.querySelector('.pg-input-row .primary').click()`);

  // 前提确认：确实进入生成中（否则后面测的是"根本没跑"）。
  await delay(1500);
  const started = await cdp.eval(`document.querySelector('.pg-chip.stop') !== null`);
  check("前提：已进入生成中", started === true, String(started));

  // 切走并停留 **7 秒**：必须比整轮流式（约 4.2 秒）更长，
  // 这样 `llm:done` 一定发生在组件卸载期间、被直接丢弃。
  // 切回时就只剩主进程保存的 `turnState` 能补齐——这才是要验证的那条通道。
  await cdp.eval(`document.querySelector('[data-page="studio"]').click()`);
  await delay(7000);
  const awayHasPlayground = await cdp.eval(`document.querySelector('.pg-input-row') !== null`);
  check("前提：切走后游乐场组件确实已卸载", awayHasPlayground === false, String(awayHasPlayground));

  await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
  // 切回时本轮其实早已结束（done 丢了），等补齐通道把状态补上。
  for (let i = 0; i < 15; i++) {
    if (await cdp.eval(`document.querySelector('.pg-session.running') === null`)) break;
    await delay(1000);
  }
  await delay(1200);

  const state = JSON.parse(await cdp.eval(`(() => {
    const bubbles = Array.from(document.querySelectorAll('.pg-bubble')).map((b) => (b.textContent || ''));
    const stopVisible = document.querySelector('.pg-chip.stop') !== null;
    const running = document.querySelector('.pg-session.running') !== null;
    const sendBtn = document.querySelector('.pg-input-row .primary');
    return JSON.stringify({ bubbles, stopVisible, running, sendDisabled: sendBtn ? sendBtn.disabled : null, sendLabel: sendBtn ? sendBtn.textContent : null });
  })()`));

  const answer = state.bubbles.find((t) => t.includes("段")) || "";
  const seen = new Set((answer.match(/段(\d+)/g) || []).map((m) => Number(m.replace("段", ""))));
  // 回来之后必须能取到**全部**段落：任何缺段都说明补齐没拿到主进程那份完整文本。
  const missing = [];
  for (let i = 0; i < SEGMENTS; i++) if (!seen.has(i)) missing.push(i);

  check("切页回来后气泡仍有正文", answer.trim().length > 0, JSON.stringify(answer.slice(0, 60)));
  check("切页期间的内容没有缺段", missing.length === 0, `缺段 ${JSON.stringify(missing)}（共应有 ${SEGMENTS} 段，实际 ${seen.size} 段）`);
  check("切页回来后不再显示「停止」", state.stopVisible === false, String(state.stopVisible));
  check("切页回来后会话不再标记为生成中", state.running === false, String(state.running));

  // 发送按钮在**输入框为空时**本就该禁用（`disabled={!input.trim() && attachments.length === 0}`），
  // 直接读 `disabled` 会把"空输入"误判成"卡住发不出消息"（本套件第一版就是这么错的）。
  // 所以先填一句话，再判可用性。
  await setPrompt(cdp, "第二条");
  await delay(300);
  const canSend = await cdp.eval(`(() => { const b = document.querySelector('.pg-input-row .primary'); return b ? !b.disabled : false; })()`);
  check("收尾后填入内容即可继续发消息", canSend === true, String(canSend));
});

server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n=== 结果: ${results.length - failed.length}/${results.length} 通过 ===`);
process.exit(failed.length ? 1 : 0);
