// 真机验证：OS 级物理键盘能否直达预览 iframe 里的游戏（用户真实体验）。
//
// 必须绕开的两个坑：
// ① CDP Input.dispatchKeyEvent 绕焦点路由（memory 记录）→ 不能用来验证"键进了沙箱"。
// ② WScript.Shell.SendKeys 打的是系统**前台窗口**；探针 spawn 的 Electron 若不在前台，
//    键就打到终端去了 → 假失败。故先把窗口 SetForegroundWindow 再发键。
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { withApp } from "../../.e2e/driver.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (label, ok, extra = "") => { if (!ok) failed += 1; console.log(`${ok ? "PASS" : "FAIL"} | ${label}${extra ? " | " + extra : ""}`); };

// 独立的贪吃蛇：记录按键并周期性 postMessage 回报（含 iframe 文档是否持有焦点）。
const GAME = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#0b1020;color:#7CFC00;font:14px monospace;display:grid;place-items:center}
</style></head><body><div style="text-align:center">贪吃蛇
<div id="k" style="font-size:32px;margin-top:8px">—</div>
<div style="color:#456;font-size:12px;margin-top:6px">不点它，直接按方向键</div></div>
<script>
window.__keys = [];
function report() { parent.postMessage({ kind: "snake", keys: window.__keys.slice(), focus: document.hasFocus() }, "*"); }
document.addEventListener("keydown", function (e) { window.__keys.push(e.key); document.getElementById("k").textContent = e.key; report(); });
setInterval(report, 200); report();
</script></body></html>`;

// 先把目标窗口拉到前台，再用 WScript.Shell 发真键盘。
function bringToFrontAndSend(pid, keys) {
  const dir = process.env.TEMP || ".";
  const ps = path.join(dir, `h3-front-${Date.now()}.ps1`);
  writeFileSync(ps, [
    "Add-Type -Namespace W -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);'",
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    "if ($p -and $p.MainWindowHandle -ne 0) { [W.U]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; Start-Sleep -Milliseconds 500 }"
  ].join("\r\n"), "utf8");
  execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps], { stdio: "pipe" });

  const vbs = path.join(dir, `h3-keys-${Date.now()}.vbs`);
  const map = { ArrowLeft: "{LEFT}", ArrowRight: "{RIGHT}", ArrowUp: "{UP}", ArrowDown: "{DOWN}" };
  writeFileSync(vbs, ["Set s = CreateObject(\"WScript.Shell\")", ...keys.map((k) => `s.SendKeys "${map[k]}"`), "WScript.Sleep 400"].join("\r\n"), "utf8");
  execFileSync("cscript", ["//nologo", vbs], { stdio: "ignore" });
}

await withApp({}, async (cdp, child) => {
  console.log(`      Electron 主进程 PID：${child.pid}`);
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
    window.__snakeKeys = []; window.__snakeFocus = null; window.__msgs = 0;
    window.addEventListener("message", (e) => {
      if (e.data && e.data.kind === "snake") { window.__msgs++; window.__snakeKeys = e.data.keys; window.__snakeFocus = e.data.focus; }
    });
    return true;
  })()`);
  await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
  await sleep(500);

  await cdp.eval(`document.querySelector('.pg-artifact-card button').click()`);
  await sleep(1200);

  const opened = JSON.parse(await cdp.eval(`JSON.stringify({ msgs: window.__msgs, focus: window.__snakeFocus, keys: window.__snakeKeys })`));
  check("游戏脚本在跑（否则一切免谈）", opened.msgs > 0, `postMessage ${opened.msgs} 次`);
  check("iframe 文档已获焦点（打开预览即自动聚焦）", opened.focus === true, `hasFocus=${opened.focus}`);

  // 真键盘：先拉前台再发键。不重置游戏内部 __keys（它才是权威），只记发送前长度。
  const beforeLen = opened.keys.length;
  try {
    bringToFrontAndSend(child.pid, ["ArrowLeft", "ArrowRight"]);
  } catch (error) {
    console.log(`      [警告] 前台/SendKeys 失败：${error.message}`);
  }
  await sleep(900);
  const after = JSON.parse(await cdp.eval(`JSON.stringify({ focus: window.__snakeFocus, keys: window.__snakeKeys })`));
  const gained = after.keys.slice(beforeLen);
  check("OS 真键盘直达 iframe（不点也能玩）", gained.includes("ArrowLeft") && gained.includes("ArrowRight"), `新增按键 ${JSON.stringify(gained)}`);

  console.log("-".repeat(60));
  console.log(failed === 0 ? "=== 全部通过 ===" : `=== ${failed} 项失败 ===`);
});
if (failed > 0) process.exitCode = 1;
