import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const userData = await mkdtemp(path.join(tmpdir(), "h3-secrets-"));

// safeStorage 在测试环境不存在。这里用"前缀标记"的假实现：
// 只有以 enc: 开头的密文能解开，其余抛与真实实现同样的英文错误。
vi.mock("electron", () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (buffer: Buffer) => {
      const text = buffer.toString();
      if (!text.startsWith("enc:")) {
        throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString. Ciphertext does not appear to be encrypted.");
      }
      return text.slice(4);
    }
  }
}));

const { SettingsStore } = await import("./settingsStore");

const secretFile = () => path.join(userData, "secrets.json");
const encode = (text: string) => Buffer.from(text).toString("base64");

describe("SettingsStore 密钥解密失败", () => {
  beforeEach(async () => {
    await writeFile(secretFile(), "{}", "utf8");
  });

  // 换机器 / Local State 丢失后密文仍在但解不开。此时 hasSecret 必须返回 false，
  // 否则界面显示"已保存"，实际每次调用都失败（实测 Electron 探针 decrypt-failure）。
  it("密文解不开时 hasSecret 返回 false", async () => {
    await writeFile(secretFile(), JSON.stringify({ llmApiKey: encode("garbage") }), "utf8");
    await expect(new SettingsStore().hasSecret("llmApiKey")).resolves.toBe(false);
  });

  it("密文可解开时 hasSecret 返回 true、getSecret 返回原文", async () => {
    await writeFile(secretFile(), JSON.stringify({ llmApiKey: encode("enc:sk-abc") }), "utf8");
    const store = new SettingsStore();
    await expect(store.hasSecret("llmApiKey")).resolves.toBe(true);
    await expect(store.getSecret("llmApiKey")).resolves.toBe("sk-abc");
  });

  it("没有保存过时 hasSecret 为 false、getSecret 为空串", async () => {
    const store = new SettingsStore();
    await expect(store.hasSecret("rbCardCode")).resolves.toBe(false);
    await expect(store.getSecret("rbCardCode")).resolves.toBe("");
  });

  // 英文 crypto 错误对用户毫无指向性：它会一路透到"生成失败"的提示里，
  // 用户不知道只要重新填一次 Key 就能修好。
  it("解不开时 getSecret 抛中文可执行提示，不透出英文", async () => {
    await writeFile(secretFile(), JSON.stringify({ minimaxApiKey: encode("garbage") }), "utf8");
    const error = await new SettingsStore().getSecret("minimaxApiKey").catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("重新填写");
    expect((error as Error).message).not.toMatch(/ciphertext|decrypt/i);
  });
});

// 两个参数都来自 IPC：
// - `encryptString(123)` 抛英文 TypeError（实测 "Error processing argument at index 0"）
// - `name` 非白名单时会写到下游永远读不到的键上（"保存了但没生效"）
describe("setSecret 入参校验", () => {
  it("非字符串 value 报中文错误（不抛 encryptString 的英文 TypeError）", async () => {
    const store = new SettingsStore();
    for (const bad of [123, null, undefined, {}, ["a"]]) {
      const error = await store.setSecret("llmApiKey", bad as never).catch((e: Error) => e);
      expect((error as Error).message).toBe("密钥内容必须是文本。");
    }
  });

  it("非白名单 name 被拒绝（不会静默写进无效键）", async () => {
    const store = new SettingsStore();
    for (const bad of ["evilKey", "__proto__", "", 123, null]) {
      const error = await store.setSecret(bad as never, "v").catch((e: Error) => e);
      expect((error as Error).message).toBe("密钥类型无效。");
    }
  });

  it("合法 name + 字符串 value 正常保存", async () => {
    const store = new SettingsStore();
    await expect(store.setSecret("searchApiKey", "sk-x")).resolves.toBeUndefined();
    await expect(store.getSecret("searchApiKey")).resolves.toBe("sk-x");
  });
});

// secrets.json 在磁盘上，属外部数据（可被手改、也可能被旧版本写脏）。
// 某键不是字符串时，`Buffer.from(123, "base64")` 抛英文 ERR_INVALID_ARG_TYPE、
// `decryptString({})` 抛另一种英文错误 —— 两条都会透到"测试连接失败"里。
describe("密钥文件脏值容错", () => {
  it("键值非字符串时按「没有该密钥」处理，不抛英文错误", async () => {
    await writeFile(secretFile(), JSON.stringify({
      llmApiKey: 123,
      searchApiKey: { evil: true },
      minimaxApiKey: null
    }), "utf8");
    const store = new SettingsStore();
    await expect(store.getSecret("llmApiKey")).resolves.toBe("");
    await expect(store.getSecret("searchApiKey")).resolves.toBe("");
    await expect(store.hasSecret("minimaxApiKey")).resolves.toBe(false);
  });

  it("文件不是对象（数组 / 字符串 / null）时当作没有密钥", async () => {
    for (const bad of ["[]", "\"x\"", "null", "42"]) {
      await writeFile(secretFile(), bad, "utf8");
      const store = new SettingsStore();
      await expect(store.getSecret("llmApiKey")).resolves.toBe("");
    }
  });

  // setSecret 是「读-改-写」：文件坏了却返回 {} 的话，只写回本次这一个密钥，
  // 其余已保存的 Key 被静默清空（用户下次生成才发现"所有后端都要重填"）。
  it("文件损坏时先备份成 .corrupt-*，不只写回本次密钥", async () => {
    await writeFile(secretFile(), "{ 半截", "utf8");
    const store = new SettingsStore();
    await store.setSecret("llmApiKey", "sk-new");
    const files = await readdir(userData);
    expect(files.some((name) => name.startsWith("secrets.json.corrupt-"))).toBe(true);
    // 新密钥本身仍应正常写入并读回。
    await expect(store.getSecret("llmApiKey")).resolves.toBe("sk-new");
  });
});
