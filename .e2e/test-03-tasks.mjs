// 测试 03：任务生命周期——mock ComfyUI（history 按调用次数推进：第1次无输出→第2次带视频输出→下载）
import { createServer } from "node:http";
import { withApp } from "./driver.mjs";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`); };

let historyHits = 0;
const promptId = "mock-prompt-1";
const server = createServer((req, res) => {
  const url = req.url || "";
  if (req.method === "POST" && url.endsWith("/prompt")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ prompt_id: promptId }));
      historyHits = 0;
    });
    return;
  }
  if (req.method === "GET" && url.includes("/history/")) {
    historyHits += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    const outputs = historyHits >= 2 ? { "123": { videos: [{ filename: "out.mp4", type: "output" }] } } : {};
    res.end(JSON.stringify({ [promptId]: { status: { status_str: "success" }, outputs } }));
    return;
  }
  if (req.method === "GET" && url.includes("/view?")) {
    res.writeHead(200, { "Content-Type": "video/mp4" });
    res.end(Buffer.from("fake-mp4-data"));
    return;
  }
  if (req.method === "GET" && url.includes("/object_info")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      MiniMaxH3ImageToVideo: {},
      MiniMaxH3ReferenceToVideo: {},
      UNETLoader: { input: { required: { unet_name: [[
        "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
        "minimax_h3_ref2va_pruned_int8_convrot.safetensors"
      ]] } } },
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
await new Promise((r) => server.listen(18188, "127.0.0.1", r));

await withApp({}, async (cdp) => {
  // 配置本机后端指向 mock
  await cdp.eval(`document.querySelector('[data-page="connections"]').click()`);
  await new Promise(r => setTimeout(r, 300));
  await cdp.eval(`(() => {
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const card = Array.from(document.querySelectorAll('.connection-card')).find(c => c.textContent.includes('本机 ComfyUI'));
    const input = card.querySelector('input');
    s.call(input, 'http://127.0.0.1:18188');
    input.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await cdp.eval(`document.querySelector('.page-title .primary').click()`);
  await new Promise(r => setTimeout(r, 600));
  await cdp.eval(`(() => { const card = Array.from(document.querySelectorAll('.connection-card')).find(c => c.textContent.includes('本机 ComfyUI')); card.querySelector('button.secondary').click(); })()`);
  await new Promise(r => setTimeout(r, 1500));
  check("ComfyUI测试连接(模型就绪)", await cdp.eval(`(() => { const card = Array.from(document.querySelectorAll('.connection-card')).find(c => c.textContent.includes('本机 ComfyUI')); const r = card.querySelector('.test-result'); return r?.className.includes('ok') && r.textContent.includes('均已就绪'); })()`));
  await cdp.eval(`document.querySelector('[data-page="studio"]').click()`);
  await new Promise(r => setTimeout(r, 300));
  await cdp.eval(`(() => { const sel = Array.from(document.querySelectorAll('select')).find(s => Array.from(s.options).some(o => o.textContent === '1 路')); sel.value = '1'; sel.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  await cdp.eval(`document.querySelector('.submit-area .primary').click()`);
  await new Promise(r => setTimeout(r, 3000));
  check("任务创建并运行", await cdp.eval(`document.querySelector('.task-card.running, .task-card.validating, .task-card.succeeded') !== null`));
  await new Promise(r => setTimeout(r, 8000));
  check("任务成功+视频卡显示", await cdp.eval(`(() => { const card = document.querySelector('.task-card.succeeded'); return Boolean(card && card.querySelector('video')); })()`));
  check("任务进度100%", await cdp.eval(`(() => { const em = document.querySelector('.task-card.succeeded em'); return em?.textContent === '100%'; })()`));
  check("在文件夹按钮存在", await cdp.eval(`Boolean(document.querySelector('.task-card.succeeded .text-button'))`));
});

server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n=== 结果: ${results.length - failed.length}/${results.length} 通过 ===`);
process.exit(failed.length ? 1 : 0);
