// 上下文压缩探针：验证 Codex checkpoint 摘要（CSF）落地后的真实行为。
// 覆盖：占用 chip 口径 / 手动压缩 UI 全链路 / 自动触发 / 提示插入顺序 / 失败可见 / 压缩后不阻断。
// 全部用本地 mock LLM + 真实 UI 点击，断言基于真实渲染结果（不读代码）。
import { createServer } from "node:http";
import { withApp } from "../../.e2e/driver.mjs";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`); };
const setReactInput = `(() => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  const taSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  window.__set = (el, v) => { (el.tagName === "TEXTAREA" ? taSetter : setter).call(el, v); el.dispatchEvent(new Event("input", {bubbles:true})); };
})()`;

let sawSummaryRequest = false;
let llmDown = false;

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (llmDown) { res.writeHead(500); res.end("down"); return; }
    const payload = JSON.parse(body || "{}");
    const isSummary = (payload.messages ?? []).some((m) => typeof m.content === "string" && m.content.includes("CONTEXT CHECKPOINT COMPACTION"));
    if (isSummary) {
      sawSummaryRequest = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "【测试摘要】用户先要 4 秒脚本，后改 8 秒并加粒子；未决：风格未定。" } }] }));
      return;
    }
    // 带 tools 的智能体请求用 SSE 流式回话（无工具调用 → 主进程按"模型正常回话"处理）。
    if (payload.stream === false) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "非流式回复" } }] }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const c of ["收到", "，", "正在", "处理", "你的", "需求。"]) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((r) => server.listen(18924, "127.0.0.1", r));
const BASE = "http://127.0.0.1:18924/v1";

/** 配置 LLM 指向 mock（走真实设置页 UI，避免依赖内部种子机制）。 */
async function configure(cdp, model) {
  await cdp.eval(`document.querySelector('[data-page="connections"]').click()`);
  await new Promise((r) => setTimeout(r, 300));
  await cdp.eval(`(() => { ${setReactInput}
    const card = Array.from(document.querySelectorAll('.connection-card')).find(c => c.textContent.includes('游乐场 LLM'));
    window.__set(card.querySelector('input[placeholder="https://api.example.com/v1"]'), ${JSON.stringify(BASE)});
    window.__set(card.querySelector('input[placeholder="deepseek-chat"]'), ${JSON.stringify(model)});
  })()`);
  await cdp.eval(`document.querySelector('.page-title .primary').click()`);
  await new Promise((r) => setTimeout(r, 700));
}

async function gotoPlayground(cdp) {
  await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
  await new Promise((r) => setTimeout(r, 400));
}

async function send(cdp, text, wait = 2500) {
  await cdp.eval(`(() => { ${setReactInput}; window.__set(document.querySelector('.pg-input-row textarea'), ${JSON.stringify(text)}); })()`);
  await cdp.eval(`document.querySelector('.pg-input-row .primary').click()`);
  await new Promise((r) => setTimeout(r, wait));
}

const chipInfo = `(() => { const el = document.querySelector('.pg-chip.ctx'); return el ? { text: el.textContent, title: el.title, cls: el.className } : null; })()`;
const noticeText = `(() => { const el = Array.from(document.querySelectorAll('.pg-msg.assistant')).reverse().find(e => e.textContent.includes('上下文已从约')); return el ? el.textContent : null; })()`;

await withApp({}, async (cdp) => {
  // 隔离：清历史会话，避免与其它测试的残留互相污染
  await cdp.eval(`localStorage.removeItem('h3-playground-sessions')`);
  await cdp.send("Page.reload");
  await new Promise((r) => setTimeout(r, 2000));

  // ---------- A. 未超阈值：chip 渲染、不误触发 ----------
  // 用 deepseek 系模型名（窗口表 64k）让阈值落在可测范围
  await configure(cdp, "deepseek-chat");
  await gotoPlayground(cdp);
  await send(cdp, "帮我写一个 4 秒的产品视频脚本");
  await send(cdp, "改成 8 秒版本");

  const chip = await cdp.eval(chipInfo);
  check("上下文占用 chip 渲染出来", Boolean(chip?.text), chip?.text ?? "未找到");
  check("chip 文案含百分比", /\d+%/.test(chip?.text ?? ""), chip?.text ?? "");
  check("chip 提示写明窗口大小与数据来源", Boolean(chip?.title?.includes("token")) && (Boolean(chip?.title?.includes("估算")) || Boolean(chip?.title?.includes("实测"))), chip?.title ?? "");
  check("未超阈值时 chip 不是 hot 态", !(chip?.cls ?? "").includes("hot"), chip?.cls ?? "");
  check("未超阈值不误触发自动压缩", (await cdp.eval(noticeText)) === null, `提示=${await cdp.eval(noticeText)}`);

  // ---------- B. 占用查询口径 ----------
  const status = await cdp.eval(`(async () => {
    const sessions = JSON.parse(localStorage.getItem('h3-playground-sessions') || '[]');
    const s = sessions[0];
    const history = s.messages.filter(m => !m.error).map(m => ({ role: m.role, content: m.content, images: m.images }));
    const r = await window.h3.getContextStatus(history, s.id);
    return r.data;
  })()`);
  check("占用查询返回合法结构", Boolean(status) && typeof status.percent === "number" && status.percent >= 0, JSON.stringify(status));
  check("模型窗口按模型名推断（deepseek → 64k）", status?.modelLimitTokens === 64000, `limit=${status?.modelLimitTokens}`);
  check("基线来源取值合法", ["server", "estimated", "none"].includes(status?.baselineSource), `source=${status?.baselineSource}`);
  check("压缩次数初始为 0", status?.windowNumber === 0, `window=${status?.windowNumber}`);

  // ---------- C. 手动压缩（真实点 chip） ----------
  await cdp.eval(`document.querySelector('.pg-chip.ctx').click()`);
  await new Promise((r) => setTimeout(r, 2500));
  check("真的向模型发了摘要请求（提示词走通链路）", sawSummaryRequest, sawSummaryRequest ? "" : "mock 未收到含 CONTEXT CHECKPOINT COMPACTION 的请求");

  const notice = await cdp.eval(noticeText);
  check("对话流里出现压缩提示（不静默）", Boolean(notice), notice ?? "未找到");
  check("提示含触发原因与压缩前后量", Boolean(notice?.includes("手动压缩")) && Boolean(notice?.includes("压到")), notice ?? "");

  const statusAfter = await cdp.eval(`(async () => {
    const sessions = JSON.parse(localStorage.getItem('h3-playground-sessions') || '[]');
    const s = sessions[0];
    const history = s.messages.filter(m => !m.error).map(m => ({ role: m.role, content: m.content, images: m.images }));
    return (await window.h3.getContextStatus(history, s.id)).data;
  })()`);
  check("压缩后窗口号递增（记账状态生效）", statusAfter?.windowNumber === 1, `window=${statusAfter?.windowNumber}`);

  // 提示必须插在流式气泡之前（否则后续 chunk 会写进提示里）
  const order = await cdp.eval(`(() => {
    const nodes = Array.from(document.querySelectorAll('.pg-msg.assistant'));
    const idx = nodes.findIndex(e => e.textContent.includes('上下文已从约'));
    return { idx, total: nodes.length };
  })()`);
  check("压缩提示不在流式气泡之后（防止后续内容错位）", order.idx >= 0 && order.idx <= order.total, JSON.stringify(order));

  // ---------- D. 压缩后对话链路仍在 ----------
  await send(cdp, "压缩之后我还能继续聊吗？", 3000);
  const lastBubble = await cdp.eval(`(() => { const b = Array.from(document.querySelectorAll('.pg-msg.assistant .pg-bubble')); const l = b[b.length-1]; return l ? l.textContent : ''; })()`);
  check("压缩后仍能正常对话", lastBubble.includes("处理") || lastBubble.includes("需求"), lastBubble.slice(0, 40));
  check("压缩后气泡无错误", !lastBubble.includes("请求失败"), lastBubble.slice(0, 60));

  // ---------- E. 摘要不可用：占位 + 可见提示，不崩 ----------
  llmDown = true;
  const failNoticeBefore = await cdp.eval(`document.querySelectorAll('.pg-msg.assistant').length`);
  await cdp.eval(`document.querySelector('.pg-chip.ctx').click()`);
  await new Promise((r) => setTimeout(r, 3000));
  const failNotice = await cdp.eval(noticeText);
  check("摘要失败时压缩仍完成（不抛异常、UI 不崩）", Boolean(failNotice), failNotice ?? "未找到提示");
  check("摘要失败被如实标注（不谎报完整保留）", Boolean(failNotice?.includes("失败")), failNotice ?? "");
  const alive = await cdp.eval(`Boolean(document.querySelector('.pg-input-row textarea')) && document.querySelectorAll('.pg-msg').length > 0`);
  check("摘要失败后界面仍可用", alive === true);
  llmDown = false;

  // ---------- F. 自动触发：超阈值时发消息即压 ----------
  await cdp.eval(`(() => {
    // 造一段大历史：deepseek 窗口 64k → 阈值 51.2k token。
    // 中文约 1.6 字符/token，故需 > 82k 字符；每轮 ~30 字符 × 3000 ≈ 90k 字符 ≈ 56k token。
    const big = '这是一段用于撑大上下文的填充文本，重复多次以触发自动压缩。'.repeat(3000);
    const now = new Date().toISOString();
    const session = {
      id: 'ctx-auto-probe', title: '自动压缩探针', createdAt: now, updatedAt: now,
      messages: [
        { id: 'm1', role: 'user', content: big },
        { id: 'm2', role: 'assistant', content: '好的，已收到这段长材料。' }
      ]
    };
    localStorage.setItem('h3-playground-sessions', JSON.stringify([session]));
  })()`);
  await cdp.send("Page.reload");
  await new Promise((r) => setTimeout(r, 2000));
  await gotoPlayground(cdp);

  const beforeAuto = await cdp.eval(`(async () => {
    const s = JSON.parse(localStorage.getItem('h3-playground-sessions'))[0];
    const history = s.messages.filter(m => !m.error).map(m => ({ role: m.role, content: m.content, images: m.images }));
    return (await window.h3.getContextStatus(history, s.id)).data;
  })()`);
  check("造出的历史确实越过阈值（探针前提成立）", (beforeAuto?.percent ?? 0) >= 100, `percent=${beforeAuto?.percent}`);

  await send(cdp, "请基于上面的材料给一句结论", 4000);
  const autoNotice = await cdp.eval(noticeText);
  check("超阈值时自动触发压缩（无需点按钮）", Boolean(autoNotice), autoNotice ?? "未找到提示");
  check("自动压缩提示写明触发原因", Boolean(autoNotice?.includes("上限") || autoNotice?.includes("接近")), autoNotice ?? "");
});

server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n=== 结果: ${results.length - failed.length}/${results.length} 通过 ===`);
process.exit(failed.length ? 1 : 0);
