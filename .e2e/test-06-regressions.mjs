// 测试 06：模拟人类操作实测发现的回归护栏
// 覆盖 2026-10-10 一轮修复中、此前无入库 E2E 的四项：
//   1) 分类用内联输入框（window.prompt 在 Electron 中不可用）
//   2) 启动不给历史任务重播系统通知
//   3) 智能体「联网」开关控制 web_search 工具暴露
//   4) 改输出目录后历史结果仍可预览（任务记录白名单）
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { connect } from "./driver.mjs";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`); };
const ELECTRON = "node_modules/electron/dist/electron.exe";
const setReact = `(() => {
  const si = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  const st = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  window.__set = (el, v) => { (el.tagName === "TEXTAREA" ? st : si).call(el, v); el.dispatchEvent(new Event("input", {bubbles:true})); };
})()`;

// ---------- mock LLM：记录 tools，供断言联网开关 ----------
let llmToolNames = [];
const llm = createServer((req, res) => {
  const url = req.url || "";
  if (req.method === "POST" && url === "/search") {
    req.on("data", () => {});
    req.on("end", () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ results: [{ title: "t", url: "https://e.com", snippet: "s" }] })); });
    return;
  }
  if (req.method === "GET" && url.endsWith("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "mock-a" }] }));
    return;
  }
  if (req.method === "POST" && url.endsWith("/chat/completions")) {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      const names = (parsed.tools ?? []).map((t) => t.function?.name).filter(Boolean);
      if (names.length) llmToolNames = names;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "好" } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => llm.listen(18971, "127.0.0.1", r));

// ---------- 预置 userData：新输出目录 + 一条指向旧目录的成功任务 ----------
const base = await mkdtemp(path.join(tmpdir(), "h3-t06-"));
const dirOld = path.join(base, "old-out");
const dirNew = path.join(base, "new-out");
const userData = path.join(base, "userdata");
const otherDir = path.join(base, "unrelated");
for (const d of [dirOld, dirNew, userData, otherDir]) await mkdir(d, { recursive: true });
const historicVideo = path.join(dirOld, "historic.mp4");
await copyFile(path.join(process.cwd(), "public", "demo-videos", "showcase-01.mp4"), historicVideo);
const unrelatedVideo = path.join(otherDir, "secret.mp4");
await copyFile(historicVideo, unrelatedVideo);

const now = new Date().toISOString();
await writeFile(path.join(userData, "settings.json"), JSON.stringify({
  localComfyUrl: "http://127.0.0.1:8188",
  outputDirectory: dirNew, // 用户已把输出目录改到新位置
  comfyuiRoot: "",
  rbBaseUrl: "https://rb.coolhs.com",
  defaultBackend: "local",
  minimaxBaseUrl: "https://api.minimax.io",
  llm: { provider: "custom", baseUrl: "http://127.0.0.1:18971/v1", model: "mock-a", systemPrompt: "" },
  searchApi: { baseUrl: "http://127.0.0.1:18971" },
  ssh: { name: "远程显卡", host: "", port: 22, username: "root", privateKeyPath: "", hostFingerprint: "", remoteComfyHost: "127.0.0.1", remoteComfyPort: 8188, remoteComfyPath: "~/ComfyUI" }
}, null, 2));
await writeFile(path.join(userData, "tasks.json"), JSON.stringify([{
  id: "historic-task", parentId: "historic-parent", index: 0, seed: 1,
  backend: "local", mode: "text", status: "succeeded", progress: 100,
  prompt: "历史任务", createdAt: now, updatedAt: now, message: "生成完成",
  outputPath: historicVideo
}], null, 2));

const child = spawn(ELECTRON, [".", "--remote-debugging-port=9222"], {
  cwd: process.cwd(), env: { ...process.env, H3_USER_DATA: userData }, stdio: ["ignore", "pipe", "pipe"]
});
child.stderr.on("data", () => {});
let wsUrl;
for (let i = 0; i < 60; i++) {
  try {
    const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
    const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch {}
  await delay(500);
}
if (!wsUrl) { child.kill(); throw new Error("CDP 不可达"); }
const cdp = await connect(wsUrl);

// 注入 Notification 间谍（在下次导航前生效）
await cdp.send("Page.enable");
await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.__notifs = [];
    window.Notification = class { constructor(title, opts) { window.__notifs.push(opts?.body || ""); } static permission = "granted"; static requestPermission() { return Promise.resolve("granted"); } };`
});
await cdp.send("Page.reload");
await delay(3500);

// ---------- 1. 启动不重播历史通知 ----------
const notifs = JSON.parse(await cdp.eval(`JSON.stringify(window.__notifs || [])`));
check("启动-不给历史任务重播通知", notifs.length === 0, `通知数=${notifs.length}: ${notifs.join(" / ")}`);

