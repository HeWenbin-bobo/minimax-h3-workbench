// 用用户原话做回归，**自动重试直到成功**（用户要求："直到能够成功为止"）。
//
// 为什么要重试：该中转对带 tools 的请求存在间歇性空响应（CLAUDE.md 记录其抖动窗口
// 可持续十几秒，背靠背重试会全撞进同一个窗口）。单次失败不能判定提示词改动。
//
// 判据（成功 = 模型真的跑起来了）：出现任何工具调用步骤，或产出产物/任务卡片。
// 成功后再看：是否调了 create_file（期望）、是否调了 generate_video（不期望）。
import { withApp } from "../../.e2e/driver.mjs";
import { cloneUserData } from "../harness.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROMPT = "生成一个鹈鹕骑自行车的 3D 页面，尽可能把你所有的能力全部都用上";
const MAX_ATTEMPTS = 8;

const { dir } = await cloneUserData();
console.log(`克隆 userData → ${dir}`);

async function attempt(cdp, n) {
  console.log(`\n${"=".repeat(60)}\n第 ${n} 轮尝试\n${"=".repeat(60)}`);

  await cdp.eval(`(() => { const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "新对话"); if (b) b.click(); return true; })()`);
  await sleep(600);

  await cdp.eval(`(() => {
    const chips = [...document.querySelectorAll(".pg-chip")];
    const agent = chips.find((c) => (c.title || "").includes("智能体"));
    if (agent && !agent.className.includes("on")) agent.click();
    return true;
  })()`);
  await sleep(300);

  await cdp.eval(`(() => {
    const ta = document.querySelector(".pg-input-row textarea");
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    set.call(ta, ${JSON.stringify(PROMPT)});
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  await cdp.eval(`document.querySelector(".pg-input-row .primary").click()`);

  let steps = [];
  for (let i = 0; i < 150; i++) {
    steps = JSON.parse(await cdp.eval(`JSON.stringify([...document.querySelectorAll(".pg-tool-step")].map((e) => e.textContent || ""))`));
    // 模型提问 → 替用户跳过（"你自己决定"），否则会挂到超时
    if (await cdp.eval(`Boolean(document.querySelector(".pg-question-skip"))`)) {
      console.log("  [探针] 模型在提问，点「跳过」");
      await cdp.eval(`document.querySelector(".pg-question-skip").click()`);
      await sleep(800);
      continue;
    }
    const busy = await cdp.eval(`Boolean(document.querySelector(".pg-chip.stop"))`);
    if (!busy && steps.length > 0) break;
    if (!busy && i > 6) {
      const t = await cdp.eval(`(() => [...document.querySelectorAll(".pg-msg.assistant .pg-bubble")].map((b) => b.textContent || "").join(" "))()`);
      if (/服务商未返回任何内容|不支持工具调用|请求失败/.test(t)) break;
    }
    await sleep(1000);
  }

  const result = {
    steps,
    artifacts: await cdp.eval(`document.querySelectorAll(".pg-artifact-card").length`),
    videoTasks: await cdp.eval(`document.querySelectorAll(".pg-task-grid .task-card").length`),
    text: await cdp.eval(`(() => [...document.querySelectorAll(".pg-msg.assistant .pg-bubble")].map((b) => b.textContent || "").join("\\n---\\n"))()`)
  };
  result.ran = result.steps.length > 0 || result.artifacts > 0 || result.videoTasks > 0;
  return result;
}

await withApp({ H3_USER_DATA: dir }, async (cdp) => {
  for (let i = 0; i < 25; i++) {
    const ok = await cdp.eval(`(() => { const b = document.querySelector('[data-page="playground"]'); if (!b) return false; b.click(); return true; })()`);
    if (ok) break;
    await sleep(400);
  }
  await sleep(1000);
  console.log(`界面显示模型：${await cdp.eval(`(document.querySelector('.pg-model') || {}).textContent || ""`)}`);

  let last = null;
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    try {
      last = await attempt(cdp, n);
    } catch (e) {
      console.log(`  本轮异常：${String(e).slice(0, 150)}`);
      await sleep(5000);
      continue;
    }
    if (last.ran) { console.log(`\n  OK 第 ${n} 轮模型跑起来了`); break; }
    console.log(`  第 ${n} 轮未跑起来，等 20 秒重试`);
    if (last.text.trim()) console.log(`     界面显示：${last.text.slice(0, 120)}`);
    await sleep(20_000);
  }

  console.log(`\n${"=".repeat(60)}\n最终结果\n${"=".repeat(60)}`);
  if (!last || !last.ran) {
    console.log("  重试全部失败：模型始终未跑起来，**回归结论无效**（不能算作「没建视频」）。");
    process.exitCode = 1;
    return;
  }

  const allSteps = [...new Set(last.steps)].join(" | ");
  const calledCreateFile = /create_file/.test(allSteps) || last.artifacts > 0;
  const calledVideo = /generate_video/.test(allSteps) || last.videoTasks > 0;

  console.log(`  工具步骤：${allSteps || "（无）"}`);
  console.log(`  产物卡片：${last.artifacts}   视频任务卡片：${last.videoTasks}`);
  console.log(`\n  模型回答（前 500 字）：\n  ${last.text.slice(0, 500).replace(/\n/g, "\n  ")}`);
  console.log(`\n  ${calledCreateFile ? "PASS" : "FAIL"} | 产出了文件（create_file / 产物卡片）`);
  console.log(`  ${calledVideo ? "FAIL" : "PASS"} | 没有额外生成视频`);
  console.log("");
  console.log(calledCreateFile && !calledVideo
    ? "  → 回归通过：认准了 3D 页面这个产出物，没有额外补视频。"
    : "  → 回归未通过（或未完全通过），见上面明细。");
  if (!(calledCreateFile && !calledVideo)) process.exitCode = 1;
});
