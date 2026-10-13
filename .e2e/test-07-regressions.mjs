// 回归护栏（2026-10-11 探索测试发现并修复的 4 项缺陷）：
//   1. 游乐场视频表单未按后端收敛时长 → RB 非法 seconds+preset 组合真的发到云端（失败也扣卡密次数）
//   2. 后端不可达时把 undici 的裸 "fetch failed" 透传到卡片/toast/聊天气泡（英文、无法定位）
//   3. 提示词计数器标称 2000 字，但文本域无 maxlength、主进程也不校验，超长描述可提交
//   4. 项目条 slice(0,12) 且无「更多」入口 → 第 13 个之后的项目在界面上完全不可达
//   5. TaskStore 落盘再硬截 200 条，与 trimHistory（回收站不参与计数）口径冲突 → 重启后任务静默丢失
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withApp } from "./driver.mjs";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- mock RB 云（记录真实提交体）----------
const jobBodies = [];
const rb = createServer((req, res) => {
  const url = req.url || "";
  const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (req.method === "GET" && url.startsWith("/api/v1/jobs")) { json(200, { job: { id: "j1", status: "succeeded", has_video: true } }); return; }
  if (req.method === "POST" && url === "/api/v1/jobs") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => { try { jobBodies.push(JSON.parse(body)); } catch {} json(200, { job: { id: "j1" } }); });
    return;
  }
  if (url.endsWith("/video")) { res.writeHead(200, { "Content-Type": "video/mp4" }); res.end(Buffer.from("fake")); return; }
  json(404, {});
});
await new Promise((r) => rb.listen(18931, "127.0.0.1", r));

