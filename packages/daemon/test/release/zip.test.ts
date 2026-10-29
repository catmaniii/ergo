// zip 读写（318 号票）：写一圈读一圈；中文名、空文件、压不小的（存储）；zip64（条目多于 65535）；不安全的路径、坏了的包不解；
// 写出来的包 PowerShell（.NET 的 ZipFile，安装脚本用它解）也解得开。
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractZip, listZip, safeEntryName, ZipError, ZipWriter } from "../../src/release/zip.ts";

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ergo-zip-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("zip", () => {
  it("写一圈读一圈：deflate 和存储都有、中文名、空文件、子目录", async () => {
    const dir = tmp();
    const file = path.join(dir, "a.zip");
    const random = crypto.randomBytes(5000);
    const w = new ZipWriter(file);
    w.add("app/readme.txt", Buffer.from("hello ".repeat(1000)));
    w.add("app/中文/说明.txt", Buffer.from("二狗"));
    w.add("app/empty.txt", Buffer.alloc(0));
    w.add("node/node.bin", random);
    w.close();
    const entries = listZip(file);
    expect(entries.map((e) => e.name)).toEqual(["app/readme.txt", "app/中文/说明.txt", "app/empty.txt", "node/node.bin"]);
    expect(entries[0]!.method).toBe(8);
    expect(entries[3]!.method).toBe(0);
    const out = path.join(dir, "out");
    expect(await extractZip(file, out)).toBe(4);
    expect(fs.readFileSync(path.join(out, "app", "readme.txt"), "utf8")).toBe("hello ".repeat(1000));
    expect(fs.readFileSync(path.join(out, "app", "中文", "说明.txt"), "utf8")).toBe("二狗");
    expect(fs.statSync(path.join(out, "app", "empty.txt")).size).toBe(0);
    expect(fs.readFileSync(path.join(out, "node", "node.bin")).equals(random)).toBe(true);
  });

  it("同名（不分大小写）、不安全的路径写不进去", () => {
    const w = new ZipWriter(path.join(tmp(), "b.zip"));
    w.add("a/B.txt", Buffer.from("1"));
    expect(() => w.add("a/b.txt", Buffer.from("2"))).toThrow(ZipError);
    expect(() => w.add("../evil.txt", Buffer.from("x"))).toThrow(/不安全/);
    w.close();
    for (const bad of ["/abs", "C:/x", "a/../b", "a\\b", "", "a//b"]) expect(safeEntryName(bad)).toBe(false);
    for (const ok of ["a", "a/b.txt", "dir/"]) expect(safeEntryName(ok)).toBe(true);
  });

  it("条目多于 65535 个：写成 zip64，读得回来", async () => {
    const dir = tmp();
    const file = path.join(dir, "many.zip");
    const w = new ZipWriter(file);
    for (let i = 0; i < 65_600; i++) w.add(`f/${i}.txt`, Buffer.from(String(i)));
    w.close();
    const entries = listZip(file);
    expect(entries.length).toBe(65_600);
    expect(entries[65_599]!.name).toBe("f/65599.txt");
  }, 60_000);

  it("包里有 ../（别人打的坏包）、内容被改过：不解", async () => {
    const dir = tmp();
    const file = path.join(dir, "evil.zip");
    const w = new ZipWriter(file);
    w.add("ok/zzzz.txt", Buffer.from("hello world hello world"));
    w.close();
    // 把名字改成 ../zzzz.txt（同样长）
    const buf = fs.readFileSync(file);
    const patched = Buffer.from(buf.toString("latin1").replaceAll("ok/zzzz.txt", "../zzzz.tx/"), "latin1");
    fs.writeFileSync(file, patched);
    await expect(extractZip(file, path.join(dir, "out1"))).rejects.toThrow(/不安全/);

    const file2 = path.join(dir, "crc.zip");
    const w2 = new ZipWriter(file2);
    w2.add("x.bin", crypto.randomBytes(100));
    w2.close();
    const b2 = fs.readFileSync(file2);
    b2[40] = b2[40]! ^ 0xff;
    fs.writeFileSync(file2, b2);
    await expect(extractZip(file2, path.join(dir, "out2"))).rejects.toThrow(/坏了/);
    expect(() => listZip(path.join(dir, "evil.zip") + ".missing")).toThrow(/ENOENT/);
    fs.writeFileSync(path.join(dir, "not.zip"), "plain text");
    expect(() => listZip(path.join(dir, "not.zip"))).toThrow(/不是 zip/);
  });

  it.runIf(process.platform === "win32")("PowerShell（.NET 的 ZipFile，安装脚本用它解）解得开，中文名对", () => {
    const dir = tmp();
    const file = path.join(dir, "ps.zip");
    const w = new ZipWriter(file);
    w.add("app/中文.txt", Buffer.from("二狗"));
    w.add("app/big.txt", Buffer.from("x".repeat(100_000)));
    w.close();
    const out = path.join(dir, "ps-out");
    const r = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${file}', '${out}')`],
      { encoding: "utf8" },
    );
    expect({ status: r.status, stderr: r.stderr }).toMatchObject({ status: 0 });
    expect(fs.readFileSync(path.join(out, "app", "中文.txt"), "utf8")).toBe("二狗");
    expect(fs.statSync(path.join(out, "app", "big.txt")).size).toBe(100_000);
  });
});
