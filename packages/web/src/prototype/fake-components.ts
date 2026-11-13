// 原型里的设置 · 组件：演示页没有守护进程，这里编清单里的五个组件看样子——
// 向量模型正在从 hf-mirror 下（每秒走一截，下完是装好了）；语音识别用的是自己配的（别处有，不能从这里装）；
// 语音合成的程序和模型默认是"已有自己配的、在用它"；Claude Code 接入检测到了、装好了；Codex 接入（454）从这里装好了（本机 PATH 上没有 codex）。
// 动作只改内存里的样子（装、暂停、继续、取消、删、启动、停止），从文件导入回"原型里不导入"那样的结果。
// 地址里带 ?demo-components-missing 时语音识别、语音合成都没有（别处也没有）：看功能灰掉的样子（输入框的话筒、设置 · 语音）。
// 地址里带 ?demo-tts=missing|installing|running|stopped|failed|manual|download-failed|runtime-missing 看语音合成的几种状态；带 ?demo-gpu=none 看没有 N 卡的样子，
// ?demo-gpu=old 是驱动低于 580（用 CUDA 12.4 版），?demo-gpu=too-old 是驱动太旧只能用 CPU 版（351）；?demo-user=chinese 是 Windows 用户名是中文、语音组件装到 ProgramData 下的样子。
// 地址里带 ?demo-asr=missing|installing|running|configured|external 看语音识别的几种状态（configured 是配了自己的语音识别，external 是 8090 上已有自己配的 audio.cpp）。
// 向导的"能力"那一步、检查更新：?demo-bge=missing|failed 看向量模型没装、下载失败的样子；?demo-fail=tts 点了装就失败（看失败能跳过）；
// ?demo-updates=available|failed|not-published 看查更新的几种结果（available 时点"检查更新"向量模型有新版本，failed 时写没查成，not-published 是发布页上还没有清单）；?demo-autostart=off|elsewhere|dev 看开机自启的样子。
// ?demo-codex=missing|path 看 Codex 接入没装（插件也就没装上、新建时灰着）、本机 PATH 上已有自己装的 codex 的样子（不给是从这里装好了，插件页写登录的完整命令）。
import { type AutostartView, type ComponentAction, type ComponentImportResult, type ComponentServiceState, type ComponentsView, type ComponentView, nowIso } from "../state/index.ts";
import { demoParam } from "./fake-connection.ts";

const MB = 1024 * 1024;
const BGE_SIZE = 770 + 1173 + 17_082_821 + 569_694_530;
const SDK_SIZE = 1_599_938 + 117_726_124;
/** Codex 0.166.0：@openai/codex 和它的 win32-x64 平台包（大小是 npm registry 的，HEAD 拿的） */
const CODEX_SIZE = 4_992 + 180_706_795;
/** 解开后多大（registry 元数据的 unpackedSize 加起来） */
const CODEX_DISK = 13_570 + 502_654_591;
/** audio.cpp v0.9.3 的 Windows 包：CUDA 版是程序包 + 运行库包（13.3、12.4 两份），CPU 版一个包 */
const AUDIOCPP_CUDA_SIZE = 277_336_614 + 575_457_454;
const AUDIOCPP_CUDA12_SIZE = 465_913_709 + 607_273_675;
const AUDIOCPP_CPU_SIZE = 30_547_092;
const FISH_SIZE = 6_317_915_552;
const FUN_ASR_SIZE = 1_045_334_432;
/** 原型的下载速度（字节 / 秒） */
const SPEED = 6.4 * MB;
const SPEECH_PORT = 8090;

interface Sim {
  state: ComponentView["state"];
  done: number;
  /** 正在下时：从什么时候、多少字节起算 */
  since?: number;
  base?: number;
  /** 程序组件的运行状态 */
  service?: ComponentServiceState;
}

