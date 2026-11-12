// 设置 · 组件：页面上的几块用 React 在 Node 里渲染出来查——
// - 一个组件一块：名字和状况的小签、一句话；版本、大小、默认（检测到才装的写检测到了没有）、用哪一版、打开的功能、要先装的、下载地址、装在哪；
//   别处已经有了的写谁提供；这一版还不能从这里装的写原因、没有安装按钮；
// - 正在下：进度条、已下 / 一共、速度、还要多久、从哪个地址；按钮按状况给（暂停 / 取消、继续 / 取消、重试、删除、更新）；
// - 离线导入完说一句；还要多久的说法；
// - 灰掉的功能：清单说某个功能没法用时回要装的组件（还没取到清单、能用的不挡）。
// 设置列表里的位置见 settings-groups.test.ts；页面打得开见 page-opens.test.ts（原型里编的组件）。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { actionText, ComponentList, componentActions, componentLines, etaText, importText, LicenseConfirm, licenseSizeText, progressText } from "../../src/pages/more/ComponentsPage.tsx";
import { type ComponentsView, type ComponentView, missingComponentFor } from "../../src/state/index.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const noop = () => {};

function component(extra: Partial<ComponentView> = {}): ComponentView {
  return {
    id: "bge-m3",
    title: "向量模型 bge-m3",
    summary: "记忆按意思找素材用的模型",
    version: "4de13258",
    state: "missing",
    default: "install",
    defaultText: "默认装",
    wanted: true,
    variant: { id: "q8", title: "q8 量化版" },
    size: 586_779_294,
    enables: [{ id: "memory.semantic", title: "按意思检索素材" }],
    dependsOn: [],
    sources: ["Hugging Face", "hf-mirror", "ModelScope"],
    location: "C:\\data\\models\\Xenova\\bge-m3",
    ...extra,
  };
}

function view(components: ComponentView[]): ComponentsView {
  return {
    components,
    features: components.flatMap((c) => c.enables.map((f) => ({ feature: f.id, component: c.id, title: c.title, ready: c.state === "installed" || c.state === "provided" || c.state === "update" }))),
    manifest: { release: "0.1.0", signed: false },
    defaultsMissing: [],
  };
}

const render = (components: ComponentView[], over: { busy?: string; focused?: string } = {}) =>
  renderToStaticMarkup(createElement(ComponentList, { view: view(components), busy: over.busy, focused: over.focused, onAct: noop }));

