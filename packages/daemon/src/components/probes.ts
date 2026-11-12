// 组件的几样检测：这台电脑有没有 N 卡（挑 CUDA 版还是 CPU 版）、清单里 detect 写的检测到没有
// （on-path:<程序>：PATH 上有这个程序，比如 claude）、provided 写的别处是不是已经有了（voice-recognizer：用户自己配的语音识别，见下；
// voice-speech：用户自己配的合成服务，由 audiocpp-host.ts 现探、这里只取结果；node-package:<包名>：程序目录的 node_modules
// 里解析得到这个包，比如随程序装好的 Claude Code SDK；codex-cli：PATH 上有用户自己装的、版本够的 codex——找法和版本线是 Codex 插件的，
// 从它的 api.ts 拿：npm 装的读包里的 package.json，codex.exe 跑一次 --version，按文件缓存）。
// 语音识别能从组件页装了，"自己配的"要看得准，不然 PATH 上随便有个 Python 就装不了：
// LSM 模式、写了 audiocpp 模式、配置里写了 Python（路径在）都算；默认的 python 要 PATH 上有、而且装了 faster-whisper 才算（问一次记住）。
// 要查的程序名、包名写在清单里（数据），这里只认这几种写法。
// 都便宜（不联网、不跑模型）：N 卡问一次 nvidia-smi 记住（型号、驱动版本、算力，挑 audio.cpp 的哪一版用，见 nvidia.ts）；
// 别的每次取清单时现看。测试换成假的。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { t } from "@ergo/protocol";
import { codexOnPath } from "../codex/api.ts";
import { DEFAULT_VOICE_CONFIG, type ErgoConfig, isPlaceholder } from "../config/config.ts";
import { type NvidiaInfo, parseNvidiaSmi, summarizeGpus } from "./nvidia.ts";

export interface ComponentProbes {
  /** 这台电脑有没有 N 卡 */
  gpu(): "nvidia" | "none";
  /** N 卡的型号、驱动版本、算力（查不到的那项没有）；没有 N 卡、不给（测试）是 undefined */
  nvidia?(): NvidiaInfo | undefined;
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

/** 这个 Python 装了 faster-whisper 吗（只找包、不加载，很快；Windows 没装 Python 时的商店占位程序也回不是 0） */
function pythonHasFasterWhisper(python: string, env: NodeJS.ProcessEnv): boolean {
  const result = spawnSync(python, ["-c", "import importlib.util as u, sys; sys.exit(0 if u.find_spec('faster_whisper') else 1)"], { env, stdio: "ignore", windowsHide: true, timeout: 5000 });
  return result.status === 0;
}

/** nvidia-smi 在哪：PATH 上的；Windows 上老驱动装在 Program Files 的 NVSMI 下、不在 PATH 上 */
function nvidiaSmiCommands(env: NodeJS.ProcessEnv): string[] {
  const commands = ["nvidia-smi"];
  if (process.platform === "win32") {
    const old = path.join(env.ProgramFiles ?? env.PROGRAMFILES ?? "C:\\Program Files", "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe");
    if (programPresent(old)) commands.push(old);
  }
  return commands;
}

/**
 * 问 nvidia-smi：先连算力一起问（老驱动的 nvidia-smi 不认 compute_cap，整条失败），不行只问型号和驱动，再不行只看有没有卡（-L）。
 * 没有 N 卡是 undefined；有卡但别的都查不到是 {}
 */
export function queryNvidia(env: NodeJS.ProcessEnv, run: (command: string, args: string[]) => { status: number | null; stdout: string; missing: boolean } = runQuiet): NvidiaInfo | undefined {
  for (const command of nvidiaSmiCommands(env)) {
    const full = run(command, ["--query-gpu=name,driver_version,compute_cap", "--format=csv,noheader"]);
    if (full.missing) continue;
    if (full.status === 0) {
      const info = summarizeGpus(parseNvidiaSmi(full.stdout, true));
      if (info) return info;
    }
    const basic = run(command, ["--query-gpu=name,driver_version", "--format=csv,noheader"]);
    if (basic.status === 0) {
      const info = summarizeGpus(parseNvidiaSmi(basic.stdout, false));
      if (info) return info;
    }
    const list = run(command, ["-L"]);
    if (list.status === 0 && /GPU \d+/.test(list.stdout)) return {};
  }
  return undefined;
}

function runQuiet(command: string, args: string[]): { status: number | null; stdout: string; missing: boolean } {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 5000 });
  return { status: result.status, stdout: typeof result.stdout === "string" ? result.stdout : "", missing: (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" };
}

/** 正式的检测：按守护进程的配置和环境 */
export function createComponentProbes(options: { config: ErgoConfig; env: NodeJS.ProcessEnv; speechProvided?: () => string | undefined; hasFasterWhisper?: (python: string) => boolean }): ComponentProbes {
  /** 问过 nvidia-smi 了：null 是没有 N 卡 */
  let nvidia: NvidiaInfo | null | undefined;
  const nvidiaInfo = (): NvidiaInfo | undefined => {
    if (nvidia === undefined) nvidia = queryNvidia(options.env) ?? null;
    return nvidia ?? undefined;
  };
  const fasterWhisper = new Map<string, boolean>();
  const hasFasterWhisper = (python: string): boolean => {
    let known = fasterWhisper.get(python);
    if (known === undefined) {
      known = options.hasFasterWhisper ? options.hasFasterWhisper(python) : pythonHasFasterWhisper(python, options.env);
      fasterWhisper.set(python, known);
    }
    return known;
  };
  return {
    gpu() {
      return nvidiaInfo() === undefined ? "none" : "nvidia";
    },
    nvidia: nvidiaInfo,
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
          // 经 LSM 托管的识别服务；写了 audiocpp（组件页装的那条在 service.ts 里算"装好了"，走不到这句话）；
          // 或者守护进程自己拉起的 Python：配置写的路径在、PATH 上找得到；默认的 python 还要真的装了 faster-whisper
          if (voice.recognizer.mode === "lsm") return t("components.provided.recognizerLsm", { url: voice.recognizer.url });
          if (voice.recognizer.mode === "audiocpp") return t("components.provided.recognizerAudiocpp", { url: voice.speech.url });
          const python = voice.recognizer.python;
          if (isPlaceholder(python)) return undefined;
          const found = /[\\/]/.test(python) ? (programPresent(python) ? python : undefined) : findOnPath(python, options.env);
          if (found === undefined) return undefined;
          if (python === DEFAULT_VOICE_CONFIG.recognizer.python && !hasFasterWhisper(found)) return undefined;
          return t("components.provided.recognizerPython", { python: found });
        }
        case "voice-speech":
          return options.speechProvided?.();
        case "codex-cli": {
          const found = codexOnPath(options.env);
          return found === undefined ? undefined : t("components.provided.codexCli", { version: found.version, path: found.where });
        }
        default:
          return undefined;
      }
    },
  };
}
