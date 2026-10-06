import { createServer } from "node:http";
import { withApp } from "./driver.mjs";

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url.endsWith("/chat/completions")) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const c of ["你", "好", "Mock"]) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(18923, "127.0.0.1", r));

await withApp({}, async (cdp) => {
  const setter = `(() => {
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const t = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    window.__set = (el, v) => { (el.tagName === "TEXTAREA" ? t : s).call(el, v); el.dispatchEvent(new Event("input", {bubbles:true})); };
  })()`;
  await cdp.eval(`document.querySelector('[data-page="connections"]').click()`);
  await new Promise(r => setTimeout(r, 300));
  await cdp.eval(`(() => { ${setter}
    const card = Array.from(document.querySelectorAll('.connection-card')).find(c => c.textContent.includes('游乐场 LLM'));
    window.__set(card.querySelector('input[placeholder="https://api.example.com/v1"]'), 'http://127.0.0.1:18923/v1');
    window.__set(card.querySelector('input[placeholder="deepseek-chat"]'), 'mock-a');
  })()`);
  await cdp.eval(`document.querySelector('.page-title .primary').click()`);
  await new Promise(r => setTimeout(r, 800));
  // 注入事件计数器（在 React 之外独立监听）
  await cdp.eval(`(() => {
    window.__events = [];
    window.h3.onLlmChunk((e) => window.__events.push(["chunk", e.seq, e.delta]));
    window.h3.onLlmDone((e) => window.__events.push(["done", e.ok, e.message || ""]));
  })()`);
  // 等到 React 挂载自己的 listener 之后……先新建一轮对话（无会话状态，模拟首条）
  await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
  await new Promise(r => setTimeout(r, 300));
  await cdp.eval(`(() => { ${setter}; window.__set(document.querySelector('.pg-input-row textarea'), '你好'); })()`);
  await cdp.eval(`document.querySelector('.pg-input-row .primary').click()`);
  await new Promise(r => setTimeout(r, 3000));
  const events = await cdp.eval(`JSON.stringify(window.__events)`);
  console.log("injected listener events:", events);
  const state = await cdp.eval(`(() => {
    const msgs = Array.from(document.querySelectorAll('.pg-msg.assistant'));
    return JSON.stringify(msgs.map(m => m.querySelector('.pg-bubble')?.textContent?.slice(0, 40)));
  })()`);
  console.log("assistant bubbles:", state);
});
server.close();
