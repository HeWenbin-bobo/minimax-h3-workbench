// 测试 04：任务取消（ComfyUI mock 两步取消）+ RB 后端提交/下载链路
import { createServer } from "node:http";
import { withApp } from "./driver.mjs";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`); };

// ===== Part A: ComfyUI 取消 =====
let interrupted = false;
const comfyServer = createServer((req, res) => {
  const url = req.url || "";
  if (req.method === "POST" && url.endsWith("/prompt")) {
    req.on("data", () => {});
    req.on("end", () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ prompt_id: "cancel-test" })); });
    return;
  }
  if (req.method === "GET" && url.includes("/history/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}"); // 永不完成，留取消窗口
    return;
  }
  if (req.method === "POST" && url.endsWith("/interrupt")) { interrupted = true; res.writeHead(200); res.end(); return; }
  if (req.method === "POST" && url.endsWith("/queue")) { res.writeHead(200); res.end(); return; }
  if (req.method === "GET" && url.includes("/object_info")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      MiniMaxH3ImageToVideo: {}, MiniMaxH3ReferenceToVideo: {},
      UNETLoader: { input: { required: { unet_name: [["minimax_h3_fl2va_pruned_int8_convrot.safetensors", "minimax_h3_ref2va_pruned_int8_convrot.safetensors"]] } } },
      CLIPLoader: { input: { required: { clip_name: [["qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"]] } } },
      VAELoader: { input: { required: { vae_name: [["minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae_fp32.safetensors"]] } } }
    }));
    return;
  }
  if (req.method === "GET" && url.endsWith("/system_stats")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ system: { comfyui_version: "0.31.0" } }));
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => comfyServer.listen(18188, "127.0.0.1", r));

// ===== Part B: RB 后端 =====
const rbServer = createServer((req, res) => {
  const url = req.url || "";
  if (req.method === "POST" && url.endsWith("/api/v1/uploads")) {
    req.on("data", () => {});
    req.on("end", () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ items: [{ ref: "img-ref-1" }] })); });
    return;
  }
  if (req.method === "POST" && url.endsWith("/api/v1/jobs")) {
    req.on("data", () => {});
    req.on("end", () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ id: "rb-job-1" })); });
    return;
  }
  if (req.method === "POST" && url.includes("/cancel")) { rbCancelled = true; res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); return; }
  if (req.method === "GET" && url.includes("/api/v1/jobs/rb-job-1/video")) {
    res.writeHead(200, { "Content-Type": "video/mp4" });
    res.end(Buffer.from("rb-video"));
    return;
  }
  if (req.method === "GET" && url.includes("/api/v1/jobs/rb-job-1")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "succeeded", has_video: true }));
    return;
  }
  res.writeHead(404); res.end();
});
let rbCancelled = false;
await new Promise((r) => rbServer.listen(18190, "127.0.0.1", r));

const SETTER = `(() => {
  const si = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  window.__setInput = (el, v) => { si.call(el, v); el.dispatchEvent(new Event("input", {bubbles:true})); };
})()`;

async function configureBackend(cdp, cardTitle, inputSelector, value) {
  await cdp.eval(`document.querySelector('[data-page="connections"]').click()`);
  await new Promise(r => setTimeout(r, 300));
  await cdp.eval(`(() => { ${SETTER}
    const card = Array.from(document.querySelectorAll('.connection-card')).find(c => c.textContent.includes('${cardTitle}'));
    window.__setInput(card.querySelector('${inputSelector}'), '${value}');
  })()`);
  await cdp.eval(`document.querySelector('.page-title .primary').click()`);
  await new Promise(r => setTimeout(r, 600));
}

await withApp({}, async (cdp) => {
  // Part A: ComfyUI 取消
  await configureBackend(cdp, "本机 ComfyUI", "input", "http://127.0.0.1:18188");
  await cdp.eval(`document.querySelector('[data-page="studio"]').click()`);
  await new Promise(r => setTimeout(r, 300));
  await cdp.eval(`(() => { const sel = Array.from(document.querySelectorAll('select')).find(s => Array.from(s.options).some(o => o.textContent === '1 路')); sel.value = '1'; sel.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  await cdp.eval(`document.querySelector('.submit-area .primary').click()`);
  await new Promise(r => setTimeout(r, 2500));
  check("A-任务运行中", await cdp.eval(`document.querySelector('.task-card.running') !== null`));
  await cdp.eval(`(() => { const btn = document.querySelector('.task-card .cancel-button'); if (btn) btn.click(); })()`);
  await new Promise(r => setTimeout(r, 2200));
  check("A-任务取消终态", await cdp.eval(`document.querySelector('.task-card.cancelled') !== null`));
  check("A-后端收到中断请求", interrupted);
});

await withApp({}, async (cdp) => {
  // Part B: RB 后端——reference 预设（文生视频）
  await configureBackend(cdp, "瞬映 RB", 'input', "http://127.0.0.1:18190");
  await cdp.eval(`(async () => { await window.h3.setSecret("rbCardCode", "e2e-test-card"); return true; })()`);
  await cdp.eval(`document.querySelector('[data-page="studio"]').click()`);
  await new Promise(r => setTimeout(r, 300));
  await cdp.eval(`(() => { const sel = Array.from(document.querySelectorAll('select')).find(s => Array.from(s.options).some(o => o.value === 'rb')); sel.value = 'rb'; sel.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  await new Promise(r => setTimeout(r, 300));
  await cdp.eval(`document.querySelector('.submit-area .primary').click()`);
  await new Promise(r => setTimeout(r, 4000));
  check("B-RB任务成功", await cdp.eval(`document.querySelector('.task-card.succeeded') !== null`));
  check("B-RB任务进度100%", await cdp.eval(`(() => { const em = document.querySelector('.task-card.succeeded em'); return em?.textContent === '100%'; })()`));
});

comfyServer.close();
rbServer.close();
const failed = results.filter(r => !r.ok);
console.log(`\n=== 结果: ${results.length - failed.length}/${results.length} 通过 ===`);
process.exit(failed.length ? 1 : 0);
