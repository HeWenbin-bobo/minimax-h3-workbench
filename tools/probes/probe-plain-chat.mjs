// 判别：中转整体不通，还是「带 tools 的请求」被拒？
// 手法：同一个模型、同一句话，把「智能体」关掉（走不带 tools 的普通对话）跑一次。
//   普通对话能回 → 中转活着，问题出在 tools 请求上（我改的提示词是否有责需另判）
//   普通对话也不回 → 中转此刻整体不稳，无法据此判定提示词改动
import { withApp } from "../../.e2e/driver.mjs";
import { cloneUserData } from "../harness.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROMPT = "生成一个鹈鹕骑自行车的 3D 页面，尽可能把你所有的能力全部都用上";

const { dir } = await cloneUserData();

await withApp({ H3_USER_DATA: dir }, async (cdp) => {
  for (let i = 0; i < 25; i++) {
    const ok = await cdp.eval(`(() => { const b = document.querySelector('[data-page="playground"]'); if (!b) return false; b.click(); return true; })()`);
    if (ok) break;
    await sleep(400);
  }
  await sleep(800);

  // 关掉智能体 → 普通对话（不带 tools）
  const chipState = await cdp.eval(`(() => {
    const chips = [...document.querySelectorAll(".pg-chip")];
    const agent = chips.find((c) => (c.title || "").includes("智能体"));
    const was = agent ? agent.className.includes("on") : null;
    if (agent && was) agent.click();
    return JSON.stringify({ found: Boolean(agent), wasOn: was });
  })()`);
  console.log(`智能体 chip：${chipState}`);
  await sleep(500);

  await cdp.eval(`(() => {
    const ta = document.querySelector(".pg-input-row textarea");
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    set.call(ta, ${JSON.stringify(PROMPT)});
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  await cdp.eval(`document.querySelector(".pg-input-row .primary").click()`);

  let text = "";
  for (let i = 0; i < 60; i++) {
    text = await cdp.eval(`(() => {
      const bubbles = [...document.querySelectorAll(".pg-msg.assistant .pg-bubble")];
      return bubbles.map((b) => b.textContent || "").join("\\n---\\n");
    })()`);
    const generating = await cdp.eval(`Boolean(document.querySelector(".pg-chip.stop"))`);
    if (!generating && text.trim()) break;
    await sleep(1000);
  }

  console.log("\n=== 普通对话（不带 tools）的回复（前 400 字）===");
  console.log(text.slice(0, 400) || "（空）");

  // 判据要覆盖"空回复"这一支：初版只测错误文案，空文本被误判成成功（假绿）。
  const body = text.trim();
  const hasError = /请求失败|服务商未返回任何内容|上游未返回任何内容/.test(body);
  const isUsable = body.length > 0 && !hasError;
  console.log("\n=== 判别 ===");
  if (isUsable) {
    console.log("普通对话成功 → 中转活着；问题集中在「带 tools 的请求」上");
  } else if (hasError) {
    console.log("普通对话报错 → 中转此刻不稳，无法据此判定提示词改动");
  } else {
    console.log("普通对话返回空 → 中转此刻不稳（既无内容也无明确报错），无法据此判定提示词改动");
  }
});
