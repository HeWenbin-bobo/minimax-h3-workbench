// 上游 /models 通、但对话返回空 → 查配置里的模型名是否真在上游列表里。
// 顺带把相近候选打出来（便于确认该填哪个）。
import { withApp } from "../../.e2e/driver.mjs";
import { cloneUserData } from "../harness.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const { dir } = await cloneUserData();
const settings = JSON.parse(await readFile(path.join(dir, "settings.json"), "utf8"));
const configured = settings.llm.model;
console.log(`配置里的模型名：${configured}`);

await withApp({ H3_USER_DATA: dir }, async (cdp) => {
  const data = JSON.parse(await cdp.eval(`(async () => {
    const r = await window.h3.listLlmModels();
    return JSON.stringify({ ok: r.ok, models: (r.data && r.data.models) || [] });
  })()`));

  if (!data.ok || !data.models.length) { console.log("拿不到模型列表"); return; }

  const exact = data.models.includes(configured);
  console.log(`\n模型列表共 ${data.models.length} 个；配置名是否精确存在：${exact ? "是" : "**否**"}`);

  const key = String(configured).toLowerCase().replace(/[^a-z0-9]/g, "");
  const similar = data.models.filter((m) => {
    const k = String(m).toLowerCase().replace(/[^a-z0-9]/g, "");
    return k.includes(key.slice(0, 4)) || key.includes(k.slice(0, 4));
  }).slice(0, 20);
  console.log(`\n相近候选（前 20）：${similar.length ? similar.join(", ") : "（无）"}`);

  const hints = data.models.filter((m) => /flash|dk-|v4|deepseek/i.test(String(m))).slice(0, 25);
  console.log(`\n含 flash/dk/v4/deepseek 的模型（前 25）：${hints.length ? hints.join(", ") : "（无）"}`);
});