await withApp({}, async (cdp) => {
  await cdp.eval(`(() => {
    const si = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const st = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    const ss = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    window.__set = (el, v) => { (el.tagName === 'TEXTAREA' ? st : si).call(el, v); el.dispatchEvent(new Event('input', {bubbles:true})); };
    window.__setSel = (el, v) => { ss.call(el, v); el.dispatchEvent(new Event('change', {bubbles:true})); };
    window.__click = (text) => { const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === text); if (b) b.click(); return Boolean(b); };
  })()`);

  // ---------- #1 游乐场 RB 时长夹取 ----------
  await cdp.eval(`window.h3.updateSettings({ rbBaseUrl: "http://127.0.0.1:18931", defaultBackend: "rb" }).then(r => r.ok)`);
  await cdp.eval(`window.h3.setSecret("rbCardCode", "mock-card").then(r => r.ok)`);
  await wait(400);
  await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
  await wait(400);
  await cdp.eval(`Array.from(document.querySelectorAll('.pg-chip')).find(b => b.textContent.includes('生成视频')).click()`);
  await wait(300);
  const durSel = `document.querySelectorAll('.pg-video-form select')[1]`;
  const backendSel = `document.querySelectorAll('.pg-video-form select')[0]`;
  await cdp.eval(`window.__setSel(${backendSel}, 'local')`); await wait(300);
  await cdp.eval(`window.__setSel(${durSel}, '15')`); await wait(300);
  check("#1 本机后端仍可选 15 秒", (await cdp.eval(`${durSel}.value`)) === "15");
  await cdp.eval(`window.__setSel(${backendSel}, 'rb')`); await wait(400);
  const rbOpts = await cdp.eval(`Array.from(${durSel}.options).map(o => o.value).join(',')`);
  check("#1 切到 RB 后时长选项收窄为 4/6/8", rbOpts === "4,6,8", `实际=${rbOpts}`);
  const clamped = await cdp.eval(`${durSel}.value`);
  check("#1 切到 RB 后旧时长被夹回合法值", [4, 6, 8].includes(Number(clamped)), `实际=${clamped}`);
  await cdp.eval(`window.__set(document.querySelector('.pg-video-form textarea'), '回归护栏描述')`); await wait(200);
  await cdp.eval(`window.__click('提交生成任务')`); await wait(2500);
  const body = jobBodies.at(-1);
  check("#1 发往云端的 seconds 在预设合法值域内", Boolean(body) && body.preset === "reference" && [4, 6, 8].includes(body.seconds), `preset=${body?.preset} seconds=${body?.seconds}`);

  // ---------- #2 网络错误中文化 ----------
  await cdp.eval(`window.h3.updateSettings({ localComfyUrl: "http://127.0.0.1:19999", minimaxBaseUrl: "http://127.0.0.1:19998", rbBaseUrl: "http://127.0.0.1:19997", llm: { provider:"custom", baseUrl:"http://127.0.0.1:19996/v1", model:"m", systemPrompt:"" } }).then(r => r.ok)`);
  await cdp.eval(`window.h3.setSecret("minimaxApiKey","k").then(r=>r.ok)`);
  await cdp.eval(`window.h3.setSecret("llmApiKey","k").then(r=>r.ok)`);
  await wait(400);
  const chinese = /[一-龥]/;
  for (const [label, kind] of [["本机 ComfyUI","local"],["MiniMax 云 API","minimax"],["瞬映 RB","rb"]]) {
    const r = JSON.parse(await cdp.eval(`window.h3.testBackend(${JSON.stringify(kind)}).then(x => JSON.stringify(x.data))`));
    check(`#2 ${label} 不可达时给出中文文案`, chinese.test(String(r?.message)) && !/fetch failed/i.test(String(r?.message)), `"${r?.message}"`);
  }
  const llmTest = JSON.parse(await cdp.eval(`window.h3.testLlm().then(x => JSON.stringify(x.data || {message:x.message}))`));
  check("#2 游乐场 LLM 不可达时给出中文文案", chinese.test(String(llmTest?.message)) && !/fetch failed/i.test(String(llmTest?.message)), `"${llmTest?.message}"`);

  // ---------- #3 提示词长度上限 ----------
  const overflow = await cdp.eval(`window.h3.submitGeneration({ mode:"text", backend:"local", prompt:"长".repeat(2001), duration:4, ratio:"16:9", resolution:"768P", width:1280, height:720, count:1, baseSeed:1 }).then(r => JSON.stringify({ ok:r.ok, msg:r.message }))`);
  const rejected = JSON.parse(overflow);
  check("#3 超长提示词被主进程拒绝", rejected.ok === false && /2000/.test(rejected.msg || ""), JSON.stringify(rejected));
  const atLimit = await cdp.eval(`window.h3.submitGeneration({ mode:"text", backend:"local", prompt:"长".repeat(2000), duration:4, ratio:"16:9", resolution:"768P", width:1280, height:720, count:1, baseSeed:1 }).then(r => r.ok)`);
  check("#3 恰好 2000 字放行", atLimit === true);
  await cdp.eval(`document.querySelector('[data-page="studio"]').click()`); await wait(400);
  check("#3 工作台文本域带 maxlength=2000", (await cdp.eval(`document.querySelector('.control-panel textarea').getAttribute('maxlength')`)) === "2000");

  // ---------- #4 项目条不再截断 ----------
  for (let i = 0; i < 15; i += 1) {
    await cdp.eval(`window.h3.submitGeneration({ mode:"text", backend:"local", prompt:"护栏项目"+String(${i}).padStart(2,"0"), duration:4, ratio:"16:9", resolution:"768P", width:1280, height:720, count:1, baseSeed:${i} }).then(r=>r.ok)`);
  }
  await wait(1500);
  await cdp.eval(`document.querySelector('[data-page="ready"]').click()`); await wait(300);
  await cdp.eval(`document.querySelector('[data-page="studio"]').click()`); await wait(800);
  const total = await cdp.eval(`window.h3.listTasks().then(r => new Set((r.data||[]).map(t=>t.parentId)).size)`);
  const shown = await cdp.eval(`document.querySelectorAll('.project-tab:not(.new-task)').length`);
  check("#4 项目 tab 数与后端项目数一致（>12 不再截断）", shown >= total && total > 12, `后端=${total} UI=${shown}`);
  check("#4 最早的项目仍可见可点", await cdp.eval(`Array.from(document.querySelectorAll('.project-tab:not(.new-task) strong')).some(e => e.textContent.includes('护栏项目00'))`));
  check("#4 项目条由横向滚动承载（不溢出页面）", await cdp.eval(`getComputedStyle(document.querySelector('.project-tabs')).overflowX === 'auto'`));
});

// ---------- #5 落盘不再按条数硬截（口径与 trimHistory 一致）----------
// 场景：在役任务接近上限时删除一批进回收站，再补新任务——内存 300 条（200 在役 + 100 回收站），
// 磁盘必须也是 300 条。曾被 TaskStore 的硬截断砍成 200 条，重启后 100 条任务凭空消失。
const storeBase = await mkdtemp(path.join(tmpdir(), "h3-store-"));
const storeUserData = path.join(storeBase, "userdata");
await mkdir(storeUserData, { recursive: true });

