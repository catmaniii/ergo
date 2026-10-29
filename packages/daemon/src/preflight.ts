// 起动前的两项检查（315 号票，给第一次装二狗的人）：在装组合根之前做，不对就一句话说清、不启动，不是一堆报错。
// - 只支持 Windows（Job 对象、目录联接、Windows 沙箱、LSM 都只在 Windows 上）：别的系统上一句话说明不支持；
// - Node 版本（ADR-0031：大版本跟着 pi 走，最低要求写在 packages/daemon/package.json 的 engines）：比最低要求旧的不启动、说该装哪个；
//   比测过的大版本新的照常启动、记一句提醒（pi 联网那一层没在那一版上测过）。
// 比 22.18 还旧的 Node 读不了 .ts 入口（没有类型剥离），走不到这里——那种情况靠安装时的检查（318 号票）和 npm 的 engines 提示。
// 这里只用 Node 自带的模块：入口（main.ts）先做完这两项，再按需加载组合根（daemon.ts 会加载 koffi 这类只在 Windows 上能用的东西）。
// @i18n-ignore-file log：起动日志（LSM 里看）；这时用户选的语言还没加载
import fs from "node:fs";

/** packages/daemon/package.json 的 engines.node（如 ">=22.19.0"） */
export function enginesNode(): string {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { engines?: { node?: string } };
  const range = pkg.engines?.node;
  if (!range) throw new Error("packages/daemon/package.json 里没写 engines.node");
  return range;
}

/** 版本号里的数字（"v22.23.4"、"22.19.0" → [22, 23, 4]）；认不出的是 undefined */
function versionParts(version: string): [number, number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

const PLATFORM_NAMES: Readonly<Record<string, string>> = { darwin: "macOS", linux: "Linux", freebsd: "FreeBSD", openbsd: "OpenBSD", sunos: "SunOS", aix: "AIX" };

/** 不是 Windows 时的那一句；是 Windows 是 undefined */
export function platformProblem(platform: string): string | undefined {
  if (platform === "win32") return undefined;
  const name = PLATFORM_NAMES[platform] ?? platform;
  return `二狗现在只支持 Windows（10 / 11），这台电脑是 ${name}，不启动（ergo only runs on Windows for now）。`;
}

export interface NodeVersionCheck {
  /** 不能用：一句话说清该装哪个（不启动） */
  problem?: string;
  /** 能用，但比测过的大版本新：提醒一句（照常启动） */
  note?: string;
}

/**
 * Node 版本对不对：range 是 engines.node（">=22.19.0" 这种写法；最低要求的大版本就是测过的大版本，ADR-0031：pi 用哪个大版本测，我们用哪个）
 */
export function checkNodeVersion(version: string, range: string): NodeVersionCheck {
  const min = /^>=\s*v?(\d+\.\d+\.\d+)\s*$/.exec(range)?.[1];
  const minParts = min ? versionParts(min) : undefined;
  if (!min || !minParts) throw new Error(`engines.node 的写法认不出（要写成 ">=22.19.0" 这样）：${range}`);
  const tested = minParts[0];
  const latest = `https://nodejs.org/dist/latest-v${tested}.x/`;
  const actual = versionParts(version);
  if (!actual || compare(actual, minParts) < 0) {
    return {
      problem: `Node 版本不够：二狗要 Node ${min} 或更新的 ${tested}.x（大版本跟着 pi 走，见 ADR-0031），这台是 ${version}，不启动。装 Node ${tested} 的最新版：${latest}（ergo needs Node >= ${min}）`,
    };
  }
  if (actual[0] > tested) return { note: `Node ${version} 比二狗测过的大版本（${tested}）新：照常启动，但 pi 联网那一层没在这一版上测过，出了怪问题先换回 Node ${tested} 的最新版（${latest}）` };
  return {};
}

/** 入口起动前的两项检查：不能启动时交回那一句，能启动时交回要记的提醒（没有是空的） */
export function preflight(platform: string, nodeVersion: string, range: string = enginesNode()): { problem?: string; notes: string[] } {
  const os = platformProblem(platform);
  if (os) return { problem: os, notes: [] };
  const node = checkNodeVersion(nodeVersion, range);
  if (node.problem) return { problem: node.problem, notes: [] };
  return { notes: node.note ? [node.note] : [] };
}
