// 复现：用户原话「生成一个鹈鹕骑自行车的 3D 页面，尽可能把你所有的能力全部都用上」
// 为什么模型会去生成 AI 视频（4 路），而不是做 3D 页面？
//
// 做法：用真实 userData（克隆）跑真实模型，**只记录它调了哪些工具**，
// 不打印密钥、不落盘用户数据。这是回答"为什么"的唯一可靠方式——读提示词只能推测。
import { withApp } from "../../.e2e/driver.mjs";
import { cloneUserData } from "../harness.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROMPT = "生成一个鹈鹕骑自行车的 3D 页面，尽可能把你所有的能力全部都用上";

const { dir, copied } = await cloneUserData();
console.log(`克隆 userData → ${dir}`);
console.log(`已复制：${copied.join(", ")}`);

await withApp({ H3_USER_DATA: dir }, async (cdp) => {
  // 抓上游请求：只看工具名，不打印请求体（含用户内容）
  const upstream = [];
  cdp.ws.addEventListener("message", (event) => {
    let msg = null;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.method === "Network.requestWillBeSent") {
      const req = msg.params && msg.params.request;
      if (req && typeof req.url === "string" && /chat\/completions|responses/.test(req.url)) {
        const names = [...String(req.postData || "").matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1]);
        upstream.push({ url: req.url.slice(0, 70), tools: [...new Set(names)] });
      }
    }
  });
  await cdp.send("Network.enable");

  for (let i = 0; i < 25; i++) {
    const ok = await cdp.eval(`(() => { const b = document.querySelector('[data-page="playground"]'); if (!b) return false; b.click(); return true; })()`);
    if (ok) break;
    await sleep(400);
  }
  await sleep(800);

  console.log(`界面显示模型：${await cdp.eval(`(document.querySelector('.pg-model') || {}).textContent || ""`)}`);

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

  // 等生成结束。注意：模型可能会调 request_user_input 并**挂起等回答**（默认 3 分钟超时），
  // 所以这里要主动跳过提问，否则探针会一直等到超时、拿不到完整结论。
  let steps = [];
  for (let i = 0; i < 180; i++) {
    steps = JSON.parse(await cdp.eval(`JSON.stringify([...document.querySelectorAll(".pg-tool-step")].map((e) => e.textContent || ""))`));
    // 有提问卡片就跳过（等价于用户"你自己决定"）
    const hasCard = await cdp.eval(`Boolean(document.querySelector(".pg-question-skip"))`);
    if (hasCard) {
      console.log("      [探针] 模型在提问，点「跳过」让它继续");
      await cdp.eval(`document.querySelector(".pg-question-skip").click()`);
      await sleep(800);
    }
    const streaming = await cdp.eval(`Boolean(document.querySelector(".pg-cursor"))`);
    const generating = await cdp.eval(`Boolean(document.querySelector(".pg-chip.stop"))`);
    if (!streaming && !generating && steps.length > 0) break;
    await sleep(1000);
  }

  const finalText = await cdp.eval(`(() => {
    const bubbles = [...document.querySelectorAll(".pg-msg.assistant .pg-bubble")];
    return bubbles.map((b) => b.textContent || "").join("\\n---\\n");
  })()`);

  console.log("\n=== 工具调用步骤（用户可见）===");
  for (const s of [...new Set(steps)]) console.log("  " + s);

  console.log("\n=== 模型最终回答（前 1500 字）===");
  console.log(finalText.slice(0, 1500));

  console.log("\n=== 上游请求里的工具名 ===");
  for (const u of upstream) console.log(`  ${u.url} → [${u.tools.join(", ")}]`);

  // 判据（本次回归的核心）：
  //  - 期望：出现 create_file（做 3D 页面）
  //  - 期望：**不出现** generate_video（没有额外建视频）
  const artifacts = await cdp.eval(`document.querySelectorAll('.pg-artifact-card').length`);
  const videoTasks = await cdp.eval(`document.querySelectorAll('.pg-task-grid .task-card').length`);
  const allSteps = [...new Set(steps)].join(" | ");
  const calledVideo = /generate_video/.test(allSteps) || videoTasks > 0;
  const calledCreateFile = /create_file/.test(allSteps) || artifacts > 0;

  console.log("\n=== 结果统计 ===");
  console.log(`  产物卡片（页面/表格/文档）：${artifacts}`);
  console.log(`  视频任务卡片：${videoTasks}`);
  // 新增：正文是否还残留大段文件内容（旧做法会把整个文件回灌进消息流）
  const bubbleLen = (finalText || "").length;
  const fenceCount = (finalText.match(/```/g) || []).length;
  console.log(`  助手气泡总长度：${bubbleLen} 字符；围栏标记数：${fenceCount}`);
  console.log(fenceCount === 0 ? "  PASS | 正文未回灌文件内容（无围栏代码块）" : "  FAIL | 正文仍含围栏代码块（内容被回灌）");

  console.log("\n=== 回归判定 ===");
  // 必须先确认"模型真的跑过"——否则"没建视频"可能只是"本轮压根没跑"，
  // 那是假绿（初版就踩了：中转返回空时 Video 那条仍显示 PASS）。
  const modelRan = steps.length > 0 || artifacts > 0 || videoTasks > 0;
  if (!modelRan) {
    console.log("  无法判定：本轮没有任何工具调用/产物 —— 模型可能没跑起来（中转不稳？）");
    console.log("  请先确认中转可用再复跑，不要把「没跑」当成「没建视频」。");
  } else {
    console.log(`  ${calledCreateFile ? "PASS" : "FAIL"} | 是否产出文件（create_file / 产物卡片）`);
    console.log(`  ${calledVideo ? "FAIL" : "PASS"} | 是否**没有**额外生成视频`);
  }
  console.log(`  工具步骤全集：${allSteps || "（无）"}`);
});