await withApp({ H3_USER_DATA: storeUserData }, async (cdp) => {
  await cdp.eval(`window.h3.updateSettings({ localComfyUrl: "http://127.0.0.1:19999", defaultBackend: "local" }).then(r => r.ok)`);
  const bulk = (prompt, groups) => cdp.eval(`(async () => {
    const req = { mode:"text", backend:"local", prompt:${JSON.stringify(prompt)}, duration:4, ratio:"16:9", resolution:"768P", width:1280, height:720, count:4, baseSeed:1 };
    for (let i = 0; i < ${groups}; i++) await window.h3.submitGeneration(req);
    return "ok";
  })()`);

  await bulk("容量护栏", 50); // 200 条在役
  await wait(2000);
  const parents = JSON.parse(await cdp.eval(`window.h3.listTasks().then(r => JSON.stringify(Array.from(new Set((r.data||[]).map(t=>t.parentId))).slice(0,25)))`));
  await cdp.eval(`(async () => { for (const p of ${JSON.stringify(parents)}) { const r = await window.h3.listTasks(); const t = (r.data||[]).find(x=>x.parentId===p); if (t) await window.h3.deleteTasks([t.id]); } return "ok"; })()`);
  await wait(1500);
  await bulk("补充护栏", 25); // 在役回到 200，合计 300
  await wait(2500);

  const inMemory = JSON.parse(await cdp.eval(`(async () => { const a = await window.h3.listTasks(); const b = await window.h3.listDeletedTasks(); return JSON.stringify({ active:(a.data||[]).length, deleted:(b.data||[]).length }); })()`));
  const raw = JSON.parse(await readFile(path.join(storeUserData, "tasks.json"), "utf8"));
  const diskDeleted = raw.filter((t) => t.deletedAt).length;
  console.log(`  内存: 在役=${inMemory.active} 回收站=${inMemory.deleted} | 磁盘=${raw.length} 条（回收站=${diskDeleted}）`);

  check("#5 落盘任务数不少于内存态（不静默丢任务）", raw.length >= inMemory.active + inMemory.deleted, `磁盘=${raw.length} 内存=${inMemory.active + inMemory.deleted}`);
  check("#5 回收站任务全部落盘（7 天可恢复承诺不被打破）", diskDeleted >= inMemory.deleted, `磁盘=${diskDeleted} 内存=${inMemory.deleted}`);
});

// ---------- #6 settings:update 返回值与磁盘一致 ----------
// 曾直接返回未归一化的 patch 结果（非法 defaultBackend、未知字段原样带出），
// 而 get()/重启后读到的是干净值——渲染端立刻采用的却是脏值。
await withApp({}, async (cdp) => {
  const updated = JSON.parse(await cdp.eval(`window.h3.updateSettings({ defaultBackend: "garbage", evil: "x" }).then(r => JSON.stringify({ backend: r.data?.defaultBackend, hasEvil: "evil" in (r.data||{}) }))`));
  const reread = JSON.parse(await cdp.eval(`window.h3.getSettings().then(r => JSON.stringify({ backend: r.data?.defaultBackend, hasEvil: "evil" in (r.data||{}) }))`));
  check("#6 update 返回值中的非法后端已被归一化", ["local", "ssh", "minimax", "rb"].includes(updated.backend), JSON.stringify(updated));
  check("#6 update 返回值不含未知字段", updated.hasEvil === false, JSON.stringify(updated));
  check("#6 update 返回值与 get 读回一致", updated.backend === reread.backend && updated.hasEvil === reread.hasEvil, `update=${JSON.stringify(updated)} get=${JSON.stringify(reread)}`);
  // ssh 局部更新仍应合并而非整体覆盖
  const merged = JSON.parse(await cdp.eval(`window.h3.updateSettings({ ssh: { host: "h.example.com" } }).then(r => JSON.stringify({ host: r.data?.ssh?.host, port: r.data?.ssh?.port }))`));
  check("#6 ssh 局部更新合并不清空其他字段", merged.host === "h.example.com" && merged.port === 22, JSON.stringify(merged));
});

const failed = results.filter((r) => !r.ok);
console.log(`\n=== 结果: ${results.length - failed.length}/${results.length} 通过 ===`);
process.exit(failed.length ? 1 : 0);
