// 回归护栏：不可逆 / 有副作用的操作必须挡得住同一 tick 的连点。
//
// 背景：React 的 `useState` 更新是异步提交的，若只靠 `disabled={busy}` 或
// `if (busy) return` 守卫，同一 tick 内连点 N 次会全部通过判据。
// 本轮（2026-10-21/22 探索期）按这个根因连续修了 6 处：
//   retry / submitVideo / manualCompact / answerQuestions / test(含 testLlm) / purge(含 restore, deleteProject)
//
// 本套件只测**能廉价复现且后果明确**的两处：
//   1. 回收站「确认删除」连点 3 次 → 该组记录必须只被彻底删除一次、且删净
//      （彻底删除不可逆，重复执行最不该发生）
//   2. 连接页 LLM「测试连接」连点 3 次 → 上游只能收到 1 次模型列表请求
//      （修复前实测 3 次，等于白打 3 次站外请求）
//
// 关键做法：请求次数的统计放在**渲染端观察不到的地方**。
// 早期尝试包装 `window.h3.purgeTasks` 得到 0 次，是因为 React 组件持有的是
// preload 暴露对象的原始方法引用，包装 `window.h3` 上的同名属性不起作用——
// 这类"探针自身失效但报通过"的假结果必须用另一种独立手段交叉验证，
// 因此这里改为在**上游 HTTP 服务**（天然在主进程之外）计请求数。
import { createServer } from "node:http";
import { withApp } from "./driver.mjs";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- mock 上游（数请求次数）----------
let upstreamHits = 0;
const llm = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    upstreamHits += 1;
    if ((req.url || "").endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "mock-model" }] }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "好" } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((r) => llm.listen(18961, "127.0.0.1", r));

