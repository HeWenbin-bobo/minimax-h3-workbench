import { createServer } from "node:http";
import { withApp } from "./driver.mjs";

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url.endsWith("/chat/completions")) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const c of ["甲", "乙", "丙"]) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
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
  await cdp.eval(`document.querySelector('[data-page="connections"]').connections = undefined; document.querySelector('[data-page="connections"]').click()`);
  await new Promise(r => setTimeout(r, 300));
  await cdp.eval(`(() => { ${setter}
    const card = Array.from(document.querySelectorAll('.connection-card')).find(c => c.textContent.includes('游乐场 LLM'));
    window.__set(card.querySelector('input[placeholder="https://api.example.com/v1"]'), 'http://127.0.0.1:18923/v1');
    window.__set(card.querySelector('input[placeholder="deepseek-chat"]'), 'mock-a');
  })()`);
  await cdp.eval(`document.querySelector('.page-title .primary').click()`);
  await new Promise(r => setTimeout(r, 800));
  // 游乐场 → 注入 listener → 发送（首轮，无会话创建路径）
  await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
  await new Promise(r => setTimeout(r, 300));
  await cdp.eval(`(() => {
    window.__ev = [];
    window.h3.onLlmChunk((e) => window.__ev.push(["c", e.delta]));
    window.h3.onLlmDone((e) => window.__ev.push(["d", e.ok, e.message || ""]));
  })()`);
  await cdp.eval(`(() => { ${setter}; window.__set(document.querySelector('.pg-input-row textarea'), '首轮'); })()`);
  await cdp.eval(`document.querySelector('.pg-input-row .primary').click()`);
  await new Promise(r => setTimeout(r, 3000));
  console.log("events:", await cdp.eval(`JSON.stringify(window.__ev)`));
  console.log("bubbles:", await cdp.eval(`JSON.stringify(Array.from(document.querySelectorAll('.pg-msg.assistant .pg-bubble')).map(b => b.textContent.slice(0, 30)))`));
});
server.close();