describe("语音合成", () => {
  const fish = (extra: Partial<ComponentView> = {}) =>
    component({
      id: "tts",
      title: "语音合成模型 Fish S2 Pro",
      default: "ask",
      wanted: false,
      size: 6_317_915_552,
      dependsOn: ["audiocpp"],
      recommended: true,
      license: { name: "Fish Audio Research License", summary: "个人非商业免费；商业使用要另外向 Fish Audio 取得授权", url: "https://huggingface.co/fishaudio/s2-pro/blob/main/LICENSE.md", confirm: true, accepted: false, attribution: "Built with Fish Audio" },
      ...extra,
    });
  const program = (extra: Partial<ComponentView> = {}) => component({ id: "audiocpp", title: "语音合成程序 audio.cpp", default: "ask", wanted: false, size: 852_794_068, state: "installed", ...extra });

  test("模型这一行：推荐、许可名字带链接、那一句话、Built with Fish Audio；没有显卡时写明", () => {
    const html = render([fish({ note: "这台电脑没有 NVIDIA 显卡：也能用，但没有显卡会很慢" })]);
    expect(html).toContain(">推荐<");
    expect(html).toContain('href="https://huggingface.co/fishaudio/s2-pro/blob/main/LICENSE.md"');
    expect(html).toContain("Fish Audio Research License");
    expect(html).toContain("个人非商业免费；商业使用要另外向 Fish Audio 取得授权");
    expect(html).toContain('class="component-attribution">Built with Fish Audio<');
    expect(html).toContain("没有显卡会很慢");
    expect(html).toContain(">安装</button>");
  });

  test("程序：端口、开机自启、运行状态的小签；运行中有停止，没在运行有启动，没起来写原因、按钮是重试；启动中、还接不上没有启动", () => {
    const running = program({ service: { state: "running", port: 8090, autostart: true } });
    expect(componentLines(running, [running]).find((l) => l.key === "service")?.value).toBe("127.0.0.1:8090 · 开机自启");
    expect(componentActions(running)).toEqual(["stop", "remove"]);
    const runningHtml = render([running]);
    expect(runningHtml).toContain(">运行中<");
    expect(runningHtml).toContain(">停止</button>");
    expect(runningHtml).toMatch(/class="btn ghost small"[^>]*>停止/);

    const stopped = program({ service: { state: "stopped", port: 8090, autostart: true } });
    expect(componentActions(stopped)).toEqual(["start", "remove"]);
    expect(render([stopped])).toContain(">没在运行<");
    expect(render([stopped])).toContain(">启动</button>");

    const failed = program({ service: { state: "failed", port: 8090, autostart: false, error: "语音合成服务没接上（启动这一步：端口被占）" } });
    expect(componentActions(failed)).toEqual(["start", "remove"]);
    expect(actionText(failed, "start")).toBe("重试");
    const failedHtml = render([failed]);
    expect(failedHtml).toContain('class="field-error">语音合成服务没接上（启动这一步：端口被占）<');
    expect(failedHtml).toContain(">没起来<");

    expect(componentActions(program({ service: { state: "starting", port: 8090, autostart: false } }))).toEqual(["remove"]);
    const idle = program({ service: { state: "idle", port: 8090, autostart: false, note: "还没有模型：装上语音合成模型后自动启动" } });
    expect(componentActions(idle)).toEqual(["remove"]);
    expect(render([idle])).toContain("还没有模型");
    expect(componentActions(program({ state: "update", service: { state: "running", port: 8090, autostart: true } }))).toEqual(["update", "stop", "remove"]);
  });

  test("CUDA 运行库不全：在跑也写出来", () => {
    const html = render([program({ service: { state: "running", port: 8090, autostart: true, warning: "CUDA 运行库不全：C:\\x 里没有 cublas64_*.dll" } })]);
    expect(html).toContain(">运行中<");
    expect(html).toContain('class="field-error">CUDA 运行库不全：C:\\x 里没有 cublas64_*.dll<');
  });

  test("下载失败：列出还差的文件和下载地址、手动导入的办法；导入按钮打开现有的导入", () => {
    const failed = program({
      state: "failed",
      error: "下不下来（连不上）",
      manualDownload: [
        { name: "audio-v0.9.3-bin-windows-x64-cuda13.3.zip", size: 277_336_614, links: [{ title: "GitHub", url: "https://github.com/0xShug0/audio.cpp/releases/download/v0.9.3/audio-v0.9.3-bin-windows-x64-cuda13.3.zip" }] },
        { name: "audio-v0.9.3-cudart-windows-x64-cuda13.3.zip", size: 575_457_454, links: [{ title: "GitHub", url: "https://github.com/0xShug0/audio.cpp/releases/download/v0.9.3/audio-v0.9.3-cudart-windows-x64-cuda13.3.zip" }] },
      ],
    });
    const html = renderToStaticMarkup(createElement(ComponentList, { view: view([failed]), busy: undefined, focused: undefined, onAct: noop, onImport: noop }));
    expect(html).toContain('href="https://github.com/0xShug0/audio.cpp/releases/download/v0.9.3/audio-v0.9.3-bin-windows-x64-cuda13.3.zip"');
    expect(html).toContain('href="https://github.com/0xShug0/audio.cpp/releases/download/v0.9.3/audio-v0.9.3-cudart-windows-x64-cuda13.3.zip"');
    expect(html).toContain("audio-v0.9.3-bin-windows-x64-cuda13.3.zip（264.5 MB）");
    expect(html).toContain("从文件导入…");
    expect(html).toContain("校验对得上就装上");
    expect(render([program()])).not.toContain("component-manual");
  });

  test("已有自己配的：写在用它，没有安装按钮", () => {
    const manual = fish({ state: "provided", providedBy: "已有自己配的语音合成，在用它（http://127.0.0.1:8090）", cannotInstall: "要改用这里装的，先撤掉自己配的" });
    expect(componentActions(manual)).toEqual([]);
    const html = render([manual]);
    expect(html).toContain("已有自己配的语音合成，在用它（http://127.0.0.1:8090）");
    expect(html).toContain("要改用这里装的，先撤掉自己配的");
    expect(html).not.toContain("<button");
  });

  test("确认框：名字、大小（6.3 GB，Windows 里的数字也写上）、许可、那一句话、原文链接；要先下的程序写明；同意才下载", () => {
    const c = fish();
    const needed = program({ state: "missing" });
    const html = renderToStaticMarkup(createElement(LicenseConfirm, { component: c, all: [needed, c], onCancel: noop, onConfirm: noop }));
    expect(html).toContain("语音合成模型 Fish S2 Pro");
    expect(html).toContain("6.3 GB（Windows 里显示 5.88 GB）");
    expect(html).toContain("Fish Audio Research License");
    expect(html).toContain("个人非商业免费；商业使用要另外向 Fish Audio 取得授权");
    expect(html).toContain('href="https://huggingface.co/fishaudio/s2-pro/blob/main/LICENSE.md"');
    expect(html).toContain("看许可原文");
    expect(html).toContain("还会先下载语音合成程序 audio.cpp（813.3 MB）");
    expect(html).toContain(">同意并下载<");
    const installedFirst = renderToStaticMarkup(createElement(LicenseConfirm, { component: c, all: [program(), c], onCancel: noop, onConfirm: noop }));
    expect(installedFirst).not.toContain("还会先下载");
    expect(licenseSizeText(586_779_294)).toBe("559.6 MB");
  });
});

