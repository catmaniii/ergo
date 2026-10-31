// 读 zip 包（345 号票）：audio.cpp 的 Windows 发布包是 .zip。测试自己打小包，不下真的包。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { extractZip, findInTree, ZipError } from "../../src/components/zip.ts";
import { blob, makeZip, type ZipItem } from "../helpers/fake-downloads.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

function pack(items: readonly ZipItem[], options: { zip64?: boolean } = {}) {
  const dir = makeTempDir();
  const file = path.join(dir, "pack.zip");
  fs.writeFileSync(file, makeZip(items, options));
  return { file, dest: path.join(dir, "out") };
}

const read = (dest: string, rel: string) => fs.readFileSync(path.join(dest, ...rel.split("/")));

describe("解开 zip 包", () => {
  test("压缩的、不压缩的、空文件、子目录都解得开，内容一字不差（和 release 打出来的 zip -qqr 一样，文件在包的最外层）", async () => {
    const big = blob(200_000, 7);
    const { file, dest } = pack([
      { name: "audiocpp_server.exe", body: big },
      { name: "README.md", body: "说明\n", stored: true },
      { name: "empty.txt", body: "" },
      { name: "model_specs/", directory: true },
      { name: "model_specs/fish_audio.json", body: '{"family":"fish_audio"}' },
      { name: "tools/community_models/a.py", body: "print(1)\n" },
    ]);
    await extractZip(file, dest);
    expect(read(dest, "audiocpp_server.exe").equals(big)).toBe(true);
    expect(read(dest, "README.md").toString()).toBe("说明\n");
    expect(read(dest, "empty.txt").length).toBe(0);
    expect(read(dest, "model_specs/fish_audio.json").toString()).toBe('{"family":"fish_audio"}');
    expect(read(dest, "tools/community_models/a.py").toString()).toBe("print(1)\n");
  });

  test("ZIP64 的目录（大小和位置都写在扩展字段里）读得对", async () => {
    const body = blob(50_000, 9);
    const { file, dest } = pack(
      [
        { name: "a.bin", body },
        { name: "dir/b.bin", body: "b" },
      ],
      { zip64: true },
    );
    await extractZip(file, dest);
    expect(read(dest, "a.bin").equals(body)).toBe(true);
    expect(read(dest, "dir/b.bin").toString()).toBe("b");
  });

  test("strip 去掉前几段；只剩那几层目录自己的不算一项", async () => {
    const { file, dest } = pack([
      { name: "pkg/", directory: true },
      { name: "pkg/bin/a.exe", body: "a" },
    ]);
    await extractZip(file, dest, { strip: 1 });
    expect(read(dest, "bin/a.exe").toString()).toBe("a");
    expect(fs.existsSync(path.join(dest, "pkg"))).toBe(false);
  });

  test.each(["../evil.txt", "a/../../evil.txt", "C:/evil.txt", "/evil.txt", "..\\evil.txt"])("路径 %s 不安全：整个包不用，一个文件都不写", async (name) => {
    const { file, dest } = pack([
      { name: "good.txt", body: "good" },
      { name, body: "evil" },
    ]);
    await expect(extractZip(file, dest)).rejects.toThrow(/不安全的路径/);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(dest), "evil.txt"))).toBe(false);
  });

  test("flatten：不分目录，文件都放在这一层（运行库放到程序旁边）；路径不安全的一样不用", async () => {
    const { file, dest } = pack([
      { name: "runtime/", directory: true },
      { name: "runtime/x64/cublas64_13.dll", body: "dll" },
      { name: "cufft64_12.dll", body: "fft" },
    ]);
    await extractZip(file, dest, { flatten: true });
    expect(fs.readdirSync(dest).toSorted()).toEqual(["cublas64_13.dll", "cufft64_12.dll"]);
    const bad = pack([{ name: "../evil.dll", body: "x" }]);
    await expect(extractZip(bad.file, bad.dest, { flatten: true })).rejects.toThrow(/不安全的路径/);
  });

  test("按文件名找：这一层优先、不分大小写、往下几层都找得到，太深、没有是 undefined", () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(dir, "a", "b", "Server.EXE"), "");
    expect(findInTree(dir, "server.exe")).toBe(path.join(dir, "a", "b", "Server.EXE"));
    expect(findInTree(dir, "server.exe", 1)).toBeUndefined();
    expect(findInTree(dir, "nope.exe")).toBeUndefined();
    expect(findInTree(path.join(dir, "missing"), "server.exe")).toBeUndefined();
  });

  test("符号链接跳过，别的照解", async () => {
    const { file, dest } = pack([
      { name: "link", body: "C:/Windows", symlink: true },
      { name: "real.txt", body: "real" },
    ]);
    await extractZip(file, dest);
    expect(fs.existsSync(path.join(dest, "link"))).toBe(false);
    expect(read(dest, "real.txt").toString()).toBe("real");
  });

  test("不是 zip、不完整的包都报错，不留半截当成解好了", async () => {
    const dir = makeTempDir();
    const notZip = path.join(dir, "not.zip");
    fs.writeFileSync(notZip, blob(1000, 3));
    await expect(extractZip(notZip, path.join(dir, "a"))).rejects.toBeInstanceOf(ZipError);
    const empty = path.join(dir, "empty.zip");
    fs.writeFileSync(empty, "");
    await expect(extractZip(empty, path.join(dir, "b"))).rejects.toBeInstanceOf(ZipError);
    // 目录在，内容被截掉一段（目录指的位置超出了文件）
    const whole = makeZip([{ name: "a.bin", body: blob(5000, 4) }]);
    const cut = Buffer.concat([whole.subarray(0, 100), whole.subarray(whole.length - 80)]);
    const truncated = path.join(dir, "cut.zip");
    fs.writeFileSync(truncated, cut);
    await expect(extractZip(truncated, path.join(dir, "c"))).rejects.toBeInstanceOf(Error);
  });

  test("内容比目录里写的多：算坏", async () => {
    const whole = makeZip([{ name: "a.txt", body: "0123456789", stored: true }]);
    // 把目录里的原始大小改小（中央目录头在 EOCD 前面：46 + 名字 5 字节）
    const central = whole.length - 22 - 46 - 5;
    whole.writeUInt32LE(3, central + 24);
    const { dest } = pack([]);
    const file = path.join(path.dirname(dest), "bad.zip");
    fs.writeFileSync(file, whole);
    await expect(extractZip(file, dest)).rejects.toThrow(/内容坏了/);
  });

  test("中止：抛错，停下来", async () => {
    const { file, dest } = pack([{ name: "a.bin", body: blob(100_000, 5) }]);
    const controller = new AbortController();
    controller.abort();
    await expect(extractZip(file, dest, { signal: controller.signal })).rejects.toBeInstanceOf(Error);
    expect(fs.existsSync(path.join(dest, "a.bin"))).toBe(false);
  });
});