/** 这台电脑的显卡（?demo-gpu=none 没有 N 卡；old 驱动低于 580；too-old 驱动太旧；不给是新卡新驱动） */
function gpuScene(): "new" | "none" | "old" | "too-old" {
  const scene = demoParam("demo-gpu");
  return scene === "none" || scene === "old" || scene === "too-old" ? scene : "new";
}

/** 语音程序挑的那一版：版本和为什么、多大、要下的包、模型那一行写不写慢 */
function audiocppBuild(): { variant: NonNullable<ComponentView["variant"]>; size: number; files: string[]; slow?: string } {
  switch (gpuScene()) {
    case "none":
      return { variant: { id: "cpu", title: "CPU 版", reason: "这台电脑没找到 N 卡" }, size: AUDIOCPP_CPU_SIZE, files: ["audio-v0.9.3-bin-windows-x64-cpu.zip"], slow: "这台电脑没有 NVIDIA 显卡：也能用，但没有显卡会很慢" };
    case "too-old":
      return {
        variant: { id: "cpu", title: "CPU 版", reason: "显卡驱动 531.79 太旧，用显卡至少要 551.78：先用 CPU 版，会很慢。更新显卡驱动后这里会出现「更新」，点了换成显卡版" },
        size: AUDIOCPP_CPU_SIZE,
        files: ["audio-v0.9.3-bin-windows-x64-cpu.zip"],
        slow: "这台电脑的显卡用不上（原因看「语音程序 audio.cpp」那一行）：也能用，但会很慢",
      };
    case "old":
      return {
        variant: { id: "cuda12", title: "CUDA 12.4 版", reason: "显卡驱动是 566.36，CUDA 13.3 版要 580 或更新的驱动" },
        size: AUDIOCPP_CUDA12_SIZE,
        files: ["audio-v0.9.3-bin-windows-x64-cuda12.4.zip", "audio-v0.9.3-cudart-windows-x64-cuda12.4.zip"],
      };
    default:
      return { variant: { id: "cuda", title: "CUDA 13.3 版", reason: "这台电脑有 N 卡，驱动 610.88" }, size: AUDIOCPP_CUDA_SIZE, files: ["audio-v0.9.3-bin-windows-x64-cuda13.3.zip", "audio-v0.9.3-cudart-windows-x64-cuda13.3.zip"] };
  }
}

/** 包多大（下不下来时列的地址用） */
const PACKAGE_SIZES: Readonly<Record<string, number>> = {
  "audio-v0.9.3-bin-windows-x64-cpu.zip": AUDIOCPP_CPU_SIZE,
  "audio-v0.9.3-bin-windows-x64-cuda13.3.zip": 277_336_614,
  "audio-v0.9.3-cudart-windows-x64-cuda13.3.zip": 575_457_454,
  "audio-v0.9.3-bin-windows-x64-cuda12.4.zip": 465_913_709,
  "audio-v0.9.3-cudart-windows-x64-cuda12.4.zip": 607_273_675,
};

/** 编的中文用户名：英文的演示里换成带声调的拼音（也不是纯英文，audio.cpp 一样读不了） */
const DEMO_CHINESE_USER = "张三";

/** 语音组件装在哪：用户名是中文时（?demo-user=chinese）装到 ProgramData 下，写为什么 */
function voiceLocation(id: string): Pick<ComponentView, "location" | "locationNote"> {
  if (demoParam("demo-user") !== "chinese") return { location: `C:\\Users\\me\\.ergo\\components\\${id}` };
  return {
    location: `C:\\ProgramData\\ergo\\1a2b3c4d\\components\\${id}`,
    locationNote: `数据目录 C:\\Users\\${DEMO_CHINESE_USER}\\.ergo\\components 的路径里有 audio.cpp 读不了的字（比如中文），语音程序和模型装在这里`,
  };
}

/** Codex 是哪种样子（?demo-codex=missing|path；不给是从组件页装好了）：组件页、插件页、运行时、体检都照它 */
export function codexDemo(): "component" | "missing" | "path" {
  const scene = demoParam("demo-codex");
  return scene === "missing" || scene === "path" ? scene : "component";
}