describe("一个组件一块", () => {
  test("没装：小签、一句话、几行（版本、大小、默认、哪一版、打开的功能、下载地址、装在哪）、照默认该装、安装按钮", () => {
    const html = render([component()]);
    expect(html).toContain("向量模型 bge-m3");
    expect(html).toContain('class="chip">没装<');
    expect(html).toContain("照默认该装");
    expect(html).toContain("记忆按意思找素材用的模型");
    for (const text of ["版本", "4de13258", "大小", "559.6 MB", "默认装", "q8 量化版", "按意思检索素材", "Hugging Face、hf-mirror和ModelScope", "C:\\data\\models\\Xenova\\bge-m3"]) expect(html).toContain(text);
    expect(html).toContain(">安装</button>");
    expect(html).not.toContain("progressbar");
  });

  test("正在下：进度条和那一行（已下、速度、还要多久、从哪个地址），按钮是暂停、取消", () => {
    const c = component({ state: "downloading", progress: { phase: "downloading", done: 220_000_000, total: 586_779_294, speed: 6_710_886, etaSeconds: 55, source: "hf-mirror" } });
    const html = render([c]);
    expect(html).toContain('aria-valuenow="37"');
    expect(html).toContain("已下 209.8 MB / 559.6 MB · 6.4 MB/s · 还要不到 1 分钟 · 从 hf-mirror");
    expect(componentActions(c)).toEqual(["pause", "cancel"]);
    expect(html).toContain(">暂停</button>");
    expect(html).toContain(">取消</button>");
  });

  test("探速、校验、换上的时候写在做哪一步", () => {
    expect(progressText(component({ state: "downloading", progress: { phase: "probing", done: 0, total: 10 } }))).toBe("正在探速，挑快的下载地址…");
    expect(progressText(component({ state: "downloading", progress: { phase: "verifying", done: 10, total: 10 } }))).toBe("正在校验…");
    expect(progressText(component({ state: "installing", progress: { phase: "installing", done: 10, total: 10 } }))).toBe("下好了，正在换上…");
  });

  test("暂停了、出错了：进度留着，继续 / 重试和取消；离线导入了一部分的写还差什么", () => {
    const paused = component({ state: "paused", progress: { phase: "downloading", done: 100, total: 400 }, error: "离线导入了一部分，还差 1 个文件；点继续会从网上下剩下的" });
    const html = render([paused]);
    expect(html).toContain("已下 100 B / 400 B");
    expect(html).toContain("还差 1 个文件");
    expect(componentActions(paused)).toEqual(["resume", "cancel"]);
    const failed = component({ state: "failed", error: "磁盘空间不够：还要 600 MB" });
    expect(render([failed])).toContain('class="field-error">磁盘空间不够');
    expect(actionText(failed, "resume")).toBe("重试");
  });

  test("装好了：装好占多大、删除；有新版本：装着的和新的版本、更新和删除", () => {
    const installed = component({ state: "installed", installedVersion: "4de13258", diskSize: 586_779_294 });
    expect(componentLines(installed, [installed]).find((l) => l.key === "size")?.value).toBe("下载 559.6 MB，装好占 559.6 MB");
    expect(componentActions(installed)).toEqual(["remove"]);
    const update = component({ state: "update", installedVersion: "11111111", version: "22222222" });
    expect(componentLines(update, [update]).find((l) => l.key === "version")?.value).toBe("装着 11111111，新版本 22222222");
    expect(componentActions(update)).toEqual(["update", "remove"]);
  });

  test("别处已经有了：写谁提供的；不能从这里装：写原因、没有安装按钮", () => {
    const asr = component({
      id: "asr",
      title: "语音识别模型 Fun-ASR Nano",
      state: "provided",
      default: "ask",
      defaultText: "问了再装",
      wanted: false,
      providedBy: "已有自己配的语音识别，在用它（服务管家托管的识别服务 http://127.0.0.1:8091）",
      cannotInstall: "要改用这里装的，先撤掉自己配的（配置里的 voice.recognizer.mode、voice.recognizer.python）",
      variant: { id: "q8", title: "q8 量化版" },
    });
    const html = render([asr]);
    expect(html).toContain('class="chip chip-ok">已有<');
    expect(html).toContain("已有自己配的语音识别，在用它");
    expect(html).toContain("先撤掉自己配的");
    expect(html).not.toContain("照默认该装");
    expect(componentActions(asr)).toEqual([]);
  });

  test("语音识别模型：推荐、许可名字带链接、那一句话、标来源；要确认许可；装之前能装", () => {
    const license = { name: "FunASR Model License v1.1", summary: "可以免费使用、修改、分享，要注明来源和作者、保留模型名", url: "https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE", confirm: true, accepted: false, attribution: "Fun-ASR-Nano-2512 · FunAudioLLM / Alibaba Group" };
    const asr = component({ id: "asr", title: "语音识别模型 Fun-ASR Nano", state: "missing", default: "ask", defaultText: "问了再装", wanted: false, size: 1_045_334_432, recommended: true, dependsOn: ["audiocpp"], license });
    const html = render([asr]);
    expect(html).toContain(">推荐<");
    expect(html).toContain('href="https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE"');
    expect(html).toContain('class="component-attribution">Fun-ASR-Nano-2512 · FunAudioLLM / Alibaba Group<');
    expect(componentActions(asr)).toEqual(["install"]);
    expect(licenseSizeText(asr.size)).toBe("1.0 GB（Windows 里显示 996.9 MB）");
  });

  test("检测到才装：写检测到了没有；要先装的写名字；别处点过来的那一块亮一下；正在点的写处理中", () => {
    const claude = component({ id: "claude-code", title: "Claude Code 接入", default: "detected", defaultText: "本机装了 Claude Code 才装", detectedText: "没检测到", wanted: false, dependsOn: ["bge-m3"] });
    const all = [component(), claude];
    const lines = componentLines(claude, all);
    expect(lines.find((l) => l.key === "default")?.value).toBe("本机装了 Claude Code 才装（没检测到）");
    expect(lines.find((l) => l.key === "depends")?.value).toBe("向量模型 bge-m3");
    const html = render(all, { focused: "claude-code", busy: "bge-m3" });
    expect(html).toContain('component-row component-state-missing component-focus" data-component="claude-code"');
    expect(html).toContain("处理中…");
  });

  test("装到别处的（数据目录带中文时的语音组件，351）：装在哪后面带为什么；用哪一版带原因", () => {
    const tts = component({
      id: "audiocpp",
      title: "语音程序 audio.cpp",
      variant: { id: "cuda12", title: "CUDA 12.4 版", reason: "显卡驱动是 566.36，CUDA 13.3 版要 580 或更新的驱动" },
      location: "C:\\ProgramData\\ergo\\1a2b3c4d\\components\\audiocpp",
      locationNote: "数据目录 C:\\Users\\张三\\.ergo\\components 的路径里有 audio.cpp 读不了的字（比如中文），语音程序和模型装在这里",
    });
    const lines = componentLines(tts, [tts]);
    expect(lines.find((l) => l.key === "location")?.value).toBe("C:\\ProgramData\\ergo\\1a2b3c4d\\components\\audiocpp（数据目录 C:\\Users\\张三\\.ergo\\components 的路径里有 audio.cpp 读不了的字（比如中文），语音程序和模型装在这里）");
    expect(lines.find((l) => l.key === "variant")?.value).toBe("CUDA 12.4 版（显卡驱动是 566.36，CUDA 13.3 版要 580 或更新的驱动）");
    expect(componentLines(component(), [component()]).find((l) => l.key === "location")?.value).toBe("C:\\data\\models\\Xenova\\bge-m3");
  });
});

