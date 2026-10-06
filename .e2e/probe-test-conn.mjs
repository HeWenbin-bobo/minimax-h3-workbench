import { createServer } from "node:http";
import { withApp } from "./driver.mjs";

const server = createServer((req, res) => {
  const url = req.url || "";
  if (req.method === "GET" && url.includes("/object_info")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      MiniMaxH3ImageToVideo: {},
      MiniMaxH3ReferenceToVideo: {},
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
await new Promise((r) => server.listen(18188, "127.0.0.1", r));

await withApp({}, async (cdp) => {
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
  await cdp.eval(`(() => { const card = Array.from(document.querySelectorAll('.connection-card')).find(c => c.textContent.includes('本机 ComyuUI')) || Array.from(document.querySelectorAll('.connection-card')).find(c => c.textContent.includes('本机 ComfyUI')); card.querySelector('button.secondary').click(); })()`);
  await new Promise(r => setTimeout(r, 2000));
  console.log("test-result:", await cdp.eval(`document.querySelector('.test-result')?.textContent`));
});
server.close();
