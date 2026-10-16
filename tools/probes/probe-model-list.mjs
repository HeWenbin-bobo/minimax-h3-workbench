// 查上游模型列表里 dk- 与 deepseek 的关系（判断 dk-v4.1-flash 是不是 deepseek 别名）。
import { withApp } from "../../.e2e/driver.mjs";
import { cloneUserData } from "../harness.mjs";

const { dir } = await cloneUserData();
await withApp({ H3_USER_DATA: dir }, async (cdp) => {
  const models = JSON.parse(await cdp.eval(`(async () => {
    const r = await window.h3.listLlmModels();
    return JSON.stringify((r.data && r.data.models) || []);
  })()`));
  console.log(`模型总数：${models.length}`);
  const dk = models.filter((m) => /^dk-/.test(m));
  const ds = models.filter((m) => /deepseek/i.test(m));
  console.log(`\ndk- 开头的：${dk.join(", ") || "（无）"}`);
  console.log(`deepseek 系列：${ds.join(", ") || "（无）"}`);
  // 逐一比对：dk-X 是否都有对应的 deepseek-X
  console.log("\n配对检查（dk- 去掉前缀后是否存在于 deepseek 家族）：");
  for (const m of dk) {
    const tail = m.replace(/^dk-/, "");
    const hit = ds.find((d) => d.endsWith(tail) || d.includes(tail));
    console.log(`  ${m} → ${hit ? "对应 " + hit : "**无对应**"}`);
  }
});
