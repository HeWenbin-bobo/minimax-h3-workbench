import { createHash } from "node:crypto";
import path from "node:path";

/**
 * 产物落盘的会话目录名。**落盘与清理必须共用这一处**，否则两边算出的目录不一致，
 * 清理会漏（或误删别的会话）。
 *
 * sessionId 来自渲染端（可构造）。只取 `basename` 不够：`path.basename("..")` 仍返回
 * ".."，join 后会把产物目录**抬到 userData 根**（实测复现）。这里再把危险字符与
 * 纯点段滤掉，保证落点始终在 artifacts 之下。
 *
 * **只做"滤掉危险字符"会产生目录名碰撞**（实测）：
 * - Windows 上 `path.basename("x:y")` 返回 `"y"`（冒号前被当成盘符），
 *   于是 `sessionId = "x:<别人的会话 id>"` 会落到**对方**的产物目录；
 * - `"a|b"` 与 `"a_b"` 都变成 `"a_b"`；`"sub/dir"` 与 `"dir"` 都变成 `"dir"`。
 * 配上 `artifact:purgeSession`（删除会话时清目录），构造一个 id 就能**删掉另一个
 * 会话的产物**——不可逆。
 *
 * 修复方式：**只要净化过程真的改动了原值，就追加原值的短哈希**，
 * 让不同输入必然得到不同目录名。正常 id（UUID / 纯字母数字）不被改动，
 * 目录名保持不变，已有的历史产物不会失联。
 */
