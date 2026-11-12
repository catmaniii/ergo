// N 卡的驱动和显卡型号：语音程序（audio.cpp）挑哪一版（351）。
// audio.cpp v0.9.3 的 Windows 显卡版有两份，要求不一样（上游 docs/build/windows.md、release.yml 的 CMAKE_CUDA_ARCHITECTURES）：
// - CUDA 13.3（清单里的 cuda）：小一些；显卡算力 7.5 起（RTX 20 系、GTX 16 系往后），驱动 580 或更新（上游写的）；
// - CUDA 12.4（cuda12）：大约多 210 MB；算力 6.1 起（GTX 10 系也行：只带了 6.1 的 PTX，要驱动现编译），
//   驱动按 CUDA 12.4.1 自己要的 551.78 算——比 12.x 兼容模式的 528.33 严，但老卡现编译 PTX 本来就要它，一条线最稳；
// - 都用不上（驱动太旧、显卡太老、查不到）走 CPU 版，组件页写明为什么、怎么办。
// 要求写在这里、按版本的 id 认，不写进清单的 when：老版本的二狗查更新时也读新清单，when 多一个字段整份清单就不认了，
// 连 Claude Code 这些组件的更新都查不到。换 audio.cpp 版本时对一下这张表。
// 驱动版本、算力按 nvidia-smi 查（probes.ts，只读、问一次记住）；几块卡取算力最低的那块（最稳）。
import { t } from "@ergo/protocol";

/** nvidia-smi 查到的：显卡型号、驱动版本、算力（compute capability，比如 8.9）；查不到的那项没有 */
export interface NvidiaInfo {
  name?: string;
  driver?: string;
  computeCapability?: string;
}

/** 一份 CUDA 版要什么 */
export interface CudaBuild {
  /** CUDA 的版本（给人看） */
  cuda: string;
  minDriver: string;
  minComputeCapability: string;
}

/** 清单里 audio.cpp 的显卡版（按版本 id）各要什么 */
export const CUDA_BUILDS: Readonly<Record<string, CudaBuild>> = {
  cuda: { cuda: "13.3", minDriver: "580", minComputeCapability: "7.5" },
  cuda12: { cuda: "12.4", minDriver: "551.78", minComputeCapability: "6.1" },
};

const VERSION = /^\d+(?:\.\d+)*$/;

/** 点分的版本号 have ≥ need（按段比数字：610.88 ≥ 580，12.0 ≥ 8.9） */
export function atLeast(have: string, need: string): boolean {
  const a = have.split(".").map(Number);
  const b = need.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** nvidia-smi 的一格：[N/A]、[Not Supported] 这些算没有 */
const cell = (raw: string | undefined): string | undefined => {
  const value = raw?.trim();
  return value && !value.startsWith("[") ? value : undefined;
};

/**
 * 读 `nvidia-smi --query-gpu=name,driver_version[,compute_cap] --format=csv,noheader` 的输出，一行一块卡。
 * 型号里万一有逗号：驱动、算力从右边数
 */
export function parseNvidiaSmi(stdout: string, withCapability: boolean): NvidiaInfo[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const cells = line.split(",");
      const capability = withCapability ? cell(cells.pop()) : undefined;
      const driver = cell(cells.pop());
      const name = cell(cells.join(","));
      return {
        ...(name !== undefined ? { name } : {}),
        ...(driver !== undefined && VERSION.test(driver) ? { driver } : {}),
        ...(capability !== undefined && VERSION.test(capability) ? { computeCapability: capability } : {}),
      };
    });
}

/** 几块卡合成一份：型号写第一块的，驱动是同一个，算力取最低的那块 */
export function summarizeGpus(gpus: readonly NvidiaInfo[]): NvidiaInfo | undefined {
  if (gpus.length === 0) return undefined;
  const name = gpus.find((g) => g.name !== undefined)?.name;
  const driver = gpus.find((g) => g.driver !== undefined)?.driver;
  const capabilities = gpus.flatMap((g) => (g.computeCapability === undefined ? [] : [g.computeCapability]));
  const lowest = capabilities.reduce<string | undefined>((low, c) => (low === undefined || atLeast(low, c) ? c : low), undefined);
  return { ...(name !== undefined ? { name } : {}), ...(driver !== undefined ? { driver } : {}), ...(lowest !== undefined ? { computeCapability: lowest } : {}) };
}

