// 测试 02：游乐场对话链路——mock LLM 全流程（流式/空回复/HTTP500/非流式回退/持久化/刷新恢复）
import { createServer } from "node:http";
import { withApp } from "./driver.mjs";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`); };
const setReactInput = `(() => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  const taSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  window.__set = (el, v) => { (el.tagName === "TEXTAREA" ? taSetter : setter).call(el, v); el.dispatchEvent(new Event("input", {bubbles:true})); };
})()`;

let sseBehavior = "normal";
const server = createServer((req, res) => {
  if (req.method === "GET" && req.url.endsWith("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "mock-a" }, { id: "mock-b" }] }));
    return;
  }
  if (req.method === "POST" && req.url.endsWith("/chat/completions")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (sseBehavior === "http500") { res.writeHead(500); res.end("mock error"); return; }
      if (sseBehavior === "nonstream") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "非流式回复OK" } }] }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (sseBehavior === "empty") { res.end("data: [DONE]\n\n"); return; }
      for (const c of ["你", "好", "，", "我是", "Mock"]) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(18923, "127.0.0.1", r));

await withApp({}, async (cdp) => {
  // 隔离：清掉历史会话（userData 在多次测试间共享，残留气泡会污染断言）
  await cdp.eval(`localStorage.removeItem('h3-playground-sessions')`);
  await cdp.send("Page.reload");
  await new Promise(r => setTimeout(r, 2000));
  await cdp.eval(`document.querySelector('[data-page="connections"]').click()`);
  await new Promise(r => setTimeout(r, 300));
  await cdp.eval(`(() => { ${setReactInput}
    const card = Array.from(document.querySelectorAll('.connection-card')).find(c => c.textContent.includes('游乐场 LLM'));
    window.__set(card.querySelector('input[placeholder="https://api.example.com/v1"]'), 'http://127.0.0.1:18923/v1');
    window.__set(card.querySelector('input[placeholder="deepseek-chat"]'), 'mock-a');
  })()`);
  await cdp.eval(`document.querySelector('.page-title .primary').click()`);
  await new Promise(r => setTimeout(r, 800));

  // 测试连接 + 获取列表
  await cdp.eval(`(() => { const card = Array.from(document.querySelectorAll('.connection-card')).find(c => c.textContent.includes('游乐场 LLM')); card.querySelector('button.secondary').click(); })()`);
  await new Promise(r => setTimeout(r, 1500));
  check("LLM测试连接成功", await cdp.eval(`(() => { const card = Array.from(document.querySelectorAll('.connection-card')).find(c => c.textContent.includes('游乐场 LLM')); const r = card.querySelector('.test-result'); return r?.className.includes('ok') && r.textContent.includes('2 个模型'); })()`));
  await cdp.eval(`(() => { const card = Array.from(document.querySelectorAll('.connection-card')).find(c => c.textContent.includes('游乐场 LLM')); Array.from(card.querySelectorAll('button')).find(b => b.textContent === '获取列表').click(); })()`);
  await new Promise(r => setTimeout(r, 1200));
  check("模型列表下拉出现", await cdp.eval(`(() => { const card = Array.from(document.querySelectorAll('.connection-card')).find(c => c.textContent.includes('游乐场 LLM')); return (card.querySelector('select.pg-model-select')?.textContent || '').includes('mock-b'); })()`));

  // 游乐场对话：流式正常
  await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
  await new Promise(r => setTimeout(r, 300));
  await cdp.eval(`(() => { ${setReactInput}; window.__set(document.querySelector('.pg-input-row textarea'), '你好'); })()`);
  check("输入文字可见(颜色)", await cdp.eval(`getComputedStyle(document.querySelector('.pg-input-row textarea')).color === 'rgb(24, 30, 37)'`));
  await cdp.eval(`document.querySelector('.pg-input-row .primary').click()`);
  await new Promise(r => setTimeout(r, 2500));
  check("流式回复完整", await cdp.eval(`(() => { const bubbles = Array.from(document.querySelectorAll('.pg-msg.assistant .pg-bubble')); const last = bubbles[bubbles.length-1]; return last?.textContent.includes('Mock') && last.textContent.includes('你'); })()`));
  check("会话标题自动生成", await cdp.eval(`document.querySelector('.pg-session strong')?.textContent === '你好'`));
  check("用户气泡内容可见", await cdp.eval(`(document.querySelector('.pg-msg.user .pg-bubble')?.textContent || '').includes('你好')`));

  // 空回复 → 错误文案
  sseBehavior = "empty";
  await cdp.eval(`(() => { ${setReactInput}; window.__set(document.querySelector('.pg-input-row textarea'), '空回复测试'); })()`);
  await cdp.eval(`document.querySelector('.pg-input-row .primary').click()`);
  await new Promise(r => setTimeout(r, 2000));
  check("空回复显示错误文案", await cdp.eval(`(() => { const msgs = Array.from(document.querySelectorAll('.pg-msg.assistant')); const last = msgs[msgs.length-1]; return last.className.includes('error') && last.textContent.includes('请求失败'); })()`));

  // HTTP 500 → 错误文案
  // HTTP 500 → agent 回落普通对话 → 仍失败 → 气泡含回落提示 + 完整错误（agent 默认开启后的新链路）
  sseBehavior = "http500";
  await cdp.eval(`(() => { ${setReactInput}; window.__set(document.querySelector('.pg-input-row textarea'), '服务器错误测试'); })()`);
  await cdp.eval(`document.querySelector('.pg-input-row .primary').click()`);
  await new Promise(r => setTimeout(r, 6000));
  check("HTTP500显示错误文案", await cdp.eval(`(() => { const msgs = Array.from(document.querySelectorAll('.pg-msg.assistant')); const last = msgs[msgs.length-1]; return last.className.includes('error') && last.textContent.includes('LLM 请求失败') && last.textContent.includes('普通对话模式'); })()`));

  // 非流式回退
  sseBehavior = "nonstream";
  await cdp.eval(`(() => { ${setReactInput}; window.__set(document.querySelector('.pg-input-row textarea'), '非流式测试'); })()`);
  await cdp.eval(`document.querySelector('.pg-input-row .primary').click()`);
  await new Promise(r => setTimeout(r, 2000));
  check("非流式响应正常显示", await cdp.eval(`(() => { const bubbles = Array.from(document.querySelectorAll('.pg-msg.assistant .pg-bubble')); const last = bubbles[bubbles.length-1]; return last?.textContent.includes('非流式回复OK'); })()`));

  // 持久化 + 刷新恢复
  check("会话localStorage持久化", await cdp.eval(`JSON.parse(localStorage.getItem('h3-playground-sessions') || '[]').length >= 1`));
  await cdp.send("Page.reload");
  await new Promise(r => setTimeout(r, 2000));
  await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
  await new Promise(r => setTimeout(r, 400));
  check("刷新后会话恢复", await cdp.eval(`document.querySelectorAll('.pg-session').length >= 1 && Boolean(document.querySelector('.pg-msg'))`));
});

server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n=== 结果: ${results.length - failed.length}/${results.length} 通过 ===`);
process.exit(failed.length ? 1 : 0);
