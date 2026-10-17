import { mkdtemp, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, readUploadFile } from "./mediaFile";

describe("readUploadFile", () => {
  it("正常大小文件可读，内容正确", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "h3-upload-"));
    const file = path.join(dir, "a.bin");
    await writeFile(file, Buffer.from([1, 2, 3]));
    const bytes = await readUploadFile(file);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it("文件不存在时报中文错误（不透出 ENOENT）", async () => {
    await expect(readUploadFile("/definitely/not/here.bin", "参考视频")).rejects.toThrow("参考视频不存在或不是文件。");
  });

  it("是目录时报中文错误", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "h3-upload-dir-"));
    await expect(readUploadFile(dir)).rejects.toThrow("不存在或不是文件。");
  });

  // 关键：必须在**读取前**拦下超大文件，否则整份读进内存就已经把进程撑爆了。
  it("超过上限的文件在读取前被拒绝", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "h3-upload-big-"));
    const file = path.join(dir, "big.bin");
    await writeFile(file, Buffer.alloc(0));
    // 稀疏文件：只改长度，不实际占盘
    await truncate(file, MAX_UPLOAD_BYTES + 1);
    const error = await readUploadFile(file, "参考视频").catch((e: Error) => e);
    expect((error as Error).message).toContain("超过 50MB 上限");
  });
});
