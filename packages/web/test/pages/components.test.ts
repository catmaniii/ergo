// 设置 · 组件（323 号票）：页面上的几块用 React 在 Node 里渲染出来查——
// - 一个组件一块：名字和状况的小签、一句话；版本、大小、默认（检测到才装的写检测到了没有）、用哪一版、打开的功能、要先装的、下载地址、装在哪；
//   别处已经有了的写谁提供；这一版还不能从这里装的写原因、没有安装按钮；
// - 正在下：进度条、已下 / 一共、速度、还要多久、从哪个地址；按钮按状况给（暂停 / 取消、继续 / 取消、重试、删除、更新）；
// - 离线导入完说一句；还要多久的说法；
// - 灰掉的功能：清单说某个功能没法用时回要装的组件（还没取到清单、能用的不挡）。
// 设置列表里的位置见 settings-groups.test.ts；页面打得开见 page-opens.test.ts（原型里编的组件）。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { actionText, ComponentList, componentActions, componentLines, etaText, importText, progressText } from "../../src/pages/more/ComponentsPage.tsx";
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
    manifest: { release: "0.2.1", signed: false },
    defaultsMissing: [],
  };
}

const render = (components: ComponentView[], over: { busy?: string; focused?: string } = {}) =>
  renderToStaticMarkup(createElement(ComponentList, { view: view(components), busy: over.busy, focused: over.focused, onAct: noop }));

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

  test("别处已经有了：写谁提供的；这一版还不能从这里装：写原因、没有安装按钮", () => {
    const asr = component({
      id: "asr",
      title: "语音识别",
      state: "provided",
      default: "ask",
      defaultText: "问了再装",
      wanted: false,
      providedBy: "用的是配置里的识别程序（python）",
      cannotInstall: "这一版还不能从这里装：Python 和 faster-whisper 那部分（用 uv 装）还没接上",
      variant: { id: "cuda", title: "CUDA 版", reason: "这台电脑有 N 卡" },
    });
    const html = render([asr]);
    expect(html).toContain('class="chip chip-ok">已有<');
    expect(html).toContain("用的是配置里的识别程序（python）");
    expect(html).toContain("还没接上");
    expect(html).toContain("CUDA 版（这台电脑有 N 卡）");
    expect(html).not.toContain("照默认该装");
    expect(componentActions(asr)).toEqual([]);
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