/** 原型里组件装的 codex 登录要运行的完整命令（守护进程 codex/install.ts 的 codexLoginCommand 那种写法） */
export const FAKE_CODEX_LOGIN = "& 'C:\\Users\\me\\AppData\\Local\\Programs\\ergo\\versions\\0.4.4\\node\\node.exe' 'C:\\Users\\me\\.ergo\\components\\codex\\node_modules\\@openai\\codex\\bin\\codex.js' login";

/** 编的组件（字是守护进程按语言写好交来的那种，原型里只编中文的） */
function base(): Omit<ComponentView, "state">[] {
  const build = audiocppBuild();
  return [
    {
      id: "bge-m3",
      title: "向量模型 bge-m3",
      summary: "记忆按意思找素材用的模型（量化版，用 CPU）。没装时素材照常存、按关键词也能找。",
      version: "4de13258",
      default: "install",
      defaultText: "默认装",
      wanted: true,
      variant: { id: "q8", title: "q8 量化版" },
      size: BGE_SIZE,
      enables: [{ id: "memory.semantic", title: "按意思检索素材" }],
      dependsOn: [],
      sources: ["Hugging Face", "hf-mirror", "ModelScope"],
      location: "C:\\Users\\me\\.ergo\\models\\Xenova\\bge-m3",
    },
    {
      id: "asr",
      title: "语音识别模型 Fun-ASR Nano",
      summary: "按住说话时把语音转成文字（模型在本机跑，从上游下载，二狗不打包；不用装 Python）。",
      version: "ce72677f",
      default: "ask",
      defaultText: "问了再装",
      wanted: false,
      variant: { id: "q8", title: "q8 量化版" },
      size: FUN_ASR_SIZE,
      enables: [{ id: "voice.input", title: "按住说话" }],
      dependsOn: ["audiocpp"],
      sources: ["Hugging Face", "hf-mirror"],
      ...voiceLocation("asr"),
      recommended: true,
      license: {
        name: "FunASR Model License v1.1",
        summary: "可以免费使用、修改、分享，要注明来源和作者、保留模型名；原文写着仅作参考和学习、不担保，商业使用没有单独条款，请自己判断",
        url: "https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE",
        confirm: true,
        accepted: false,
        attribution: "Fun-ASR-Nano-2512 · FunAudioLLM / Alibaba Group",
      },
      providedBy: "已有自己配的语音识别，在用它（服务管家托管的识别服务 http://127.0.0.1:8091）",
    },
    {
      id: "audiocpp",
      title: "语音程序 audio.cpp",
      summary: "语音回复、语音识别要用的本机服务（开源的 audio.cpp）。模型是单独的组件，装模型时会先装它。",
      version: "0.9.3",
      default: "ask",
      defaultText: "问了再装",
      wanted: false,
      variant: build.variant,
      size: build.size,
      enables: [],
      dependsOn: [],
      sources: ["GitHub"],
      ...voiceLocation("audiocpp"),
      license: { name: "Apache-2.0", summary: "开源，可以免费使用", url: "https://github.com/0xShug0/audio.cpp/blob/v0.9.3/LICENSE", confirm: false, accepted: true },
      providedBy: `已有自己配的语音合成，在用它（http://127.0.0.1:${SPEECH_PORT}）`,
    },
    {
      id: "tts",
      title: "语音合成模型 Fish S2 Pro",
      summary: "你发语音时二狗用语音回你（模型在本机跑，从上游下载，二狗不打包）。",
      version: "874fcb41",
      default: "ask",
      defaultText: "问了再装",
      wanted: false,
      variant: { id: "q8", title: "q8 量化版" },
      size: FISH_SIZE,
      enables: [{ id: "voice.reply", title: "用语音回复" }],
      dependsOn: ["audiocpp"],
      sources: ["Hugging Face", "hf-mirror"],
      ...voiceLocation("tts"),
      recommended: true,
      ...(build.slow ? { note: build.slow } : {}),
      license: {
        name: "Fish Audio Research License",
        summary: "个人非商业免费；商业使用要另外向 Fish Audio 取得授权",
        url: "https://huggingface.co/fishaudio/s2-pro/blob/main/LICENSE.md",
        confirm: true,
        accepted: false,
        attribution: "Built with Fish Audio",
      },
      providedBy: `已有自己配的语音合成，在用它（http://127.0.0.1:${SPEECH_PORT}）`,
    },
    {
      id: "claude-code",
      title: "Claude Code 接入",
      summary: "让任务、项目可以交给 Claude Code 做（官方的 SDK，从 npm 官方下载）。",
      version: "0.3.296",
      default: "detected",
      defaultText: "本机装了 Claude Code 才装",
      wanted: true,
      detectedText: "检测到了：C:\\Users\\me\\.local\\bin\\claude.exe",
      variant: { id: "win32-x64", title: "Windows x64" },
      size: SDK_SIZE,
      enables: [{ id: "runtime.claude-code", title: "用 Claude Code 做任务" }],
      dependsOn: [],
      sources: ["npm"],
      location: "C:\\Users\\me\\.ergo\\components\\claude-code",
    },
    {
      id: "codex",
      title: "Codex 接入",
      summary: "让任务、项目可以交给 Codex 做（OpenAI 的开源命令行程序，从 npm 官方下载；登录用你自己的 Codex 账号，二狗不碰）。",
      version: "0.166.0",
      default: "detected",
      defaultText: "本机装了 Codex 才装",
      wanted: codexDemo() === "path",
      detectedText: codexDemo() === "path" ? "检测到了：C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd" : "没检测到",
      variant: { id: "win32-x64", title: "Windows x64" },
      size: CODEX_SIZE,
      enables: [{ id: "runtime.codex", title: "用 Codex 做任务" }],
      dependsOn: [],
      sources: ["npm"],
      location: "C:\\Users\\me\\.ergo\\components\\codex",
      license: { name: "Apache-2.0", summary: "开源（Apache-2.0），可以免费使用", url: "https://github.com/openai/codex/blob/rust-v0.166.0/LICENSE", confirm: false, accepted: false },
      providedBy: "本机已经装了 Codex 0.170.2，在用它（C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js）",
    },
  ];
}

