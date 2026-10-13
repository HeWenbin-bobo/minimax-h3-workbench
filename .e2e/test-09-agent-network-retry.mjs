// 测试 09：智能体整轮重试——首个 agent 请求被连接重置时自动整轮重试并正常回复，
// 而不是立刻回落普通对话（用户不该看到"智能体模式请求失败…已自动改用普通对话模式"）。
import { createServer } from "node:http";
import { withApp } from "./driver.mjs";
import { setTimeout as delay } from "node:timers/promises";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`); };

// 第 1 个请求直接断开（模拟中转偶发 ECONNRESET）；此后正常流式回复。
let hits = 0;
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
    hits += 1;
    if (hits === 1) { res.destroy(); return; } // 连接重置
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "重试后正常回复" } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((r) => server.listen(18935, "127.0.0.1", r));

// 场景 2 用：先发部分内容再断开连接，模拟"流式中途被对端重置"（cause.message="terminated"）。
// 首次中途断开，之后正常回复——验证整轮重试能救回来。
let midHits = 0;
const midServer = createServer((req, res) => {
  if (req.method === "GET" && req.url.endsWith("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "mock-a" }] }));
    return;
  }
  if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) { res.writeHead(404); res.end(); return; }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    midHits += 1;
    if (midHits === 1) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "部分" } }] })}\n\n`);
      setTimeout(() => res.destroy(), 200); // 中途断开
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "重试后正常回复" } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((r) => midServer.listen(18937, "127.0.0.1", r));

await withApp({}, async (cdp) => {
  await cdp.eval(`document.querySelector('[data-page="connections"]').click()`);
  await delay(300);
  await cdp.eval(`(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const card = Array.from(document.querySelectorAll('.connection-card')).find((c) => c.textContent.includes('游乐场 LLM'));
    const b = card.querySelector('input[placeholder="https://api.example.com/v1"]');
    setter.call(b, 'http://127.0.0.1:18935/v1'); b.dispatchEvent(new Event('input', { bubbles: true }));
    const m = card.querySelector('input[placeholder="deepseek-chat"]');
    setter.call(m, 'mock-a'); m.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await cdp.eval(`document.querySelector('.page-title .primary').click()`);
  await delay(600);
  await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
  await delay(400);
  const agentOn = await cdp.eval(`document.querySelector('.pg-chip[title*="智能体"]').className.includes("on")`);
  check("智能体模式默认开启（本用例前提）", agentOn);

  await cdp.eval(`(() => {
    const ta = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    const el = document.querySelector('.pg-input-row textarea');
    ta.call(el, '你好'); el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await cdp.eval(`document.querySelector('.pg-input-row .primary').click()`);

  for (let i = 0; i < 60; i++) {
    await delay(1000);
    if (await cdp.eval(`document.querySelector('.pg-session.running') === null`)) break;
  }
  const state = JSON.parse(await cdp.eval(`(() => {
    const msgs = Array.from(document.querySelectorAll('.pg-msg')).map((m) => ({ role: m.className.replace('pg-msg ', ''), err: m.className.includes('error'), text: (m.querySelector('.pg-bubble')?.textContent || '') }));
    return JSON.stringify({ msgs });
  })()`));
  console.log("结果:", JSON.stringify(state.msgs.map((m) => `${m.role}:${m.text.slice(0, 50)}`)));
  const assistant = state.msgs.filter((m) => m.role === "assistant").pop();
  check("重试后拿到正常回复", Boolean(assistant && assistant.text.includes("重试后正常回复")), assistant?.text?.slice(0, 60));
  check("未出现'智能体模式请求失败'回落提示", !/智能体模式请求失败/.test(assistant?.text || ""), assistant?.text?.slice(0, 80));
  check("未回落普通对话", !/已自动改用普通对话/.test(state.msgs.map((m) => m.text).join("")), state.msgs.map((m) => m.text.slice(0, 30)).join("|"));
  check("无错误气泡", !state.msgs.some((m) => m.err));
  check("确实发生了重试（服务端收到 ≥2 次请求）", hits >= 2, `hits=${hits}`);

  // ===== 场景 2：流式中途被对端断开（cause.message="terminated"，无 code）=====
  // 这是实测中另一条漏判路径：AI SDK 只抛 "Failed to process successful response"，
  // 早期实现只认 cause.code 会漏判 → 既不重试、又透出英文占位文案。
  await cdp.eval(`document.querySelector('[data-page="connections"]').click()`);
  await delay(300);
  await cdp.eval(`(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const card = Array.from(document.querySelectorAll('.connection-card')).find((c) => c.textContent.includes('游乐场 LLM'));
    const b = card.querySelector('input[placeholder="https://api.example.com/v1"]');
    setter.call(b, 'http://127.0.0.1:18937/v1'); b.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await cdp.eval(`document.querySelector('.page-title .primary').click()`);
  await delay(600);
  await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
  await delay(400);
  await cdp.eval(`document.querySelector('.page-title .primary').click()`); // 新会话，避免上下文混淆
  await delay(300);
  await cdp.eval(`(() => {
    const ta = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    const el = document.querySelector('.pg-input-row textarea');
    ta.call(el, '你好'); el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await cdp.eval(`document.querySelector('.pg-input-row .primary').click()`);
  for (let i = 0; i < 60; i++) {
    await delay(1000);
    if (await cdp.eval(`document.querySelector('.pg-session.running') === null`)) break;
  }
  const mid = JSON.parse(await cdp.eval(`(() => {
    const msgs = Array.from(document.querySelectorAll('.pg-msg')).map((m) => ({ role: m.className.replace('pg-msg ', ''), err: m.className.includes('error'), text: (m.querySelector('.pg-bubble')?.textContent || '') }));
    return JSON.stringify({ msgs });
  })()`));
  console.log("中途重置结果:", JSON.stringify(mid.msgs.map((m) => `${m.role}:${m.text.slice(0, 60)}`)));
  // role 由 className 派生：出错气泡是 "assistant error"，不能用 === "assistant" 过滤。
  const midAssistant = mid.msgs.filter((m) => m.role.startsWith("assistant")).pop();
  const midAll = mid.msgs.map((m) => m.text).join("|");
  // 已流出内容时**刻意不整轮重试**：重来会把回复从头再写一遍，与已显示的半截内容拼成重复文字。
  // 正确行为是保留已得内容 + 给出中文错误（且不得漏出 AI SDK 的英文占位文案）。
  check("中途重置保留已流出的内容", Boolean(midAssistant && midAssistant.text.includes("部分")), midAssistant?.text?.slice(0, 40));
  check("中途重置给出中文错误（不透出 Failed to process successful response / terminated）", !/Failed to process|terminated/i.test(midAll), midAll.slice(0, 80));
  check("中途重置未误回落普通对话（无回落提示文案）", !/已自动改用普通对话模式/.test(midAll), midAll.slice(0, 80));
  check("确认服务端只被打了一次（未重复请求）", midHits === 1, `midHits=${midHits}`);
});

server.close();
midServer.close();
console.log(`\n=== 结果: ${results.filter((r) => r.ok).length}/${results.length} 通过 ===`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
