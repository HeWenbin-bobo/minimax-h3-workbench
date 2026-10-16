// 判别测试：真键盘打进来后，是**宿主页**收到还是**iframe 内游戏**收到？
//   - 宿主收到、游戏没收到 → 应用真有键盘路由 bug（键进了窗口但没进 iframe）
//   - 两者都没收到         → 探针没能把窗口拉到前台（SendKeys 打到别处），结论不成立
// 目的是避免把"探针打偏了"误判成"应用有 bug"。
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { withApp } from "../../.e2e/driver.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GAME = `<!DOCTYPE html><html><body><div id="k">—</div>
<script>
window.__keys = [];
function report() { parent.postMessage({ kind: "snake", keys: window.__keys.slice(), focus: document.hasFocus() }, "*"); }
document.addEventListener("keydown", function (e) { window.__keys.push(e.key); report(); });
setInterval(report, 200); report();
</script></body></html>`;

function foregroundAndSend(pid, keys) {
  const dir = process.env.TEMP || ".";
  const ps = path.join(dir, `h3-fg-${Date.now()}.ps1`);
  writeFileSync(ps, [
    "Add-Type -Namespace W -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);'",
    "Add-Type -Namespace W -Name U2 -MemberDefinition '[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();'",
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    "if ($p -and $p.MainWindowHandle -ne 0) { [W.U]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; Start-Sleep -Milliseconds 600 }",
    "$fg = [W.U2]::GetForegroundWindow()",
    "'foregroundMatchesTarget=' + ($fg -eq $p.MainWindowHandle)"
  ].join("\r\n"), "utf8");
  const out = execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps], { stdio: "pipe" }).toString().trim();
  console.log(`      [前台检测] ${out}`);

  const vbs = path.join(dir, `h3-keys2-${Date.now()}.vbs`);
  const map = { ArrowLeft: "{LEFT}", ArrowRight: "{RIGHT}" };
  writeFileSync(vbs, ["Set s = CreateObject(\"WScript.Shell\")", ...keys.map((k) => `s.SendKeys "${map[k]}"`), "WScript.Sleep 400"].join("\r\n"), "utf8");
  execFileSync("cscript", ["//nologo", vbs], { stdio: "ignore" });
}

await withApp({}, async (cdp, child) => {
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
  // 宿主侧监听（关键）：区分"键到窗口"与"键到 iframe"
  await cdp.eval(`(() => {
    window.__hostKeys = []; window.__snakeKeys = []; window.__snakeFocus = null; window.__msgs = 0;
    document.addEventListener("keydown", (e) => { window.__hostKeys.push("HOST:" + e.key); });
    window.addEventListener("message", (e) => {
      if (e.data && e.data.kind === "snake") { window.__msgs++; window.__snakeKeys = e.data.keys; window.__snakeFocus = e.data.focus; }
    });
    return true;
  })()`);
  await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
  await sleep(500);
  await cdp.eval(`document.querySelector('.pg-artifact-card button').click()`);
  await sleep(1200);

  const before = JSON.parse(await cdp.eval(`JSON.stringify({ msgs: window.__msgs, gameKeys: window.__snakeKeys, hostKeys: window.__hostKeys, focus: window.__snakeFocus })`));
  console.log(`      打开预览：游戏脚本 ${before.msgs} 次回报，iframe hasFocus=${before.focus}`);

  try { foregroundAndSend(child.pid, ["ArrowLeft", "ArrowRight"]); }
  catch (e) { console.log(`      SendKeys 失败：${e.message}`); }
  await sleep(1000);

  const after = JSON.parse(await cdp.eval(`JSON.stringify({ gameKeys: window.__snakeKeys, hostKeys: window.__hostKeys })`));
  const newGameKeys = after.gameKeys.slice(before.gameKeys.length);
  const newHostKeys = after.hostKeys.slice(before.hostKeys.length);
  console.log("--- 真键盘结果 ---");
  console.log(`  宿主页收到：${JSON.stringify(newHostKeys)}`);
  console.log(`  iframe 游戏收到：${JSON.stringify(newGameKeys)}`);
  console.log("-".repeat(60));
  if (newGameKeys.length > 0) console.log("结论：真键盘直达游戏 → 完全可以不点就直接玩");
  else if (newHostKeys.length > 0) console.log("结论：宿主收到但游戏没收到 → **应用存在键盘路由问题**（键进了窗口，没进 iframe）");
  else console.log("结论：两者都没收到 → 探针没能把窗口拉到前台（SendKeys 打到别处），本次结论不成立");
});
