// 组件的几样检测（323 号票）：这台电脑有没有 N 卡（挑 CUDA 版还是 CPU 版）、清单里 detect 写的检测到没有
// （on-path:<程序>：PATH 上有这个程序，比如 claude）、provided 写的别处是不是已经有了（voice-recognizer、voice-speech：配置里的识别程序、
// 合成服务；node-package:<包名>：程序目录的 node_modules 里解析得到这个包，比如随程序装好的 Claude Code SDK）。
// 要查的程序名、包名写在清单里（数据），这里只认这几种写法。
// 都便宜（不联网、不跑模型）：N 卡问一次 nvidia-smi 记住；别的每次取清单时现看。测试换成假的。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { t } from "@ergo/protocol";
import type { ErgoConfig } from "../config/config.ts";

export interface ComponentProbes {
  /** 这台电脑有没有 N 卡 */
  gpu(): "nvidia" | "none";
  /** detect 写的检测：检测到了回一句说明（给人看的），没有是 undefined */
  detect(id: string): string | undefined;
  /** provided 写的：别处已经有了回一句说明（给人看的），没有是 undefined */
  provided(id: string): string | undefined;
}

/**
 * 这个路径上有没有程序。Windows 的"应用执行别名"（WindowsApps 里商店版 Python 那种）stat 会被拒（EACCES）、
 * existsSync 回 false，可照样能运行——lstat 看得到它是个链接，也算有
 */
function programPresent(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    try {
      return fs.lstatSync(file).isSymbolicLink();
    } catch {
      return false;
    }
  }
}

/** 在 PATH 上找一个程序（Windows 按 PATHEXT 补扩展名）；找不到是 undefined */
export function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const exts = process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      if (programPresent(candidate)) return candidate;
    }
  }
  return undefined;
}

/** 一个包在不在程序目录的 node_modules 里（随程序装好的） */
function resolvable(specifier: string): boolean {
  try {
    import.meta.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

/** 正式的检测：按守护进程的配置和环境 */
export function createComponentProbes(options: { config: ErgoConfig; env: NodeJS.ProcessEnv }): ComponentProbes {
  let gpu: "nvidia" | "none" | undefined;
  return {
    gpu() {
      if (gpu === undefined) {
        const result = spawnSync("nvidia-smi", ["-L"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
        gpu = result.status === 0 && typeof result.stdout === "string" && /GPU \d+/.test(result.stdout) ? "nvidia" : "none";
      }
      return gpu;
    },
    detect(id) {
      if (id.startsWith("on-path:")) {
        const found = findOnPath(id.slice("on-path:".length), options.env);
        return found === undefined ? undefined : t("components.detect.found", { path: found });
      }
      return undefined;
    },
    provided(id) {
      const voice = options.config.voice;
      if (id.startsWith("node-package:")) {
        const name = id.slice("node-package:".length);
        return resolvable(name) ? t("components.provided.nodePackage", { name }) : undefined;
      }
      switch (id) {
        case "voice-recognizer": {
          // 经 LSM 托管的识别服务；或者守护进程自己拉起的 Python（配置写的路径在，或者 PATH 上找得到）
          if (voice.recognizer.mode === "lsm") return t("components.provided.recognizerLsm", { url: voice.recognizer.url });
          const python = voice.recognizer.python;
          const found = /[\\/]/.test(python) ? (programPresent(python) ? python : undefined) : findOnPath(python, options.env);
          return found === undefined ? undefined : t("components.provided.recognizerPython", { python: found });
        }
        case "voice-speech":
          return t("components.provided.speechService", { url: voice.speech.url });
        default:
          return undefined;
      }
    },
  };
}
