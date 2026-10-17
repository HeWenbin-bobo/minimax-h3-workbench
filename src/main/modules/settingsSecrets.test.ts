import { mkdtemp, writeFile } from "node:fs/promises";
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
