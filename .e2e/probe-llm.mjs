import { createServer } from "node:http";
import { withApp } from "./driver.mjs";

const hits = [];
const server = createServer((req, res) => {
  hits.push(`${req.method} ${req.url}`);
  if (req.method === "GET" && req.url.endsWith("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "mock-a" }, { id: "mock-b" }] }));
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(18923, "127.0.0.1", r));

await withApp({}, async (cdp) => {
  await cdp.eval(`document.querySelector('[data-page="connections"]').click()`);
  await new Promise(r => setTimeout(r, 300));
  // native setter 填 React 受控 input
  await cdp.eval(`(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const card = Array.from(document.querySelectorAll('.connection-card')).find(c => c.textContent.includes('游乐场 LLM'));
    const baseUrlInput = card.querySelector('input[placeholder="https://api.example.com/v1"]');
    setter.call(baseUrlInput, 'http://127.0.0.1:18923/v1');
    baseUrlInput.dispatchEvent(new Event('input', {bubbles:true}));
    const modelInput = card.querySelector('input[placeholder="deepseek-chat"]');
    setter.call(modelInput, 'mock-a');
    modelInput.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await cdp.eval(`document.querySelector('.page-title .primary').click()`);
  await new Promise(r => setTimeout(r, 800));
  const settings = await cdp.eval(`(async () => { const s = await window.h3.getSettings(); return JSON.stringify(s.data.llm); })()`);
  console.log("persisted llm after save:", settings);
  const result = await cdp.eval(`(async () => JSON.stringify(await window.h3.listLlmModels()))()`);
  console.log("listLlmModels:", result.slice(0, 120));
  console.log("mock hits:", hits.join(" | ") || "(none)");
});
server.close();
