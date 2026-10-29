// 读 tar 包（323 号票）：npm 的 .tgz 解开（去掉 package/）、pax 长名字、不安全的路径整个不用、链接跳过、坏包报错。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { extractTar, walkTar } from "../../src/components/tar.ts";
import { blob, makeTar } from "../helpers/fake-downloads.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

function write(dir: string, name: string, data: Buffer): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return file;
}

describe("解 tar 包", () => {
  test("gzip 的包去掉第一段解开：目录、文件、跨 512 字节的大文件、pax 写的长名字", async () => {
    const dir = makeTempDir();
    const big = blob(70_000);
    const longName = `package/${"很长的名字".repeat(12)}/x.txt`;
    const file = write(
      dir,
      "pkg.tgz",
      makeTar(
        [
          { path: "package/", type: "dir" },
          { path: "package/package.json", body: '{"name":"x"}' },
          { path: "package/bin/claude.exe", body: big },
          { path: "package/empty.txt", body: "" },
          { path: longName, body: "长", pax: true },
        ],
        true,
      ),
    );
    const dest = path.join(dir, "out");
    const n = await extractTar(file, dest, { gzip: true, strip: 1 });
    expect(n).toBe(4);
    expect(fs.readFileSync(path.join(dest, "package.json"), "utf8")).toBe('{"name":"x"}');
    expect(fs.readFileSync(path.join(dest, "bin", "claude.exe")).equals(big)).toBe(true);
    expect(fs.readFileSync(path.join(dest, "empty.txt"), "utf8")).toBe("");
    expect(fs.readFileSync(path.join(dest, ...longName.split("/").slice(1)), "utf8")).toBe("长");
  });

  test("包里有 .. 这种往外跳的路径：整个包不用", async () => {
    const dir = makeTempDir();
    const file = write(dir, "evil.tar", makeTar([{ path: "package/ok.txt", body: "ok" }, { path: "package/../../escape.txt", body: "坏" }]));
    await expect(extractTar(file, path.join(dir, "out"), { gzip: false, strip: 1 })).rejects.toThrow("不安全的路径");
    expect(fs.existsSync(path.join(dir, "escape.txt"))).toBe(false);
  });

  test("链接不解（跳过）", async () => {
    const dir = makeTempDir();
    const file = write(dir, "link.tar", makeTar([{ path: "a.txt", body: "a" }, { path: "link", type: "symlink" }]));
    const dest = path.join(dir, "out");
    expect(await extractTar(file, dest, { gzip: false })).toBe(1);
    expect(fs.readdirSync(dest)).toEqual(["a.txt"]);
  });

  test("不是 tar 包、半截的包：报错", async () => {
    const dir = makeTempDir();
    await expect(walkTar(write(dir, "x.tar", blob(2048)), { gzip: false }, () => undefined)).rejects.toThrow("不是 tar 包");
    const whole = makeTar([{ path: "a.bin", body: blob(5000) }]);
    await expect(walkTar(write(dir, "cut.tar", whole.subarray(0, 2048)), { gzip: false }, () => undefined)).rejects.toThrow("不完整");
    await expect(walkTar(path.join(dir, "missing.tgz"), { gzip: true }, () => undefined)).rejects.toThrow(/ENOENT/);
  });
});
