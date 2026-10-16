// 对照探针：验证测量通道本身是否可靠 + 定位焦点断在哪一环。
//
// 逻辑：如果"点进 iframe 内部"之后键能到达游戏（用户手动绕开的正是这一步），
// 那么 postMessage 测量通道有效，之前"不点收不到键"的判定就成立。
// 反之若点了也收不到，说明测量通道坏了，不能据此下结论。
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { withApp } from "../../.e2e/driver.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GAME = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#111;color:#0f0;font:16px monospace}
#pad{padding:20px}</style></head><body><div id="pad">按方向键</div>
<script>
window.__keys = [];
function report() { parent.postMessage({ kind: "snake", keys: window.__keys.slice(), hasFocus: document.hasFocus() }, "*"); }
document.addEventListener("keydown", function (e) { window.__keys.push(e.key); report(); });
setInterval(report, 200); report();
</script></body></html>`;

function sendRealKeys(keys) {
  const map = { ArrowLeft: "{LEFT}", ArrowRight: "{RIGHT}", ArrowUp: "{UP}", ArrowDown: "{DOWN}" };
  const body = ["Set s = CreateObject(\"WScript.Shell\")", ...keys.map((k) => `s.SendKeys "${map[k]}"`), "WScript.Sleep 200"].join("\r\n");
  const script = path.join(process.env.TEMP || ".", `h3-ctrl-${Date.now()}.vbs`);
  writeFileSync(script, body, "utf8");
  execFileSync("cscript", ["//nologo", script], { stdio: "ignore" });
}

await withApp({}, async (cdp) => {
  await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
  await sleep(400);
  const escaped = JSON.stringify(GAME);
  await cdp.eval(`(() => {
    const key = Object.keys(localStorage).find(k => k.includes("sessions")) || "h3-playground-sessions";
    const now = new Date().toISOString();
    localStorage.setItem(key, JSON.stringify([{ id: "s-snake", title: "贪吃蛇", createdAt: now, updatedAt: now, messages: [
      { id: "m1", role: "user", content: "写个贪吃蛇" },
      { id: "m2", role: "assistant", content: "好的：\\n\\n\\\`\\\`\\\`html\\n" + ${escaped} + "\\n\\\`\\\`\\\`" }
    ]}]));
    location.reload();
  })()`);
  await sleep(1800);
  await cdp.eval(`(() => {
    window.__snakeKeys = []; window.__snakeFocus = null; window.__msgCount = 0;
    window.addEventListener("message", function (e) {
      if (e.data && e.data.kind === "snake") { window.__msgCount++; window.__snakeKeys = e.data.keys; window.__snakeFocus = e.data.hasFocus; }
    });
    return true;
  })()`);
  await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
  await sleep(500);
  await cdp.eval(`document.querySelector('.pg-artifact-card button').click()`);
  await sleep(900);

  const state = async () => JSON.parse(await cdp.eval(`JSON.stringify({ keys: window.__snakeKeys, focus: window.__snakeFocus, msgs: window.__msgCount })`));

  console.log("=== 阶段 0：刚打开预览（未点击）===");
  const s0 = await state();
  console.log(`  收到 postMessage 次数：${s0.msgs}  iframe 文档 hasFocus：${s0.focus}  keys：${JSON.stringify(s0.keys)}`);
  console.log(`  → 通道${s0.msgs > 0 ? "有效（游戏脚本在跑）" : "无效（游戏脚本没跑，后续判定不可信）"}`);

  console.log("=== 阶段 1：不点击，直接发 OS 真键盘 ===");
  await cdp.eval(`(() => { window.__snakeKeys = []; return true; })()`);
  await cdp.send("Page.bringToFront").catch(() => {});
  await sleep(200);
  try { sendRealKeys(["ArrowLeft"]); } catch (e) { console.log(`  SendKeys 失败：${e.message}`); }
  await sleep(600);
  const s1 = await state();
  console.log(`  iframe 收到 keys：${JSON.stringify(s1.keys)}  hasFocus：${s1.focus}`);

  console.log("=== 阶段 2：先点进 iframe 内部，再发同一组键 ===");
  const rect = await cdp.eval(`(() => { const r = document.querySelector('.pg-preview-frame').getBoundingClientRect(); return JSON.stringify({x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)}); })()`);
  const { x, y } = JSON.parse(rect);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await sleep(400);
  await cdp.eval(`(() => { window.__snakeKeys = []; return true; })()`);
  try { sendRealKeys(["ArrowRight"]); } catch (e) { console.log(`  SendKeys 失败：${e.message}`); }
  await sleep(600);
  const s2 = await state();
  console.log(`  iframe 收到 keys：${JSON.stringify(s2.keys)}  hasFocus：${s2.focus}`);

  console.log("-".repeat(60));
  console.log(`结论：通道${s0.msgs > 0 ? "有效" : "无效"}；不点收不到键=${s1.keys.length === 0}；点进去后能收到键=${s2.keys.length > 0}`);
});