/** 语音合成那两个组件一开始的样子 */
function speechStart(): { audiocpp: Sim; tts: Sim } {
  const scene = demoParam("demo-tts") ?? (demoParam("demo-components-missing") === null ? "manual" : "missing");
  switch (scene) {
    case "installing":
      return { audiocpp: { state: "installed", done: 0, service: "idle" }, tts: { state: "downloading", done: Math.round(FISH_SIZE * 0.38), since: Date.now(), base: Math.round(FISH_SIZE * 0.38) } };
    case "running":
    case "runtime-missing":
      return { audiocpp: { state: "installed", done: 0, service: "running" }, tts: { state: "installed", done: 0 } };
    case "stopped":
      return { audiocpp: { state: "installed", done: 0, service: "stopped" }, tts: { state: "installed", done: 0 } };
    case "failed":
      return { audiocpp: { state: "installed", done: 0, service: "failed" }, tts: { state: "installed", done: 0 } };
    case "missing":
      return { audiocpp: { state: "missing", done: 0 }, tts: { state: "missing", done: 0 } };
    case "download-failed":
      return { audiocpp: { state: "failed", done: 0 }, tts: { state: "failed", done: 0 } };
    default:
      return { audiocpp: { state: "provided", done: 0 }, tts: { state: "provided", done: 0 } };
  }
}

