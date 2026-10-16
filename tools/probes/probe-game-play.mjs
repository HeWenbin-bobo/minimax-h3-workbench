// 探针：预览面板里 HTML 游戏能不能"直接玩"（不先点一下 iframe）。
//
// 两个必须绕开的坑：
// ① iframe 是 sandbox="allow-scripts"（不透明源）→ 宿主**读不到** contentWindow 的任何属性。
//    初版探针就是栽在这（报 cross-origin 错，FAIL 不可信）。改用 postMessage 回报状态。
// ② memory 记着「CDP Input.dispatchKeyEvent 绕焦点路由」——CDP 发键直接投递给目标，
//    绕过真实焦点链，能"通过"而真人玩不了。所以另跑一路 OS 级 SendKeys（真键盘）。
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { withApp } from "../../.e2e/driver.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (label, ok, extra = "") => { if (!ok) failed += 1; console.log(`${ok ? "PASS" : "FAIL"} | ${label}${extra ? " | " + extra : ""}`); };

// 被测量的游戏：把「收到了哪些键」与「本 iframe 文档是否有焦点」用 postMessage 回报给宿主。
// postMessage 是跨源安全的唯一可靠通道（宿主读不到 contentWindow）。
const GAME = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#111;color:#0f0;font:16px monospace;display:grid;place-items:center}
#k{font-size:28px}
</style></head><body>
<div style="text-align:center">按键：<span id="k">（无）</span>
<div style="font-size:12px;color:#888;margin-top:8px">不点它，直接按方向键试试</div></div>
<script>
window.__keys = [];
function report() {
  parent.postMessage({ kind: "snake", keys: window.__keys.slice(), hasFocus: document.hasFocus() }, "*");
}
document.addEventListener("keydown", function (e) {
  window.__keys.push(e.key);
  document.getElementById("k").textContent = e.key;
  report();
});
// 周期性回报焦点状态：用来观察"面板打开后 iframe 文档到底有没有拿到焦点"。
setInterval(report, 250);
report();
</script></body></html>`;

// OS 级键盘：Windows 用 WScript.Shell.SendKeys（真键盘，走焦点路由）。
function sendRealKeys(keys) {
  const map = { ArrowLeft: "{LEFT}", ArrowRight: "{RIGHT}", ArrowUp: "{UP}", ArrowDown: "{DOWN}" };
  const body = ["Set s = CreateObject(\"WScript.Shell\")", ...keys.map((k) => `s.SendKeys "${map[k]}"`), "WScript.Sleep 200"].join("\r\n");
  const script = path.join(process.env.TEMP || ".", `h3-sendkeys-${Date.now()}.vbs`);
  writeFileSync(script, body, "utf8");
  execFileSync("cscript", ["//nologo", script], { stdio: "ignore" });
}

// 读宿主侧收集到的游戏回报（探针在宿主 window 上装监听）。
const readState = (cdp) => cdp.eval(`JSON.stringify({ keys: window.__snakeKeys || [], hasFocus: window.__snakeFocus })`);

await withApp({}, async (cdp) => {
  // 宿主侧监听：把游戏回报收进 window（跨源唯一通道）。
  await cdp.eval(`(() => {
    window.__snakeKeys = []; window.__snakeFocus = null;
    window.addEventListener("message", function (e) {
      if (e.data && e.data.kind === "snake") { window.__snakeKeys = e.data.keys; window.__snakeFocus = e.data.hasFocus; }
    });
    return true;
  })()`);

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
    window.__snakeKeys = []; window.__snakeFocus = null;
    window.addEventListener("message", function (e) {
      if (e.data && e.data.kind === "snake") { window.__snakeKeys = e.data.keys; window.__snakeFocus = e.data.hasFocus; }
    });
    return true;
  })()`);
  await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
  await sleep(500);

  check("产物卡片出现", await cdp.eval(`Boolean(document.querySelector('.pg-artifact-card'))`));

  // 记录"打开预览之前"宿主焦点在哪，便于对比
  const beforeFocus = await cdp.eval(`document.activeElement ? document.activeElement.tagName : "null"`);
  console.log(`      [诊断] 打开预览前宿主焦点：${beforeFocus}`);

  await cdp.eval(`document.querySelector('.pg-artifact-card button').click()`);
  await sleep(900);
  check("预览面板出现", await cdp.eval(`Boolean(document.querySelector('.pg-preview'))`));
  check("iframe 已挂载", await cdp.eval(`Boolean(document.querySelector('.pg-preview-frame'))`));

  const afterFocus = await cdp.eval(`document.activeElement ? document.activeElement.tagName + "." + (document.activeElement.className || "") : "null"`);
  const stateAfterOpen = JSON.parse(await readState(cdp));
  console.log(`      [诊断] 打开预览后宿主焦点：${afterFocus}`);
  console.log(`      [诊断] iframe 文档 hasFocus：${stateAfterOpen.hasFocus}`);

  // —— 通道 1：CDP 发键（绕焦点路由，仅对照）——
  for (const key of ["ArrowUp", "ArrowDown"]) {
    const vk = key === "ArrowUp" ? 38 : 40;
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key });
  }
  await sleep(400);
  const cdpState = JSON.parse(await readState(cdp));
  console.log(`      [对照] CDP 发键后 iframe 收到：${JSON.stringify(cdpState.keys)}`);

  // —— 通道 2：OS 级真键盘（走焦点路由 = 用户真实体验）——
  await cdp.eval(`(() => { window.__snakeKeys = []; return true; })()`);
  await cdp.send("Page.bringToFront").catch(() => {});
  await sleep(300);
  let sendOk = true;
  try { sendRealKeys(["ArrowLeft", "ArrowRight"]); } catch (error) { sendOk = false; console.log(`      [警告] SendKeys 不可用：${error.message}`); }
  await sleep(700);
  const realState = JSON.parse(await readState(cdp));
  if (sendOk) {
    check("OS 真键盘直达 iframe（不点也能玩）", realState.keys.includes("ArrowLeft") && realState.keys.includes("ArrowRight"), `iframe 收到 ${JSON.stringify(realState.keys)}`);
  } else {
    console.log("      [跳过] 真键盘通道不可用");
  }

  console.log("-".repeat(60));
  console.log(failed === 0 ? "=== 全部通过 ===" : `=== ${failed} 项失败 ===`);
});
if (failed > 0) process.exitCode = 1;
