// 判定：上游/密钥问题，还是我们构造的请求问题？
// 手法：用应用自带的两个直连 IPC——
//   listLlmModels()：GET /models（不发对话）
//   testLlm()      ：拉模型列表，不通则回落发一条**最小对话**（不带 tools）
// 两个都不通 → 上游侧问题；有任一个通 → 问题在 playground 的请求路径上。
import { withApp } from "../../.e2e/driver.mjs";
import { cloneUserData } from "../harness.mjs";

const { dir } = await cloneUserData();

await withApp({ H3_USER_DATA: dir }, async (cdp) => {
  console.log("=== 1. listLlmModels（GET /models）===");
  const models = JSON.parse(await cdp.eval(`(async () => {
    try {
      const r = await window.h3.listLlmModels();
      return JSON.stringify({ ok: r.ok, message: (r.message || "").slice(0, 200), count: (r.data && r.data.models || []).length, innerOk: r.data && r.data.ok });
    } catch (e) { return JSON.stringify({ err: String(e).slice(0, 200) }); }
  })()`));
  console.log("  " + JSON.stringify(models));

  console.log("\n=== 2. testLlm（拉列表，不通则发最小对话）===");
  const test = JSON.parse(await cdp.eval(`(async () => {
    try {
      const r = await window.h3.testLlm();
      return JSON.stringify({ ok: r.ok, latencyMs: r.data && r.data.latencyMs, message: (r.message || "").slice(0, 300) });
    } catch (e) { return JSON.stringify({ err: String(e).slice(0, 200) }); }
  })()`));
  console.log("  " + JSON.stringify(test));

  const reachable = Boolean(models.innerOk) || Boolean(test.ok);
  console.log("\n=== 判定 ===");
  console.log(reachable
    ? "  上游可达（至少一个直连 IPC 成功）→ 若 playground 仍返回空，问题在 playground 请求路径上。"
    : "  两个直连 IPC 都失败 → 上游/密钥/中转侧问题，不是我们构造的请求有问题。");
});