/** 语音识别模型一开始的样子，和这种样子下程序组件的样子（没有就照语音合成的） */
function recognizerStart(): { asr: Sim; audiocpp?: Sim } {
  switch (demoParam("demo-asr") ?? (demoParam("demo-components-missing") === null ? "configured" : "missing")) {
    case "missing":
      return { asr: { state: "missing", done: 0 }, audiocpp: { state: "missing", done: 0 } };
    case "installing":
      return { asr: { state: "downloading", done: Math.round(FUN_ASR_SIZE * 0.42), since: Date.now(), base: Math.round(FUN_ASR_SIZE * 0.42) }, audiocpp: { state: "installed", done: 0, service: "idle" } };
    case "running":
      return { asr: { state: "installed", done: 0 }, audiocpp: { state: "installed", done: 0, service: "running" } };
    case "external":
      return { asr: { state: "missing", done: 0 }, audiocpp: { state: "provided", done: 0 } };
    default:
      return { asr: { state: "provided", done: 0 } };
  }
}

/** 开机自启一开始的样子 */
export function fakeAutostart(): AutostartView {
  const managerUrl = "http://127.0.0.1:7420";
  switch (demoParam("demo-autostart")) {
    case "off":
      return { state: "off", managerUrl };
    case "elsewhere":
      return { state: "elsewhere", cannotChange: "开机自启的任务指着别处的服务管家（不是这份二狗带的），这里不动它。要换成这一份，自己跑 ergo svc install-autostart", managerUrl };
    case "dev":
      return { state: "on", cannotChange: "这份二狗是从源码跑的，开机自启的任务不归它管。要改就自己跑 ergo svc install-autostart 或者 ergo svc uninstall-autostart", managerUrl };
    default:
      return { state: "on", managerUrl };
  }
}

/** 向量模型一开始的样子（默认正在下） */
function vectorStart(): Sim {
  switch (demoParam("demo-bge")) {
    case "missing":
      return { state: "missing", done: 0 };
    case "failed":
      return { state: "failed", done: Math.round(BGE_SIZE * 0.2) };
    case "installed":
      return { state: "installed", done: 0 };
    default:
      return { state: "downloading", done: Math.round(BGE_SIZE * 0.38), since: Date.now(), base: Math.round(BGE_SIZE * 0.38) };
  }
}

const UPDATE_WHERE = "https://github.com/catmaniii/ergo/releases/latest/download/components-manifest.json";

export class FakeComponents {
  /** 确认过许可的组件 */
  private readonly licenseAccepted = new Set<string>();
  /** 查更新的结果 */
  private updates: NonNullable<ComponentsView["updates"]> = { where: UPDATE_WHERE, available: [] };
  /** 查到有新版本的组件 → 新版本 */
  private readonly newer = new Map<string, string>();

  private readonly sims = new Map<string, Sim>([
    ["bge-m3", vectorStart()],
    ["asr", recognizerStart().asr],
    ["audiocpp", recognizerStart().audiocpp ?? speechStart().audiocpp],
    ["tts", speechStart().tts],
    ["claude-code", { state: "installed", done: 0 }],
    ["codex", { state: codexDemo() === "missing" ? "missing" : codexDemo() === "path" ? "provided" : "installed", done: 0 }],
  ]);

  private tick(): void {
    for (const [id, sim] of this.sims) {
      if (sim.state !== "downloading" || sim.since === undefined) continue;
      const size = base().find((c) => c.id === id)!.size;
      sim.done = Math.min(size, (sim.base ?? 0) + Math.round(((Date.now() - sim.since) / 1000) * SPEED));
      if (sim.done < size) continue;
      this.sims.set(id, { state: "installed", done: 0, ...(id === "audiocpp" ? { service: "idle" as const } : {}) });
      // 模型下好了：服务接上
      if (id === "tts" || id === "asr") this.sims.set("audiocpp", { state: "installed", done: 0, service: "running" });
    }
  }

