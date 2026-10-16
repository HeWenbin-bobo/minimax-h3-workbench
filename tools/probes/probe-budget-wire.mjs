// 验证新 section 的接线：main.ts 里算出的余量数字是否 sane（非 NaN/负数/0 上限）。
// 用应用自己的 llm:context-status（同一份 activeContextTokens + contextWindowFor 记账），
// 因为主进程的网络请求 CDP 看不到，不能直接读 system prompt。
import { withApp } from "../../.e2e/driver.mjs";
import { cloneUserData } from "../harness.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { dir } = await cloneUserData();

await withApp({ H3_USER_DATA: dir }, async (cdp) => {
  for (let i = 0; i < 25; i++) {
    const ok = await cdp.eval(`(() => { const b = document.querySelector('[data-page="playground"]'); if (!b) return false; b.click(); return true; })()`);
    if (ok) break;
    await sleep(400);
  }
  await sleep(900);

  const model = await cdp.eval(`(document.querySelector('.pg-model') || {}).textContent || ""`);
  console.log("模型：" + model);

  // 造一段较长历史，让余量不是"充裕"档
  const history = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "测试内容".repeat(200) }));
  const status = JSON.parse(await cdp.eval(`(async () => {
    const r = await window.h3.getContextStatus(${JSON.stringify(history)}, "probe-budget");
    return JSON.stringify(r.data || r);
  })()`));
  console.log("context-status:", JSON.stringify(status));

  const { activeTokens, modelLimitTokens, percent } = status;
  const remaining = modelLimitTokens - activeTokens;
  console.log(`\n推导余量：active=${activeTokens} limit=${modelLimitTokens} → 剩余 ${remaining}（${Math.round(remaining / modelLimitTokens * 100)}%）`);

  const sane = Number.isFinite(activeTokens) && activeTokens > 0
    && Number.isFinite(modelLimitTokens) && modelLimitTokens > 0
    && remaining >= 0;
  console.log(sane ? "PASS | 记账数字 sane（余量可算出、非负、上限有效）" : "FAIL | 数字异常");
  console.log(Number.isFinite(percent) ? `PASS | percent 有效：${percent}%` : "FAIL | percent 异常");
});
