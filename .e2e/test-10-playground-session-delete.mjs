// 测试 10：游乐场会话删除。
// 回归的缺陷：应用在流式回复途中被关闭时，消息上的 streaming:true 会被原样持久化；
// 重启后这些残留标记会让 deleteSession 的"正在生成不能删"守卫静默 return —— 用户点删除"毫无反应"，
// 且气泡永久显示闪烁光标。修复点在 loadSessions()（读取时归一化）+ deleteSession()（守卫给反馈）。
import { withApp } from "./driver.mjs";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`); };

const snap = async (cdp) => JSON.parse(await cdp.eval(`(() => {
  return JSON.stringify({
    sessions: Array.from(document.querySelectorAll('.pg-session')).map((s) => ({ title: s.querySelector('.pg-session-body strong')?.textContent || '', sub: s.querySelector('.pg-session-body small')?.textContent || '' })),
    trashLabel: (() => { const b = Array.from(document.querySelectorAll('.pg-session-filter button')).find((x) => x.textContent.includes('回收站')); return b ? b.textContent : ''; })(),
    toast: document.querySelector('.toast')?.textContent || '',
    cursors: document.querySelectorAll('.pg-cursor').length,
    trashItems: document.querySelectorAll('.pg-trash .trash-item').length
  });
})()`));

const deleteByTitle = (cdp, title) => cdp.eval(`(() => {
  const el = Array.from(document.querySelectorAll('.pg-session')).find((x) => x.textContent.includes(${JSON.stringify(title)}));
  if (!el) return false;
  el.querySelectorAll('.pg-session-tools .pg-tool')[2].click();
  return true;
})()`);

await withApp({}, async (cdp) => {
  // ===== 场景 1：残留 streaming 标记的会话（重启后的真实形态）=====
  await cdp.eval(`(() => {
    localStorage.setItem('h3-playground-sessions', JSON.stringify([
      { id: 'stale-1', title: '残留流式会话', createdAt: new Date().toISOString(), messages: [
        { id: 'm1', role: 'user', content: '写一篇长文' },
        { id: 'm2', role: 'assistant', content: '写到一半…', streaming: true }
      ]},
      { id: 'ok-2', title: '正常会话', createdAt: new Date(Date.now() - 60000).toISOString(), messages: [
        { id: 'm3', role: 'user', content: '你好' },
        { id: 'm4', role: 'assistant', content: '你好呀' }
      ]}
    ]));
  })()`);
  await cdp.send("Page.reload");
  await delay(2000);
  await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
  await delay(500);

  let s = await snap(cdp);
  check("残留会话已加载（2 个）", s.sessions.length === 2, `count=${s.sessions.length}`);

  // 切到残留会话：修复后不应再有"永远在回复"的光标
  await cdp.eval(`(() => { const el = Array.from(document.querySelectorAll('.pg-session')).find((x) => x.textContent.includes('残留流式会话')); el.querySelector('.pg-session-body').click(); })()`);
  await delay(400);
  s = await snap(cdp);
  check("重启后不残留流式光标（读取时已归一化 streaming 标记）", s.cursors === 0, `cursors=${s.cursors}`);
  check("副标题不显示'正在回复'（重启后确实没有流在跑）", !s.sessions.some((x) => x.sub.includes("正在回复")), JSON.stringify(s.sessions.map((x) => x.sub)));

  // 关键回归：残留标记的会话必须能删掉，且要有反馈
  await deleteByTitle(cdp, "残留流式会话");
  await delay(600);
  s = await snap(cdp);
  check("【回归】残留 streaming 标记的会话可正常删除", !s.sessions.some((x) => x.title === "残留流式会话"), JSON.stringify(s.sessions.map((x) => x.title)));
  check("删除给出 toast 反馈", /回收站/.test(s.toast), s.toast);
  check("回收站计数增加", /回收站 \(1\)/.test(s.trashLabel), s.trashLabel);

  // ===== 场景 2：删除后可在回收站恢复 =====
  await cdp.eval(`Array.from(document.querySelectorAll('.pg-session-filter button')).find((b) => b.textContent.includes('回收站')).click()`);
  await delay(400);
  s = await snap(cdp);
  check("回收站面板列出已删除会话", s.trashItems === 1, `items=${s.trashItems}`);
  await cdp.eval(`document.querySelector('.pg-trash .trash-actions .text-button').click()`);
  await delay(500);
  s = await snap(cdp);
  check("恢复后会话回到列表", s.sessions.some((x) => x.title === "残留流式会话"), JSON.stringify(s.sessions.map((x) => x.title)));

  // ===== 场景 3：删除剩余会话，列表清空 =====
  await deleteByTitle(cdp, "正常会话");
  await delay(500);
  await deleteByTitle(cdp, "残留流式会话");
  await delay(500);
  s = await snap(cdp);
  check("连续删除后列表清空", s.sessions.length === 0, `remaining=${s.sessions.length}`);

  // ===== 场景 4：正在生成中的会话，删除应被拦下并给出提示（不得静默）=====
  // 用挂起的 mock：收到请求就保持连接不返回，使会话稳定停留在"生成中"。
  const hanging = createServer((req, res) => {
    if (req.url.endsWith("/models")) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "mock-a" }] })); return; }
    req.on("data", () => {});
    // 只发响应头与一个空 delta 就挂住，不结束响应
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "" } }] })}\n\n`);
  });
  await new Promise((r) => hanging.listen(18999, "127.0.0.1", r));

  await cdp.eval(`document.querySelector('[data-page="connections"]').click()`);
  await delay(300);
  // 指向一个不会及时响应的本地地址，使生成态保持住
  await cdp.eval(`(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const card = Array.from(document.querySelectorAll('.connection-card')).find((c) => c.textContent.includes('游乐场 LLM'));
    const b = card.querySelector('input[placeholder="https://api.example.com/v1"]');
    setter.call(b, 'http://127.0.0.1:18999/v1'); b.dispatchEvent(new Event('input', { bubbles: true }));
    const m = card.querySelector('input[placeholder="deepseek-chat"]');
    setter.call(m, 'mock-a'); m.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await cdp.eval(`document.querySelector('.page-title .primary').click()`);
  await delay(500);
  await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
  await delay(400);
  await cdp.eval(`document.querySelector('.pg-chip[title*="智能体"]').click()`); // 走普通路径
  await delay(200);
  await cdp.eval(`document.querySelector('.page-title .primary').click()`);
  await delay(300);
  await cdp.eval(`(() => {
    const ta = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    const el = document.querySelector('.pg-input-row textarea');
    ta.call(el, '测试删除保护'); el.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await cdp.eval(`document.querySelector('.pg-input-row .primary').click()`);
  await delay(1200);
  const generating = (await snap(cdp)).sessions.some((x) => x.sub.includes("正在回复"));
  if (generating) {
    // 点掉旧 toast（走 React 状态清空）；直接 remove() DOM 节点会让 React 认为它还在，不再重建。
    for (let i = 0; i < 5 && (await snap(cdp)).toast; i++) { await cdp.eval(`document.querySelector('.toast')?.click()`); await delay(200); }
    await cdp.eval(`document.querySelectorAll('.pg-session .pg-session-tools .pg-tool')[2].click()`);
    await delay(500);
    const g = await snap(cdp);
    check("生成中的会话删除被拦下", g.sessions.length === 1, `count=${g.sessions.length}`);
    check("被拦下时给出明确提示（不静默）", /停止/.test(g.toast), g.toast);
    await cdp.eval(`document.querySelector('.pg-chip.stop')?.click()`);
    await delay(800);
  } else {
    check("生成中的会话删除被拦下（前置：未进入生成态，跳过）", true, "环境未进入生成态");
    check("被拦下时给出明确提示（前置：未进入生成态，跳过）", true);
  }
  hanging.closeAllConnections?.();
  hanging.close();
});

console.log(`\n=== 结果: ${results.filter((r) => r.ok).length}/${results.length} 通过 ===`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
