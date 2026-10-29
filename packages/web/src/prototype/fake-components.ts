// 原型里的设置 · 组件（323 号票）：直接打开构建产物（file://）时没有守护进程，这里编清单里的四个组件看样子——
// 向量模型正在从 hf-mirror 下（每秒走一截，下完是装好了）；语音识别、语音合成用的是配置里的（别处有，这一版还不能从这里装）；
// Claude Code 接入检测到了、装好了。动作只改内存里的样子（装、暂停、继续、取消、删），从文件导入回"原型里不导入"那样的结果。
// 地址里带 ?demo-components-missing 时语音识别、语音合成都没有（别处也没有）：看功能灰掉的样子（输入框的话筒、设置 · 语音）。
import type { ComponentAction, ComponentImportResult, ComponentsView, ComponentView } from "../state/index.ts";
import { demoParam } from "./fake-connection.ts";

const MB = 1024 * 1024;
const BGE_SIZE = 770 + 1173 + 17_082_821 + 569_694_530;
const SDK_SIZE = 1_599_938 + 117_726_124;
/** 原型的下载速度（字节 / 秒） */
const SPEED = 6.4 * MB;

interface Sim {
  state: ComponentView["state"];
  done: number;
  /** 正在下时：从什么时候、多少字节起算 */
  since?: number;
  base?: number;
}

/** 编的组件（字是守护进程按语言写好交来的那种，原型里只编中文的） */
function base(): Omit<ComponentView, "state">[] {
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
      title: "语音识别",
      summary: "按住说话时把语音转成文字（faster-whisper，本机跑）。",
      version: "1",
      default: "ask",
      defaultText: "问了再装",
      wanted: false,
      variant: { id: "cuda", title: "CUDA 版", reason: "这台电脑有 N 卡" },
      size: 3_087_284_237 + 2394 + 340 + 2_480_617 + 1_068_114 + 483_546_902 + 2370 + 2_203_239 + 459_861,
      enables: [{ id: "voice.input", title: "按住说话" }],
      dependsOn: [],
      sources: ["Hugging Face", "hf-mirror"],
      location: "C:\\Users\\me\\.ergo\\components\\asr",
      providedBy: "用的是配置里的识别程序（C:\\Python311\\python.exe）",
      cannotInstall: "这一版还不能从这里装：Python 和 faster-whisper 那部分（用 uv 装）还没接上",
    },
    {
      id: "tts",
      title: "语音合成",
      summary: "你发语音时二狗用语音回你（audio.cpp，本机跑）。",
      version: "1",
      default: "ask",
      defaultText: "问了再装",
      wanted: false,
      variant: { id: "cuda", title: "CUDA 版", reason: "这台电脑有 N 卡" },
      size: 0,
      enables: [{ id: "voice.reply", title: "用语音回复" }],
      dependsOn: [],
      sources: [],
      location: "C:\\Users\\me\\.ergo\\components\\tts",
      providedBy: "用的是配置里的合成服务（http://127.0.0.1:8090）",
      cannotInstall: "这一版还不能从这里装：audio.cpp 的程序和模型还没接上",
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
  ];
}

export class FakeComponents {
  private readonly sims = new Map<string, Sim>([
    ["bge-m3", { state: "downloading", done: Math.round(BGE_SIZE * 0.38), since: Date.now(), base: Math.round(BGE_SIZE * 0.38) }],
    ["asr", { state: demoParam("demo-components-missing") === null ? "provided" : "missing", done: 0 }],
    ["tts", { state: demoParam("demo-components-missing") === null ? "provided" : "missing", done: 0 }],
    ["claude-code", { state: "installed", done: 0 }],
  ]);

  private tick(): void {
    for (const [id, sim] of this.sims) {
      if (sim.state !== "downloading" || sim.since === undefined) continue;
      const size = base().find((c) => c.id === id)!.size;
      sim.done = Math.min(size, (sim.base ?? 0) + Math.round(((Date.now() - sim.since) / 1000) * SPEED));
      if (sim.done >= size) this.sims.set(id, { state: "installed", done: 0 });
    }
  }

  private build(): ComponentsView {
    this.tick();
    const components = base().map((c): ComponentView => {
      const sim = this.sims.get(c.id)!;
      const installed = sim.state === "installed";
      const downloading = sim.state === "downloading";
      const { providedBy, ...rest } = c;
      return {
        ...rest,
        ...(sim.state === "provided" && providedBy ? { providedBy } : {}),
        state: sim.state,
        ...(installed ? { installedVersion: c.version, diskSize: c.id === "claude-code" ? 266_028_594 : c.size } : {}),
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
      manifest: { release: "0.2.1", signed: false },
      defaultsMissing: components.filter((c) => c.wanted && c.cannotInstall === undefined && (c.state === "missing" || c.state === "paused" || c.state === "failed")).map((c) => c.id),
    };
  }

  view(): Promise<ComponentsView> {
    return Promise.resolve(this.build());
  }

  act(id: string, action: ComponentAction): Promise<ComponentsView> {
    this.tick();
    const sim = this.sims.get(id);
    if (!sim) return Promise.reject(new Error(`没有这个组件：${id}`));
    const start = () => this.sims.set(id, { state: "downloading", done: sim.done, since: Date.now(), base: sim.done });
    switch (action) {
      case "install":
      case "update":
      case "resume":
        if (sim.state === "missing" || sim.state === "paused" || sim.state === "failed" || sim.state === "update" || sim.state === "provided") start();
        break;
      case "pause":
        if (sim.state === "downloading") this.sims.set(id, { state: "paused", done: sim.done });
        break;
      case "cancel":
        if (sim.state === "downloading" || sim.state === "paused" || sim.state === "failed") this.sims.set(id, { state: "missing", done: 0 });
        break;
      case "remove":
        this.sims.set(id, { state: (id === "asr" || id === "tts") && demoParam("demo-components-missing") === null ? "provided" : "missing", done: 0 });
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

  importFrom(path: string): Promise<ComponentImportResult> {
    const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
    return new Promise((resolve) => setTimeout(() => resolve({ installed: [], matched: [], unknown: [name], missing: [], view: this.build() }), 300));
  }
}
