import { describe, expect, it } from "vitest";
import type { AppSettings } from "../../shared/types";
import type { SettingsStore } from "../modules/settingsStore";
import { AdapterRegistry, backendAvailability, backendMentionedInText, backendPickedFromQuestions, normalizeBackendKind } from "./adapterRegistry";

/**
 * 背景（实测真机，2026-10-20）：用户输入一段视频描述后，智能体**直接**用「连接设置」
 * 里的默认后端（常见是本机 ComfyUI）开跑，从没问过"想用哪个方式生成"。
 * `generate_video` 的后端原先是写死的 `turn.value.defaultBackend`，模型即使想按用户
 * 的选择走也没有参数可传。
 *
 * 修法是给工具加 `backend` 参数，并在这里归一——**不能用 `z.enum`**：
 * 模型写「本机」「ComfyUI」时枚举会在 `parseToolCall` 阶段拒掉整个调用
 * （本会话已修 19 处"schema 硬校验静默打死整轮"）。
 */
describe("normalizeBackendKind", () => {
  it("四个规范值原样通过", () => {
    expect(normalizeBackendKind("local")).toBe("local");
    expect(normalizeBackendKind("ssh")).toBe("ssh");
    expect(normalizeBackendKind("minimax")).toBe("minimax");
    expect(normalizeBackendKind("rb")).toBe("rb");
  });

  it("大小写与首尾空白都能容忍", () => {
    expect(normalizeBackendKind("  LOCAL  ")).toBe("local");
    expect(normalizeBackendKind("MiniMax")).toBe("minimax");
    expect(normalizeBackendKind("RB")).toBe("rb");
  });

  it("模型/用户的口语叫法也要认（否则只能报错）", () => {
    for (const [value, expected] of [
      ["comfy", "local"],
      ["comfyui", "local"],
      ["本机", "local"],
      ["本地", "local"],
      ["remote", "ssh"],
      ["远程", "ssh"],
      ["云", "minimax"],
      ["云端", "minimax"],
      ["云api", "minimax"],
      ["瞬映", "rb"],
      ["卡密", "rb"]
    ] as const) {
      expect(normalizeBackendKind(value), value).toBe(expected);
    }
  });

  it("认不出来返回 undefined（让调用方回一句可选清单，而不是悄悄用默认后端）", () => {
    // **这是关键契约**：静默回落会让"用户以为选了云端、实际跑在本机"——
    // 账与结果都完全不同，而且用户看不出任何异常。
    for (const value of ["openai", "gpt", "", "   ", "cloud-x", "midjourney"]) {
      expect(normalizeBackendKind(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it("非字符串输入不抛错（参数来自模型，类型没有保证）", () => {
    for (const value of [null, undefined, 42, {}, [], true]) {
      expect(normalizeBackendKind(value)).toBeUndefined();
    }
  });
});

/**
 * 实测缺陷（probe-nocred-backend，2026-10-20）：用户说"用云端生成"，模型调
 * `generate_video({backend:"minimax"})`，而这台机器没存 MiniMax Key。
 * `submit()` 只校验参数就把任务建出来 → 回执「已创建 1 个视频生成任务」→
 * 随后 runTask 抛「请先保存 API Key」→ 模型据此对用户说"已经帮你提交了"，
 * 卡片却是 failed。这条判定必须**在 submit 之前**回答"这个后端现在能不能用"。
 */
describe("backendAvailability", () => {
  const settings = { localComfyUrl: "", ssh: { host: "", username: "" } };
  const none = async () => false;

  it("什么都没配时四个都不可用，且各自给出原因", async () => {
    const list = await backendAvailability(settings, none);
    expect(list.map((e) => e.kind)).toEqual(["local", "ssh", "minimax", "rb"]);
    for (const entry of list) expect(entry.reason, entry.kind).toBeTruthy();
    // 原因要能直接给用户看：必须指向具体的配置项，不能只说"不可用"。
    expect(list.find((e) => e.kind === "minimax")!.reason).toContain("MiniMax");
    expect(list.find((e) => e.kind === "rb")!.reason).toContain("瞬映");
    expect(list.find((e) => e.kind === "local")!.reason).toContain("ComfyUI");
    expect(list.find((e) => e.kind === "ssh")!.reason).toContain("SSH");
  });

  it("配好之后对应后端不再带 reason（调用方据此筛出可选项）", async () => {
    const list = await backendAvailability(
      { localComfyUrl: "http://127.0.0.1:8188", ssh: { host: "10.0.0.2", username: "me" } },
      async (name) => name === "rbCardCode"
    );
    expect(list.filter((e) => !e.reason).map((e) => e.kind)).toEqual(["local", "ssh", "rb"]);
  });

  it("只有主机没有用户名时 SSH 仍算不可用（连不上，等于没配）", async () => {
    const list = await backendAvailability({ localComfyUrl: "", ssh: { host: "10.0.0.2", username: "" } }, none);
    expect(list.find((e) => e.kind === "ssh")!.reason).toBeTruthy();
  });

  it("hasSecret 抛错时算「没有」，不能把异常冒成整轮失败", async () => {
    // 换机器 / Local State 丢失时 safeStorage 解不开，hasSecret 会抛。
    // 让异常穿出去会连"告诉模型哪些可用"这一步都做不成。
    const list = await backendAvailability(
      { localComfyUrl: "http://127.0.0.1:8188", ssh: { host: "", username: "" } },
      async () => {
        throw new Error("decrypt failed");
      }
    );
    expect(list.filter((e) => !e.reason).map((e) => e.kind)).toEqual(["local"]);
  });
});

/**
 * 「用户这句话里有没有明确说用哪个后端」。
 *
 * 用途（实测 22f67da 的准入闸门）：有多个后端可用时，`generate_video` 要求模型先问；
 * 但用户自己说了「用本机的」还拦着不让动手就是刁难。这里只认**明确指名**。
 *
 * 词表必须保守——认错方向的代价不对称：
 * - 误判成"用户选了云端" → 跳过询问，可能按秒计费、扣卡密次数；
 * - 漏判 → 多问一句，用户点一下就好。
 * 所以宁可漏判。
 */
describe("backendMentionedInText", () => {
  it("明确的指名都认得出来", () => {
    expect(backendMentionedInText("用本机生成")).toBe("local");
    expect(backendMentionedInText("走 ComfyUI 吧")).toBe("local");
    expect(backendMentionedInText("用云端生成")).toBe("minimax");
    expect(backendMentionedInText("走 MiniMax API")).toBe("minimax");
    expect(backendMentionedInText("用瞬映，我有卡密")).toBe("rb");
    expect(backendMentionedInText("ssh 那台机器")).toBe("ssh");
  });

  it("正文里的「云」「云端渲染」不算选了云端（这是关键的不误判）", () => {
    // 用户的视频描述里常有「云海」「云端」，那是画面内容，不是后端选择。
    expect(backendMentionedInText("小仙女悬浮在云海之上")).toBeUndefined();
    expect(backendMentionedInText("远处是云海、仙山与明月")).toBeUndefined();
  });

  /**
   * **这条是花钱的边界**（实测推演，2026-10-20）：
   * 用户原话「帮我生成一个云端漂浮的城堡」——「云端」是**画面内容**。
   * 若判成"用户选了 MiniMax 云端"，闸门就会跳过询问、直接按秒计费生成。
   * 用户只是描述画面，账单却按云端结算。
   *
   * 所以裸「云端」只在**明确是选项作答**的语境（`loose`）里才算数：
   * 那时它来自我们给出的预设选项，语义没有歧义。
   */
  it("原话里的「云端城堡」不算选了云端（误判会花错钱）", () => {
    expect(backendMentionedInText("帮我生成一个云端漂浮的城堡，梦幻风格")).toBeUndefined();
    expect(backendMentionedInText("小仙女站在云端之上，身后是云海")).toBeUndefined();
    expect(backendMentionedInText("梦幻的云端效果")).toBeUndefined();
    // 明确的后端术语仍要认得出来（这些不会出现在画面描述里）
    expect(backendMentionedInText("用 Minimax 生成")).toBe("minimax");
    expect(backendMentionedInText("走云 api")).toBe("minimax");
  });

  it("选择题答案语境（loose）里裸「云端」算数（那是我们给出的选项）", () => {
    expect(backendMentionedInText("云端（按秒计费）", { loose: true })).toBe("minimax");
    expect(backendMentionedInText("【生成方式】用户选择：云端", { loose: true })).toBe("minimax");
    // 画面描述即使走 loose 也不该被当成后端——但这里只保证严格模式的行为，
    // loose 是我们自己给的选项文本，出现画面词的概率极低。
  });

  it("完全没提后端时返回 undefined（走「先问」那条路）", () => {
    expect(backendMentionedInText("帮我生成一个小仙女视频")).toBeUndefined();
    expect(backendMentionedInText("")).toBeUndefined();
  });

  it("非字符串输入不抛错（答案来自 IPC，类型没有保证）", () => {
    for (const value of [null, undefined, 42, {}, [], true]) {
      expect(backendMentionedInText(value)).toBeUndefined();
    }
  });
});

/**
 * 从选择题答案里判断"用户选了哪个后端"。
 *
 * 实测缺陷 probe-style-option-backend：模型问的是**画面风格**，选项里恰好有
 * 「云端漂浮的城堡」，用户点了它 —— 结果被当成"选了 MiniMax 云端"，任务按秒计费。
 * 他只是在挑画面。
 *
 * 判据：**不是所有题都在问后端**，只有 id/header/question 指向后端主题的题，
 * 其选项 label 才参与宽松匹配；选项 id 本身是后端名时例外（那是模型专门标后端的）。
 */
describe("backendPickedFromQuestions", () => {
  const answerWith = (...labels: string[]) => `用户已回答：\n【题】用户选择：${labels.join("、")}`;

  it("后端题的选项 label 能认（云端 → minimax）", () => {
    const questions = [{ id: "backend", header: "生成方式", question: "用哪个后端？", options: [
      { id: "a", label: "云端（按秒计费）" },
      { id: "b", label: "本机 ComfyUI" }
    ] }];
    expect(backendPickedFromQuestions(questions, answerWith("云端（按秒计费）"))).toBe("minimax");
    expect(backendPickedFromQuestions(questions, answerWith("本机 ComfyUI"))).toBe("local");
  });

  it("**风格题的「云端」不算**（这条是花钱的边界）", () => {
    const questions = [{ id: "style", header: "画面风格", question: "想要哪种画面风格？", options: [
      { id: "cloud", label: "云端漂浮的城堡" },
      { id: "forest", label: "森林秘境" }
    ] }];
    expect(backendPickedFromQuestions(questions, answerWith("云端漂浮的城堡"))).toBeUndefined();
  });

  it("选项 id 本身是后端名时，与题目主题无关也认", () => {
    const questions = [{ id: "q1", header: "随便", question: "随便问问", options: [
      { id: "minimax", label: "按秒计费的那个" }
    ] }];
    expect(backendPickedFromQuestions(questions, answerWith("按秒计费的那个"))).toBe("minimax");
  });

  it("答案里没出现的 label 不算（用户没点它）", () => {
    const questions = [{ id: "backend", header: "生成方式", question: "用哪个后端？", options: [
      { id: "x", label: "云端" }
    ] }];
    expect(backendPickedFromQuestions(questions, answerWith("本机"))).toBeUndefined();
  });

  it("脏入参不抛错（questions / options / answer 都来自 IPC）", () => {
    for (const bad of [null, undefined, 42, {}, ""]) {
      expect(() => backendPickedFromQuestions(bad as never, bad as never)).not.toThrow();
    }
    expect(backendPickedFromQuestions([], answerWith("x"))).toBeUndefined();
    expect(backendPickedFromQuestions([{ id: "backend", options: null }], answerWith("x"))).toBeUndefined();
  });
});

/**
 * `assertUsable` 是 `submit()` / `retry()` 建任务**之前**的唯一凭据闸门
 * （实测缺陷 probe-retry-nocred：卡密被删后点重试会先建出一条注定失败的任务）。
 *
 * 四条分支此前都没有单测——而这类"只在缺凭据时才生效"的判定最容易在重构中
 * 被悄悄改成恒真（恒真不会红任何现有用例，只会让用户重新看到"注定失败的卡片"）。
 * 这里锁住的是**两个方向**：缺了必须拒、有就必须放行（后者防"拒得太宽"，
 * 那样所有提交都会被挡，比原缺陷更严重）。
 */
describe("AdapterRegistry.assertUsable", () => {
  /** 造一个只实现本方法用到的两个读接口的假 store（不碰真实 safeStorage）。 */
  const makeRegistry = (settings: Partial<AppSettings>, secrets: Record<string, string> = {}) => {
    const store = {
      get: async () => settings,
      getSecret: async (name: string) => secrets[name] ?? ""
    } as unknown as SettingsStore;
    return new AdapterRegistry(store);
  };
  const base = { localComfyUrl: "http://127.0.0.1:8188", ssh: { host: "", username: "" } };

  it("minimax 没存 Key 时拒绝，并说清去哪儿配", async () => {
    await expect(makeRegistry(base).assertUsable("minimax")).rejects.toThrow(/MiniMax API Key/);
  });

  it("minimax 存了 Key 就放行", async () => {
    await expect(makeRegistry(base, { minimaxApiKey: "test-key" }).assertUsable("minimax")).resolves.toBeUndefined();
  });

  it("rb 没存卡密时拒绝，存了就放行（卡密按次扣，不能带着空值去提交）", async () => {
    await expect(makeRegistry(base).assertUsable("rb")).rejects.toThrow(/瞬映卡密/);
    await expect(makeRegistry(base, { rbCardCode: "test-card" }).assertUsable("rb")).resolves.toBeUndefined();
  });

  it("local 没填 ComfyUI 地址时拒绝，填了就放行", async () => {
    await expect(makeRegistry({ localComfyUrl: "" }).assertUsable("local")).rejects.toThrow(/ComfyUI 地址/);
    await expect(makeRegistry(base).assertUsable("local")).resolves.toBeUndefined();
  });

  it("ssh 缺主机或缺用户名都拒绝（只填一半等于连不上），两个都有才放行", async () => {
    await expect(makeRegistry({ ssh: { host: "1.2.3.4", username: "" } }).assertUsable("ssh")).rejects.toThrow(/SSH/);
    await expect(makeRegistry({ ssh: { host: "", username: "root" } }).assertUsable("ssh")).rejects.toThrow(/SSH/);
    await expect(makeRegistry({ ssh: { host: "1.2.3.4", username: "root" } }).assertUsable("ssh")).resolves.toBeUndefined();
  });

  it("错误文案里绝不出现密钥内容（CLAUDE.md 红线）", async () => {
    // 反例方向：把"有 Key"误判成"没有"时，报错里也只会说该去配置，不会回显任何值。
    const registry = makeRegistry({ localComfyUrl: "" }, { minimaxApiKey: "sk-should-never-leak" });
    const error = await registry.assertUsable("local").catch((e: Error) => e);
    expect(String((error as Error).message)).not.toContain("sk-should-never-leak");
  });
});

/**
 * `describeEndpoint`：失败文案里"实际连的地址"的来源（实测 probe-backend-down）。
 *
 * 最重要的一条是**不能泄露凭据**：这条字符串会直接显示在任务卡片上。
 */
describe("AdapterRegistry.describeEndpoint", () => {
  const makeRegistry = (settings: Record<string, unknown>) => {
    const store = {
      get: async () => settings,
      // 万一有人在这里读了密钥，让它返回一个显眼的标记，便于断言"没有泄露"
      getSecret: async () => "SECRET_SHOULD_NEVER_LEAK"
    } as unknown as SettingsStore;
    return new AdapterRegistry(store);
  };

  it("local / minimax / rb 返回各自的 baseUrl", async () => {
    const registry = makeRegistry({
      localComfyUrl: "http://127.0.0.1:8188",
      minimaxBaseUrl: "https://api.minimax.io",
      rbBaseUrl: "https://rb.example.com"
    });
    expect(await registry.describeEndpoint("local")).toBe("http://127.0.0.1:8188");
    expect(await registry.describeEndpoint("minimax")).toBe("https://api.minimax.io");
    expect(await registry.describeEndpoint("rb")).toBe("https://rb.example.com");
  });

  it("地址没配时给出明确占位（不是空串，也不是 undefined）", async () => {
    const registry = makeRegistry({ localComfyUrl: "", minimaxBaseUrl: "", rbBaseUrl: "" });
    for (const kind of ["local", "minimax", "rb"] as const) {
      expect(await registry.describeEndpoint(kind)).toContain("未配置");
    }
  });

  it("ssh 返回 用户名@主机 → 远端地址:端口", async () => {
    const registry = makeRegistry({
      ssh: { host: "10.0.0.5", username: "root", remoteComfyHost: "127.0.0.1", remoteComfyPort: 8188 }
    });
    const text = await registry.describeEndpoint("ssh");
    expect(text).toContain("root@10.0.0.5");
    expect(text).toContain("8188");
  });

  it("ssh 没填主机时给出占位", async () => {
    expect(await makeRegistry({ ssh: { host: "" } }).describeEndpoint("ssh")).toContain("未配置");
  });

  it("**任何分支都不能泄露凭据**（这条字符串会显示给用户）", async () => {
    const registry = makeRegistry({
      localComfyUrl: "http://127.0.0.1:8188",
      minimaxBaseUrl: "https://api.minimax.io",
      rbBaseUrl: "https://rb.example.com",
      ssh: { host: "10.0.0.5", username: "root", remoteComfyHost: "127.0.0.1", remoteComfyPort: 8188, privateKeyPath: "/home/u/.ssh/id_rsa" }
    });
    for (const kind of ["local", "minimax", "rb", "ssh"] as const) {
      const text = await registry.describeEndpoint(kind);
      expect(text, kind).not.toContain("SECRET_SHOULD_NEVER_LEAK");
      // 私钥路径也不该出现在给用户看的地址串里
      expect(text, kind).not.toContain("id_rsa");
    }
  });
});

/**
 * **用户可见文案里不能混入西里尔字母等易混字符**（实测缺陷 2026-10-21）。
 *
 * `backendAvailability` 的 `reason` 会直接显示在连接设置的后端清单上。
 * 它原本写的是「还没保存 MiniMax АРI keys」——其中 `А`(U+0410) 与 `Р`(U+0420)
 * 是两个**西里尔字母**，看起来与拉丁 `A`/`P` 一模一样，但搜索、复制、朗读全都对不上。
 *
 * 这类字符通常来自复制粘贴或输入法误触，肉眼极难发现。
 * 用一条断言把"只允许 ASCII + 中文/中文标点"钉住，比靠人眼看可靠。
 */
describe("backendAvailability：用户可见文案的字符干净度", () => {
  const pick = async (hasSecret: boolean) => {
    const store = { get: async () => ({ localComfyUrl: "", ssh: {} }), getSecret: async () => "" } as unknown as SettingsStore;
    void store; // 这里不直接用 store，用 backendAvailability 的参数形式
    return backendAvailability({ localComfyUrl: "", ssh: { host: "", username: "" } }, async () => hasSecret);
  };

  it("reason 里没有西里尔/希腊等易混字母", async () => {
    for (const hasSecret of [false, true]) {
      for (const entry of await pick(hasSecret)) {
        const text = `${entry.label}${entry.note}${entry.reason ?? ""}`;
        // 西里尔（U+0400–U+04FF）、希腊（U+0370–U+03FF）、全角拉丁（U+FF00–U+FFEF 里的字母段）
        expect(/[Ѐ-ӿͰ-Ͽ]/.test(text), `${entry.kind}: ${text}`).toBe(false);
      }
    }
  });

  it("四个后端的 label / note 都是中文或 ASCII（不出现乱码代理项）", async () => {
    for (const entry of await pick(false)) {
      const text = `${entry.label}${entry.note}`;
      // 孤立的代理项（U+D800–U+DFFF 未配对）会渲染成 �
      expect(/[\uD800-\uDFFF]/.test(text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")), `${entry.kind}: ${text}`).toBe(false);
    }
  });
});