describe("Codex 接入（454）", () => {
  const codex = (extra: Partial<ComponentView> = {}) =>
    component({
      id: "codex",
      title: "Codex 接入",
      summary: "让任务、项目可以交给 Codex 做（OpenAI 的开源命令行程序，从 npm 官方下载；登录用你自己的 Codex 账号，二狗不碰）。",
      version: "0.166.0",
      default: "detected",
      defaultText: "本机装了 Codex 才装",
      wanted: false,
      detectedText: "没检测到",
      variant: { id: "win32-x64", title: "Windows x64" },
      size: 4_992 + 180_706_795,
      enables: [{ id: "runtime.codex", title: "用 Codex 做任务" }],
      sources: ["npm"],
      location: "C:\\data\\components\\codex",
      license: { name: "Apache-2.0", summary: "开源（Apache-2.0），可以免费使用", url: "https://github.com/openai/codex/blob/rust-v0.166.0/LICENSE", confirm: false, accepted: false },
      ...extra,
    });

  test("没装：一块写版本、大小、许可（Apache-2.0，不用确认）、打开的功能、从 npm 下；有安装按钮；功能 runtime.codex 灰着、点了去装它", () => {
    const html = render([codex()]);
    expect(html).toContain("Codex 接入");
    expect(html).toContain("0.166.0");
    expect(html).toContain("Apache-2.0");
    expect(html).toContain("用 Codex 做任务");
    expect(html).toContain("npm");
    expect(componentActions(codex())).toEqual(["install"]);
    expect(missingComponentFor(view([codex()]), "runtime.codex")).toEqual({ feature: "runtime.codex", component: "codex", title: "Codex 接入", ready: false });
    expect(missingComponentFor(view([codex({ state: "installed", installedVersion: "0.166.0" })]), "runtime.codex")).toBeUndefined();
  });

  test("本机 PATH 上已有够版本的：写在用它，功能不灰（想换成这里装的也能装）", () => {
    const provided = codex({ state: "provided", wanted: true, detectedText: "检测到了：C:\\npm\\codex.cmd", providedBy: "本机已经装了 Codex 0.170.2，在用它（C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js）" });
    const html = render([provided]);
    expect(html).toContain("本机已经装了 Codex 0.170.2，在用它");
    expect(componentActions(provided)).toEqual(["install"]);
    expect(missingComponentFor(view([provided]), "runtime.codex")).toBeUndefined();
  });
});