// ---------- 2. h3media：有任务记录的历史结果仍可预览；无记录的仍被拒 ----------
const mediaProbe = (filePath) => cdp.eval(`(() => new Promise((resolve) => {
  const v = document.createElement('video');
  v.onerror = () => resolve("err");
  v.onloadeddata = () => resolve("ok");
  v.src = "h3media://local/file?path=" + encodeURIComponent(${JSON.stringify(filePath)}) + "&t=" + Date.now() + Math.random();
  setTimeout(() => resolve("timeout"), 5000);
}))()`);
check("h3media-改目录后历史结果仍可预览", (await mediaProbe(historicVideo)) === "ok", `结果=${await mediaProbe(historicVideo)}`);
check("h3media-无任务记录的目录外文件仍被拒", (await mediaProbe(unrelatedVideo)) === "err", `结果=${await mediaProbe(unrelatedVideo)}`);
const showUnrelated = JSON.parse(await cdp.eval(`window.h3.showItem(${JSON.stringify(unrelatedVideo)}).then(r => JSON.stringify({ ok: r.ok }))`));
check("showItem-无记录的目录外文件仍被拒", showUnrelated.ok === false, JSON.stringify(showUnrelated));

// ---------- 3. 分类用内联输入框（不依赖 window.prompt）----------
const made = JSON.parse(await cdp.eval(`window.h3.submitGeneration({ mode:"text", backend:"minimax", prompt:"分类回归用例", duration:4, ratio:"16:9", resolution:"768P", width:1280, height:720, count:1, baseSeed:1 }).then(r => JSON.stringify({ ok: r.ok, id: r.data?.[0]?.id }))`));
check("分类-前置任务已创建", made.ok, JSON.stringify(made));
await delay(1000);
await cdp.eval(`document.querySelector('[data-page="studio"]').click()`);
await delay(700);
// 必须先选中一个项目：「＋ 分类」在"新建任务"视图下是 disabled（无当前项目可归类）。
await cdp.eval(`(() => { const tab = Array.from(document.querySelectorAll('.project-tab')).find(t => !t.classList.contains('new-task')); tab?.click(); })()`);
await delay(500);
const hasCatBtn = await cdp.eval(`Array.from(document.querySelectorAll('.category-filter button')).some(b => b.textContent.includes('＋ 分类'))`);
check("分类-「＋ 分类」按钮存在", hasCatBtn);
const catBtnEnabled = await cdp.eval(`Array.from(document.querySelectorAll('.category-filter button')).find(b => b.textContent.includes('＋ 分类'))?.disabled === false`);
check("分类-选中项目后按钮可用", catBtnEnabled);
await cdp.eval(`Array.from(document.querySelectorAll('.category-filter button')).find(b => b.textContent.includes('＋ 分类'))?.click()`);
await delay(400);
check("分类-点击后出现内联输入框（非 window.prompt）", await cdp.eval(`Boolean(document.querySelector('.cat-input'))`));
await cdp.eval(`(() => { ${setReact}; window.__set(document.querySelector('.cat-input'), '回归分类'); })()`);
await cdp.eval(`(() => { const el = document.querySelector('.cat-input'); el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); el.blur(); })()`);
await delay(1000);
const catApplied = JSON.parse(await cdp.eval(`window.h3.listTasks().then(r => JSON.stringify((r.data||[]).filter(t => t.id === ${JSON.stringify(made.id)}).map(t => t.category)))`));
check("分类-Enter 提交后已写入任务", catApplied[0] === "回归分类", JSON.stringify(catApplied));

// ---------- 4. 智能体「联网」开关控制 web_search 工具 ----------
await cdp.eval(`window.h3.setSecret("llmApiKey", "mock-llm-key").then(r => r.ok)`); // 假 Key
await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
await delay(500);
const sendAgentMsg = async (toggleWebSearch) => {
  llmToolNames = [];
  await cdp.eval(`Array.from(document.querySelectorAll('.page-title button')).find(b => b.textContent === '新对话').click()`);
  await delay(300);
  // 联网/浏览器搜索默认开启且不互斥（fc040d3）：要彻底关掉 web_search 工具须两个 chip 都关。
  for (const chip of ["联网", "浏览器搜索"]) {
    const shouldOn = toggleWebSearch;
    await cdp.eval(`(() => {
      const b = Array.from(document.querySelectorAll('.pg-chip')).find(x => x.textContent.includes(${JSON.stringify(chip)}));
      if (b && b.classList.contains('on') !== ${shouldOn}) b.click();
    })()`);
    await delay(200);
  }
  await cdp.eval(`(() => { ${setReact}; window.__set(document.querySelector('.pg-input-row textarea'), '回归测试消息'); })()`);
  await delay(200);
  await cdp.eval(`document.querySelector('.pg-input-row button.primary').click()`);
  await delay(4500);
  return llmToolNames;
};
const offTools = await sendAgentMsg(false);
console.log(`  联网关 → 请求内工具: ${JSON.stringify(offTools)}`);
check("智能体-关闭联网时不暴露 web_search", !offTools.includes("web_search"), JSON.stringify(offTools));
check("智能体-关闭联网时仍暴露 generate_video", offTools.includes("generate_video"), JSON.stringify(offTools));
const onTools = await sendAgentMsg(true);
console.log(`  联网开 → 请求内工具: ${JSON.stringify(onTools)}`);
check("智能体-开启联网时暴露 web_search", onTools.includes("web_search"), JSON.stringify(onTools));

cdp.close();
child.kill();

const failed = results.filter((r) => !r.ok);
console.log(`\n=== 结果: ${results.length - failed.length}/${results.length} 通过 ===`);
process.exit(failed.length ? 1 : 0);