/** 这份显卡版为什么用不了：查不到、显卡太老、驱动太旧（先看显卡：显卡太老更新驱动也没用） */
export type CudaMiss = { why: "unknown" } | { why: "gpu"; need: string } | { why: "driver"; driver: string; need: string };

/** 这一版（按 id）在这台电脑的 N 卡上用不用得了：不是表里的显卡版、用得了是 undefined */
export function cudaMiss(variantId: string, info: NvidiaInfo | undefined): CudaMiss | undefined {
  const build = CUDA_BUILDS[variantId];
  if (!build) return undefined;
  if (info?.driver === undefined || info.computeCapability === undefined) return { why: "unknown" };
  if (!atLeast(info.computeCapability, build.minComputeCapability)) return { why: "gpu", need: build.minComputeCapability };
  if (!atLeast(info.driver, build.minDriver)) return { why: "driver", driver: info.driver, need: build.minDriver };
  return undefined;
}

/** 给人看的显卡：型号，没查到就是"这块显卡" */
const gpuName = (info: NvidiaInfo | undefined) => info?.name ?? t("components.variant.thisGpu");

/**
 * 挑中的这一版为什么是它（组件页"用哪一版"那一行括号里的话）。
 * - 没有 N 卡：没找到 N 卡；
 * - 用的是最好的显卡版：有 N 卡（和驱动版本）；
 * - 用的是次一些的显卡版：最好的那份为什么用不了（驱动低于多少、显卡太老）；
 * - 有 N 卡却只能用 CPU 版：最低的那份显卡版为什么也用不了，会很慢、怎么办；
 * 清单里没有显卡版的组件（模型）不说。titleOf 是版本 id → 名字（CUDA 13.3 版）
 */
export function variantReason(options: {
  /** 这台电脑能用的几版（平台对得上的），按清单的先后 */
  variants: readonly { id: string; when?: { gpu?: "nvidia" | "none" } }[];
  picked: { id: string; when?: { gpu?: "nvidia" | "none" } };
  gpu: "nvidia" | "none";
  nvidia?: NvidiaInfo | undefined;
  titleOf: (id: string) => string;
}): string | undefined {
  const { variants, picked, gpu, nvidia, titleOf } = options;
  const gpuVariants = variants.filter((v) => v.when?.gpu === "nvidia");
  if (gpuVariants.length === 0) return undefined;
  if (gpu !== "nvidia") return t("components.variant.reason.noNvidia");
  const best = gpuVariants[0]!;
  if (picked.id === best.id) return nvidia?.driver === undefined ? t("components.variant.reason.nvidia") : t("components.variant.reason.nvidiaDriver", { driver: nvidia.driver });
  if (picked.when?.gpu === "nvidia") {
    // 次一些的显卡版：说最好的那份为什么用不了
    const miss = cudaMiss(best.id, nvidia);
    if (miss?.why === "gpu") return t("components.variant.reason.gpuOlder", { gpu: gpuName(nvidia), better: titleOf(best.id) });
    if (miss?.why === "driver") return t("components.variant.reason.driverOlder", { driver: miss.driver, better: titleOf(best.id), need: miss.need });
    return t("components.variant.reason.nvidia");
  }
  // 有 N 卡却是 CPU 版：要求最低的那份显卡版也用不了
  const miss = cudaMiss(gpuVariants.at(-1)!.id, nvidia);
  if (miss?.why === "gpu") return t("components.variant.reason.gpuTooOld", { gpu: gpuName(nvidia) });
  if (miss?.why === "driver") return t("components.variant.reason.driverTooOld", { driver: miss.driver, need: miss.need });
  return t("components.variant.reason.nvidiaUnknown");
}