await withApp({}, async (cdp) => {
  // ---------- #1 回收站「确认删除」连点 ----------
  // 先清空回收站，保证"删掉的确实只有本用例造的这组"。
  await cdp.eval(`(async () => { const r = await window.h3.listDeletedTasks(); const ids = (r.data||[]).map(t => t.id); if (ids.length) await window.h3.purgeTasks(ids); return ids.length; })()`);

  const submitted = JSON.parse(await cdp.eval(`(async () => {
    const r = await window.h3.submitGeneration({ prompt: "PURGE-GUARD-E2E", backend: "local", duration: 4, resolution: "480P", ratio: "16:9", seed: 1 });
    return JSON.stringify({ ok: r.ok, ids: (r.data||[]).map(t => t.id) });
  })()`));
  // 断言前提真的发生了：没建出任务就没法测删除，必须显式检查。
  check("#1 前提：任务已建出", submitted.ok && submitted.ids.length > 0, JSON.stringify(submitted));

  const idsJson = JSON.stringify(submitted.ids);
  const deleted = JSON.parse(await cdp.eval(`(async () => { const r = await window.h3.deleteTasks(${idsJson}); return JSON.stringify({ ok: r.ok, n: (r.data||[]).length }); })()`));
  check("#1 前提：已软删除进回收站", deleted.ok && deleted.n === submitted.ids.length, JSON.stringify(deleted));

  await cdp.eval(`document.querySelector('[data-page="studio"]').click()`);
  await wait(500);
  await cdp.eval(`(() => { const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').includes('回收站')); if (b) b.click(); return Boolean(b); })()`);
  await wait(800);

  // 两段式确认：先点「彻底删除」进入待确认态。
  const armed = await cdp.eval(`(() => {
    const del = Array.from(document.querySelectorAll('.trash-actions button')).find(b => (b.textContent||'').includes('彻底删除'));
    if (!del) return 'no-armed-button';
    del.click();
    return 'armed';
  })()`);
  check("#1 前提：「彻底删除」进入待确认态", armed === "armed", armed);
  await wait(300);

  // 同一个 eval 里连点 3 次（跨 eval 会因 React 异步提交而读到已更新的 DOM，测不到同一 tick）。
  const triple = await cdp.eval(`(() => {
    const ok = Array.from(document.querySelectorAll('.trash-actions button')).find(b => (b.textContent||'').includes('确认删除'));
    if (!ok) return 'no-confirm-button';
    ok.click(); ok.click(); ok.click();
    return 'clicked-3x';
  })()`);
  check("#1 前提：「确认删除」连点 3 次已发出", triple === "clicked-3x", triple);
  await wait(1500);

  // 结果判据：本用例那一组必须从回收站消失（删除真的生效），且不残留。
  const after = JSON.parse(await cdp.eval(`(async () => {
    const r = await window.h3.listDeletedTasks();
    const mine = (r.data||[]).filter(t => t.prompt === 'PURGE-GUARD-E2E');
    return JSON.stringify({ total: (r.data||[]).length, mine: mine.length });
  })()`));
  check("#1 连点后记录确实删净", after.mine === 0, JSON.stringify(after));

  // 界面与主进程一致：列表里不再有该条目，且提示里的**条数**对得上。
  // 这一条是整套用例真正抓得住回归的地方：`purge` 的提示文案带的是主进程
  // 实际清掉的条数，而 `store.save` 会串行化、`unlinkIfInside` 对不存在的文件静默返回，
  // 所以"重复执行"在产物上几乎无痕——只看得见文案。
  // 守卫失效时，第 2/3 次点击拿到空数组，提示会被覆盖成"已不在回收站"，
  // 于是下面的 `toast` 判据必然失败（变异验证确认过）。
  const ui = JSON.parse(await cdp.eval(`(() => JSON.stringify({
    items: Array.from(document.querySelectorAll('.trash-item')).map(e => (e.textContent||'')).filter(t => t.includes('PURGE-GUARD-E2E')).length,
    toast: Array.from(document.querySelectorAll('.toast, .notice, [role=alert]')).map(e => (e.textContent||'').trim()).join(' | ')
  }))()`));
  check("#1 列表无残留", ui.items === 0, JSON.stringify(ui.items));
  // 提示必须写出"已彻底删除 N 条"且 N 等于本组条数——写死文案或重复执行都过不了。
  const expectCount = submitted.ids.length;
  check("#1 提示里的条数与实际删除数一致", ui.toast.includes(`已彻底删除 ${expectCount} 条`), ui.toast.slice(0, 80));

  // ---------- #2 连接页 LLM「测试连接」连点 ----------
  await cdp.eval(`window.h3.updateSettings({ llm: { provider: "custom", baseUrl: "http://127.0.0.1:18961/v1", model: "mock-model", systemPrompt: "" } }).then(r => r.ok)`);
  await cdp.eval(`window.h3.setSecret("llmApiKey", "mock-key").then(r => r.ok)`);
  await cdp.send("Page.reload");
  await wait(2500);
  await cdp.eval(`document.querySelector('[data-page="connections"]').click()`);
  await wait(700);

  const before = upstreamHits;
  const probe = await cdp.eval(`(() => {
    const card = Array.from(document.querySelectorAll('.connection-card')).find(c => ((c.querySelector('h2')||{}).textContent||'') === '游乐场 LLM（OpenAI 兼容）');
    const btn = card && card.querySelector('header button');
    if (!btn) return 'no-card-button';
    btn.click(); btn.click(); btn.click();
    return 'clicked-3x';
  })()`);
  check("#2 前提：LLM 卡片按钮连点 3 次已发出", probe === "clicked-3x", probe);
  await wait(3000);
  const hits = upstreamHits - before;
  // mock 明确支持 GET /models，所以只该有 **1** 次。
  // 早先写成 `<= 2`（给"服务商不支持列表接口、回退发一条对话"留余量）——
  // 变异验证时连点发 2 次请求照样通过，等于没测到。这里改用严格等于：
  // 若上游真的走了对话回退，说明 mock 的行为变了，应当单独发现，而不是被余量吞掉。
  check("#2 上游请求恰好 1 次（连点被挡住）", hits === 1, `上游请求 ${hits} 次`);

  const llmResult = await cdp.eval(`(() => { const el = document.querySelector('.test-result'); return el ? (el.textContent||'').trim() : 'no-result'; })()`);
  check("#2 界面给出了测试结果", llmResult !== "no-result" && llmResult.length > 0, llmResult.slice(0, 60));
});

llm.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n=== 结果: ${results.length - failed.length}/${results.length} 通过 ===`);
process.exit(failed.length ? 1 : 0);