export function artifactSessionDirName(sessionId: string): string {
  const raw = String(sessionId ?? "");
  const base = path.basename(raw || "unknown").replace(/[\\/:*?"<>|]/g, "_").trim();
  const safe = !base || /^\.+$/.test(base) ? "unknown" : base;
  // 净化没有改动原值 → 直接用（保持向后兼容，UUID 就是这样）。
  if (safe === raw) return safe;
  // 被改动过 → 追加原值的短哈希，消除碰撞。
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 12);
  return `${safe}-${digest}`;
}

/** 去掉末尾的 ` (数字)` 版本后缀：`报告 (2).html` → `报告.html`。与渲染端折叠规则一致。 */
function versionStem(fileName: string): string {
  const ext = path.extname(fileName);
  return fileName.slice(0, fileName.length - ext.length).replace(/ \(\d+\)$/, "");
}

/**
 * 在一批文件名里找出与 `fileName` **同一主名的最新版本**（`报告.html` → `报告 (3).html`）。
 * 找不到返回 undefined。
 *
 * 为什么需要（实测真机）：模型修完 bug 会重新 `create_file` 同名文件，而 `uniqueArtifactPath`
 * 不覆盖，于是落成 `名字 (2).html`；它接着自检时往往还传原名。按精确匹配就会**跑旧版本**，
 * 然后回一句"自检通过"——模型据此告诉用户"已验证"，用户点开的却仍是带 bug 的上一版。
 *
 * **版本号必须按数字比**：字符串比较会把 `(10)` 判成比 `(9)` 小，于是永远选到第 9 版。
 * 没有后缀的算第 1 版。
 */
export function pickLatestVersion(entries: readonly string[], fileName: string): string | undefined {
  const ext = path.extname(fileName);
  const stem = versionStem(fileName);
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped}(?: \\((\\d+)\\))?$`);
  let best: { name: string; version: number } | undefined;
  for (const entry of entries) {
    const entryExt = path.extname(entry);
    // 扩展名大小写不敏感（Windows 上 `.HTML` 与 `.html` 是同一个文件）。
    if (entryExt.toLowerCase() !== ext.toLowerCase()) continue;
    const match = pattern.exec(entry.slice(0, entry.length - entryExt.length));
    if (!match) continue;
    const version = match[1] ? Number(match[1]) : 1;
    if (!best || version > best.version) best = { name: entry, version };
  }
  return best?.name;
}

/**
 * 请求名 → 依次尝试的候选文件名。
 *
 * 背景（实测工具契约不一致）：`create_file` 的参数说明是"文件名，**不含**扩展名"，
 * 而 `read_artifact` / `edit_artifact` 说明是"带扩展名"。模型按前者的写法调用后者时
 * （`read_artifact("科技新闻")`），精确匹配与同主名回落都按**空扩展名**比对 →
 * 必然找不到 → 报"本会话里找不到产物"。文件明明在磁盘上，模型只会重新生成一份重复产物。
 *
 * 规则：**有扩展名就只试它**（尊重模型明确指定的类型）；
 * 没有扩展名才按已知产物类型依次补全。
 *
 * **例外：csv/tsv 要顺带试 .xlsx**（实测死路）。`create_file` 把表格统一落成 `.xlsx`
 * （`kind===csv` 在工具层就被改写成 `xlsx`，`saveArtifactFile` 还会把名字里的 `.csv` 剥掉），
 * 于是模型说"做个 data.csv"、`read_artifact("data.csv")` 时，按"有扩展名只试它"去找
 * `data.csv` ——**这个文件从来不存在**，可 `data.xlsx` 就躺在目录里。
 * 模型收到的是一句"本会话里找不到产物"，只能重新生成一份重复的。
 */
export function artifactNameCandidates(requestedName: string): string[] {
  const name = String(requestedName ?? "").trim();
  if (!name) return [];
  // **只认已知产物扩展名**，不能用 `path.extname` 非空就判定"已有扩展名"：
  // `path.extname("v1.2 报告")` 返回 `".2 报告"`——名字里有点但并没有产物扩展名，
  // 那种情况仍然必须补全（单测「v1.2 报告」抓到的）。
  const ext = path.extname(name).toLowerCase();
  if ((KNOWN_ARTIFACT_EXTS as readonly string[]).includes(ext)) {
    if (SHEET_ALIAS_EXTS.includes(ext as (typeof SHEET_ALIAS_EXTS)[number])) {
      return [name, `${name.slice(0, name.length - ext.length)}.xlsx`];
    }
    return [name];
  }
  return [name, ...KNOWN_ARTIFACT_EXTS.map((known) => `${name}${known}`)];
}

/** 在磁盘上永远成对出现的表格扩展名：请求其中任何一个，都要顺带找另一个。 */
export const SHEET_REQUEST_EXTS = [".csv", ".tsv"] as const;
const SHEET_ALIAS_EXTS = SHEET_REQUEST_EXTS;

/**
 * 名字回落的成因 → 给模型/用户看的中文说明。四种成因（`requested` / `ext` / `alias` /
 * `stale` / `missing`）各自**不能混用措辞**，否则模型会对一个明明存在的文件重新生成一份。
 *
 * 抽成纯函数的原因（实测踩到）：这段判定原先在 4 个地方各写了一遍
 * （inspect / read / edit / batch），加"csv 顺带找 xlsx"时它们不会一起改——
 * 结果 `.csv` 请求会落进 `ext` 分支，回一句"你写的「data.csv」没带扩展名"，
 * 可它明明带着扩展名，只是磁盘上的扩展名被改成了 .xlsx。模型看到这句只会去查扩展名。
 *
 * @param requested 模型点名的那份（原样）
 * @param actual    实际读/改/自检的那份
 */
export function describeArtifactFallback(
  fellBack: false | "missing" | "stale" | "ext" | "alias",
  requested: string,
  actual: string,
  action: "read" | "edit" | "inspect"
): string {
  // 动词按调用方区分：读/改/检查说同一件事，但用户看到的是不同动作。
  const verb = action === "edit" ? "实际改的是" : action === "inspect" ? "上面检查的是" : "实际读的是";
  switch (fellBack) {
    case "stale":
      return action === "inspect"
        ? `（你给的「${requested}」已被更新的版本取代，上面检查的是「${actual}」。）`
        : `（你点名的「${requested}」已被更新的版本取代，${verb}「${actual}」）`;
    case "missing":
      return action === "inspect"
        ? `（本会话里没有「${requested}」，上面检查的是同主名的最新版本「${actual}」。）`
        : `（本会话里没有「${requested}」，已${action === "edit" ? "改" : "读"}同主名的最新版本「${actual}」）`;
    case "ext":
      return action === "inspect"
        ? `（你给的「${requested}」没带扩展名，已按实际类型检查「${actual}」。）`
        : `（你写的「${requested}」没带扩展名，已按实际类型${action === "edit" ? "改" : "读"}「${actual}」）`;
    case "alias":
      // **不能说成"没带扩展名"**：模型写的扩展名是对的，只是落盘时表格统一成了 .xlsx
      // （`create_file(kind:"csv")` 会被改写成 xlsx，`saveArtifactFile` 再剥掉 .csv）。
      return action === "inspect"
        ? `（「${requested}」在本应用里落成了「${actual}」——表格产物统一存成 .xlsx，上面检查的是它。）`
        : `（「${requested}」在本应用里落成了「${actual}」——表格产物统一存成 .xlsx，${verb}它）`;
    default:
      return "";
  }
}

/** 与 `saveArtifactFile` 的 kind 白名单保持一致（新增 kind 时两边都要改）。 */
export const KNOWN_ARTIFACT_EXTS = [".html", ".md", ".xlsx", ".csv", ".tsv"] as const;

/**
 * 把同名多版本**折叠成一份**，用于注入给模型的"本会话已产出的文件"清单。
 *
 * 为什么需要（实测缺口）：渲染端 `foldArtifactVersions` 早就只展示最新一版，
 * 但注入清单直接 `readdir` 全量——模型每修一次 bug 就多一个 `报告 (2).html`、
 * `报告 (3).html`……而清单只保留前 20 条（按修改时间倒序）。
 * 于是**改得多反而更糟**：同一份文件的 20 个旧版本把限额占满，别的文件
 * （比如那份 .md）被挤出去，模型手里就"没有"它了，接着就是"找不到产物"或重复生成。
 *
 * @param names 已按**修改时间倒序**排列的文件名。顺序即优先级：
 *              每组保留最先出现的那一个（= 最新版），与渲染端的"只显示最新"同口径。
 */
export function foldArtifactNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const key = `${versionStem(name).toLowerCase()}|${path.extname(name).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}