  private build(): ComponentsView {
    this.tick();
    const components = base().map((c): ComponentView => {
      const sim = this.sims.get(c.id)!;
      const newer = this.newer.get(c.id);
      // 查到新版本的、还装着旧的：显示有新版本（点了"更新"才换）
      const shownState = newer !== undefined && sim.state === "installed" ? ("update" as const) : sim.state;
      const installed = shownState === "installed" || shownState === "update";
      const downloading = sim.state === "downloading";
      const { providedBy, cannotInstall, license, ...rest } = c;
      const manual = sim.state === "provided" && (c.id === "audiocpp" || c.id === "tts");
      const recognizerBlocked =
        c.id !== "asr"
          ? undefined
          : sim.state === "provided"
            ? "要改用这里装的，先撤掉自己配的（配置里的 voice.recognizer.mode、voice.recognizer.python）"
            : this.sims.get("audiocpp")?.state === "provided"
              ? "语音识别和语音合成用同一个 audio.cpp 服务，这里接不上你自己配的那个。可以在它上面自己加一个 id 为 asr 的模型，再把配置里的 voice.recognizer.mode 写成 audiocpp；要改用这里装的，先撤掉自己配的"
              : undefined;
      return {
        ...rest,
        ...(sim.state === "provided" && providedBy ? { providedBy } : {}),
        ...(cannotInstall ? { cannotInstall } : recognizerBlocked ? { cannotInstall: recognizerBlocked } : manual ? { cannotInstall: "要改用这里装的，先撤掉自己配的（服务管家里的登记、配置里的 voice.speech.url）" } : {}),
        ...(license ? { license: { ...license, accepted: license.accepted || this.licenseAccepted.has(c.id) || installed } } : {}),
        state: shownState,
        ...(newer !== undefined ? { version: newer } : {}),
        ...(installed ? { installedVersion: c.version, diskSize: c.id === "claude-code" ? 266_028_594 : c.id === "codex" ? CODEX_DISK : c.size } : {}),
        ...(sim.service
          ? {
              service: {
                state: sim.service,
                port: SPEECH_PORT,
                autostart: sim.service === "running" || sim.service === "stopped",
                ...(sim.service === "idle" ? { note: "还没有模型：装上语音合成或语音识别模型后自动启动" } : {}),
                ...(demoParam("demo-tts") === "runtime-missing"
                  ? { warning: "CUDA 运行库不全：C:\\Users\\me\\.ergo\\components\\audiocpp\\bin 里没有 cublas64_*.dll和cublasLt64_*.dll，语音合成可能起不来或者一用就报错。运行库包要和程序放在一起：删掉这个组件重新装，或者把 audio-v0.9.3-cudart-windows-x64-cuda13.3.zip 解到这个目录。" }
                  : {}),
                ...(sim.service === "failed" ? { error: `语音服务没接上（启动这一步：端口 ${SPEECH_PORT} 已被 node.exe (1234) 占着）。这次的登记和生成的配置都撤掉了，程序和模型留着，点重试不用重新下载。` } : {}),
              },
            }
          : {}),
        ...(sim.state === "failed" && c.id === "bge-m3" ? { error: "下不下来（Hugging Face、hf-mirror、ModelScope 都连不上）。下好的部分留着，点重试接着下" } : {}),
        ...(sim.state === "failed" && c.id === "audiocpp"
          ? {
              error: "下不下来（GitHub：连不上）。下好的部分留着，点重试接着下",
              manualDownload: audiocppBuild().files.map((name) => ({
                name,
                size: PACKAGE_SIZES[name] ?? 0,
                links: [{ title: "GitHub", url: `https://github.com/0xShug0/audio.cpp/releases/download/v0.9.3/${name}` }],
              })),
            }
          : sim.state === "failed" && c.id === "tts"
            ? { error: "要先装好语音程序 audio.cpp" }
            : {}),
        ...(downloading || sim.state === "paused"
          ? {
              progress: {
                phase: "downloading" as const,
                done: sim.done,
                total: c.size,
                ...(downloading ? { speed: SPEED, etaSeconds: Math.ceil((c.size - sim.done) / SPEED), source: "hf-mirror" } : {}),
              },
            }
          : {}),
      };
    });
    return {
      components,
      features: components.flatMap((c) => c.enables.map((f) => ({ feature: f.id, component: c.id, title: c.title, ready: c.state === "installed" || c.state === "update" || c.state === "provided" }))),
      manifest: { release: "0.4.5", signed: false },
      defaultsMissing: components.filter((c) => c.wanted && c.cannotInstall === undefined && (c.state === "missing" || c.state === "paused" || c.state === "failed")).map((c) => c.id),
      updates: { ...this.updates, available: components.filter((c) => c.state === "update").map((c) => c.id) },
    };
  }

