// 写临时文件再改名（265 号票）：改名碰上文件被占着（EPERM / EBUSY / EACCES）时等一会儿重试，约 5 秒。
// "被占着"用真的占用来模拟：另一个进程（或同一个进程）只读开着目标文件——Windows 上这时改名覆盖会 EPERM（255 号票实测，
// 备份在复制、杀毒在扫、测试在轮询读都是这种）；或者临时目录里刚写的文件被开着（杀毒扫刚写的文件），整个目录改名会失败。
// POSIX 上改名不受开着的文件影响：改名覆盖开着的文件、一直占着就放弃这几条只在 Windows 上跑，整个目录改名的照样过。
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renameRetrying, renameRetryingAsync, writeFileAtomic, writeFileAtomicAsync } from "../../src/util/atomic-file.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const WINDOWS = process.platform === "win32";

/** 另一个进程只读打开这个文件（像 readFileSync 那样），开着 holdMs 毫秒再关；返回时它已经打开了 */
async function holdOpen(file: string, holdMs: number): Promise<ChildProcess> {
  const script = `const fs=require("node:fs");const fd=fs.openSync(${JSON.stringify(file)},"r");process.stdout.write("open");setTimeout(()=>{fs.closeSync(fd);process.exit(0)},${holdMs});`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  holders.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once("data", () => resolve());
    child.once("exit", (code) => reject(new Error(`占着文件的进程提前退出了（${code}）`)));
  });
  return child;
}

const holders: ChildProcess[] = [];
afterEach(() => {
  for (const child of holders.splice(0)) child.kill();
});

/** 目录里除了这些名字还有什么（留没留临时文件） */
const leftovers = (dir: string, expected: readonly string[]) => fs.readdirSync(dir).filter((name) => !expected.includes(name));

describe("写临时文件再改名（265 号票）", () => {
  it("写文件：先写同目录的临时文件再改名成目标，覆盖原来的；父目录没有就建；不留临时文件", () => {
    const dir = makeTempDir("ergo-atomic-");
    const file = path.join(dir, "sub", "settings.json");
    writeFileAtomic(file, "第一版\n");
    expect(fs.readFileSync(file, "utf8")).toBe("第一版\n");
    writeFileAtomic(file, Buffer.from("第二版\n", "utf8"));
    expect(fs.readFileSync(file, "utf8")).toBe("第二版\n");
    expect(leftovers(path.dirname(file), ["settings.json"])).toEqual([]);
  });

  // 下面两条"被占着"的只在 Windows 上有意义（POSIX 上改名不受开着的文件影响）
  it.runIf(WINDOWS)("目标文件正被别的进程开着：不重试的改名 EPERM（对照）；这里等它关掉再改成（不报错、内容是新的、不留临时文件）", async () => {
    const dir = makeTempDir("ergo-atomic-busy-");
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, "旧的\n");
    await holdOpen(file, 600);
    // 对照：不重试的改名这时会失败（255 号票查出的就是这个）
    const probe = path.join(dir, "probe.tmp");
    fs.writeFileSync(probe, "x");
    expect(() => fs.renameSync(probe, file)).toThrow(expect.objectContaining({ code: "EPERM" }));
    fs.rmSync(probe);

    const started = Date.now();
    writeFileAtomic(file, "新的\n");

    expect(fs.readFileSync(file, "utf8")).toBe("新的\n");
    expect(leftovers(dir, ["settings.json"])).toEqual([]);
    // 真的等过（对方开着 600 毫秒）
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });

  it.runIf(WINDOWS)("异步的：同一个进程自己开着目标文件，改名不挡事件循环、关掉之后就改成", async () => {
    const dir = makeTempDir("ergo-atomic-async-");
    const file = path.join(dir, "thumb.jpg");
    fs.writeFileSync(file, "old");
    const fd = fs.openSync(file, "r");
    let closed = false;
    setTimeout(() => {
      fs.closeSync(fd);
      closed = true;
    }, 400);

    await writeFileAtomicAsync(file, Buffer.from("new"));

    // 关掉之后才改成的；事件循环没被挡住，关文件的计时器才跑得了
    expect(closed).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("new");
    expect(leftovers(dir, ["thumb.jpg"])).toEqual([]);
  });

  it("整个临时目录改名：目录里刚写的文件被别的进程开着（杀毒在扫）时等一会儿重试，关掉后改成", async () => {
    const dir = makeTempDir("ergo-atomic-dir-");
    const staging = path.join(dir, ".importing-1");
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, "voice.wav"), "wav");
    await holdOpen(path.join(staging, "voice.wav"), 600);

    renameRetrying(staging, path.join(dir, "v-1"));

    expect(fs.readFileSync(path.join(dir, "v-1", "voice.wav"), "utf8")).toBe("wav");
    expect(fs.existsSync(staging)).toBe(false);
  });

  it("异步的整个目录改名同样等占着的进程关掉", async () => {
    const dir = makeTempDir("ergo-atomic-dir-async-");
    const staging = path.join(dir, ".partial");
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, "manifest.json"), "{}");
    await holdOpen(path.join(staging, "manifest.json"), 600);

    await renameRetryingAsync(staging, path.join(dir, "2026-10-25"));

    expect(fs.readFileSync(path.join(dir, "2026-10-25", "manifest.json"), "utf8")).toBe("{}");
  });

  it.runIf(WINDOWS)("一直占着：重试用完照旧抛出原来的错误，临时文件删掉、原来的内容不动", async () => {
    const dir = makeTempDir("ergo-atomic-giveup-");
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, "旧的\n");
    await holdOpen(file, 5_000);

    expect(() => writeFileAtomic(file, "新的\n", { retries: 3, delayMs: 20 })).toThrow(expect.objectContaining({ code: "EPERM" }));
    await expect(writeFileAtomicAsync(file, "新的\n", { retries: 3, delayMs: 20 })).rejects.toMatchObject({ code: "EPERM" });

    expect(fs.readFileSync(file, "utf8")).toBe("旧的\n");
    expect(leftovers(dir, ["settings.json"])).toEqual([]);
  });

  it("不是被占着的错误（来源不在）不重试，马上抛出", async () => {
    const dir = makeTempDir("ergo-atomic-enoent-");
    const started = Date.now();
    expect(() => renameRetrying(path.join(dir, "missing.tmp"), path.join(dir, "x"))).toThrow(expect.objectContaining({ code: "ENOENT" }));
    await expect(renameRetryingAsync(path.join(dir, "missing.tmp"), path.join(dir, "x"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(Date.now() - started).toBeLessThan(100);
  });
});