describe("说法", () => {
  test("还要多久", () => {
    expect(etaText(30)).toBe("不到 1 分钟");
    expect(etaText(5 * 60)).toBe("约 5 分钟");
    expect(etaText(80 * 60)).toBe("约 1 小时 20 分钟");
  });

  test("离线导入完说一句：装好了哪些、认出几个、还差什么、认不出的", () => {
    const v = view([component({ state: "installed" }), component({ id: "pack", title: "附加件" })]);
    expect(importText({ installed: ["bge-m3"], matched: [{ component: "bge-m3", file: "config.json" }, { component: "bge-m3", file: "onnx/model_quantized.onnx" }], unknown: ["a.txt"], missing: [{ component: "pack", files: ["x.bin"] }], view: v })).toBe(
      ["装好了：向量模型 bge-m3", "认出 2 个文件", "附加件还差：x.bin（点继续从网上下剩下的）", "认不出 1 个：a.txt"].join("\n"),
    );
    expect(importText({ installed: [], matched: [], unknown: [], missing: [], view: v })).toBe("什么都没认出来");
  });
});

describe("灰掉的功能", () => {
  test("组件没装、别处也没有：回要装的那个；装了、别处有、还没取到清单、不认得的功能都不挡", () => {
    const missing = view([component()]);
    expect(missingComponentFor(missing, "memory.semantic")).toEqual({ feature: "memory.semantic", component: "bge-m3", title: "向量模型 bge-m3", ready: false });
    expect(missingComponentFor(view([component({ state: "installed" })]), "memory.semantic")).toBeUndefined();
    expect(missingComponentFor(view([component({ state: "provided" })]), "memory.semantic")).toBeUndefined();
    expect(missingComponentFor(undefined, "memory.semantic")).toBeUndefined();
    expect(missingComponentFor(missing, "voice.input")).toBeUndefined();
  });
});