  view(): Promise<ComponentsView> {
    return Promise.resolve(this.build());
  }

  act(id: string, action: ComponentAction, extra?: { licenseAccepted?: boolean }): Promise<ComponentsView> {
    this.tick();
    const sim = this.sims.get(id);
    if (!sim) return Promise.reject(new Error(`没有这个组件：${id}`));
    const start = () => {
      // 查到的新版本：换上了就不再是新版本（原型里不记版本，回到写"已装"）
      if (action === "update") this.newer.delete(id);
      if (demoParam("demo-fail") === id) this.sims.set(id, { state: "failed", done: 0 });
      else this.sims.set(id, { state: "downloading", done: sim.done, since: Date.now(), base: sim.done });
    };
    switch (action) {
      case "install":
      case "update":
      case "resume":
        if ((id === "tts" || id === "asr") && !this.licenseAccepted.has(id) && extra?.licenseAccepted !== true && sim.state !== "installed") return Promise.reject(new Error("要先确认许可才能下载"));
        if (id === "tts" || id === "asr") this.licenseAccepted.add(id);
        if (sim.state === "missing" || sim.state === "paused" || sim.state === "failed" || sim.state === "update" || sim.state === "provided" || (action === "update" && this.newer.has(id))) start();
        break;
      case "pause":
        if (sim.state === "downloading") this.sims.set(id, { state: "paused", done: sim.done });
        break;
      case "cancel":
        if (sim.state === "downloading" || sim.state === "paused" || sim.state === "failed") this.sims.set(id, { state: "missing", done: 0 });
        break;
      case "remove":
        this.sims.set(id, { state: "missing", done: 0 });
        if (id === "tts" || id === "asr") this.sims.set("audiocpp", { state: "installed", done: 0, service: "idle" });
        break;
      case "start":
        if (sim.service) this.sims.set(id, { ...sim, service: "running" });
        break;
      case "stop":
        if (sim.service) this.sims.set(id, { ...sim, service: "stopped" });
        break;
    }
    return new Promise((resolve) => setTimeout(() => resolve(this.build()), 200));
  }

  installDefaults(): Promise<ComponentsView> {
    for (const id of this.build().defaultsMissing) {
      const sim = this.sims.get(id)!;
      this.sims.set(id, { state: "downloading", done: sim.done, since: Date.now(), base: sim.done });
    }
    return Promise.resolve(this.build());
  }

  /** 查更新：?demo-updates=available 向量模型有新版本、failed 没查成、not-published 发布页上还没有；不给是都最新。不下载、不换 */
  checkUpdates(): Promise<ComponentsView> {
    const scene = demoParam("demo-updates");
    this.updates = {
      where: UPDATE_WHERE,
      checkedAt: nowIso(),
      available: [],
      ...(scene === "failed" ? { error: "连不上 github.com" } : {}),
      ...(scene === "not-published" ? { notPublished: true as const } : {}),
    };
    if (scene === "available") {
      if (this.sims.get("bge-m3")?.state !== "installed") this.sims.set("bge-m3", { state: "installed", done: 0 });
      this.newer.set("bge-m3", "5ef24369");
    }
    return new Promise((resolve) => setTimeout(() => resolve(this.build()), 400));
  }

  importFrom(path: string): Promise<ComponentImportResult> {
    const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
    return new Promise((resolve) => setTimeout(() => resolve({ installed: [], matched: [], unknown: [name], missing: [], view: this.build() }), 300));
  }
}
