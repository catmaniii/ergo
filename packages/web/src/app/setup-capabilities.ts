// 设置向导"能力"那一步"不碰浏览器"的那部分：列哪几项、每项现在怎样、默认勾不勾、勾上要下多大、勾了之后调哪些接口。
// 页面在 pages/more/CapabilitiesStep.tsx；这里都是纯函数，测试在 Node 里直接查（test/app/setup-capabilities.test.ts）。
// - 列的是：插件（记忆、日历、语音、浏览、Claude Code）和组件（向量模型、语音识别、语音合成）。组件按"它打开哪个功能"认，不写死 id；
// - 默认勾不勾看清单：组件用守护进程按清单算好的 wanted（默认装的、检测到才装又检测到了的），这里不另写一份；语音这些"问了再装"的不勾；
//   插件清单默认全开，停着的是用户自己停的，只有记忆默认勾回来；Claude Code 跟着它那个组件；
// - 已经有了的（装好的、别处已有的、运行中的）不再让勾，只写现在的样子；不能从这里装的写原因；
// - 组件走现有的安装接口，插件走现有的启用接口。要确认许可的先过确认框（confirmLicense），没同意的不发请求，接口那边也不认（ADR-0038）；
// - 一项失败不挡别的项；失败的可以重试、可以跳过，之后在设置 · 组件里重做。
import { COMPONENT_FEATURES, componentBusy, componentNeedsLicense, type ComponentAction, type ComponentsView, type ComponentView, type PluginActionResult, type PluginInfo } from "../state/index.ts";

/** 这一步列的插件（按这个先后） */
export const CAPABILITY_PLUGINS = ["memory", "calendar", "voice", "browsing", "claude-code"] as const;
/** 这一步列的组件打开的功能（按这个先后）：程序组件 audio.cpp 不单列，装模型时带上 */
const CAPABILITY_FEATURES: readonly string[] = [COMPONENT_FEATURES.memorySemantic, COMPONENT_FEATURES.voiceInput, COMPONENT_FEATURES.voiceReply];
/** 停着时默认勾回来的插件 */
const DEFAULT_ON_PLUGINS: ReadonlySet<string> = new Set(["memory"]);
/** 这个插件要的外部组件打开的功能：没装的话勾这个插件要先下载它 */
const PLUGIN_FEATURE: Readonly<Record<string, string>> = { "claude-code": COMPONENT_FEATURES.runtimeClaudeCode };

/**
 * 一项现在怎样：on 已经有了；available 能勾；working 正在下、正在换上；stopped 下载停下了（出错了、暂停了），能重试、能跳过；
 * locked 现在不能从这里弄（写原因）
 */
export type CapabilityStatus = "on" | "available" | "working" | "stopped" | "locked";

export interface CapabilityRow {
  /** "plugin:memory"、"component:bge-m3"：勾选、失败、跳过都按它记 */
  key: string;
  kind: "plugin" | "component";
  /** 插件名或者组件 id */
  id: string;
  title: string;
  summary: string;
  status: CapabilityStatus;
  /** 默认勾不勾（只有 available 的才有意义） */
  byDefault: boolean;
  /** 勾上要下多少字节（连同还没有的依赖）；不用下载是 0 */
  download: number;
  /** 一起下的依赖（给人看的名字） */
  downloadWith: string[];
  /** 这一项背后要下的组件：组件那一行是它自己，Claude Code 插件是它的 SDK */
  component?: ComponentView;
  plugin?: PluginInfo;
  /** 要写一句的：不能弄的原因、别处已有的说明 */
  note?: string;
}

const hasFeature = (c: ComponentView, feature: string) => c.enables.some((f) => f.id === feature);

function statusOf(c: ComponentView): CapabilityStatus {
  if (c.state === "installed" || c.state === "update" || c.state === "provided") return "on";
  if (componentBusy(c.state)) return "working";
  if (c.state === "failed" || c.state === "paused") return "stopped";
  return c.cannotInstall === undefined ? "available" : "locked";
}

/** 这个组件依赖的、还要下的（别处有了、装好了的不算） */
function depsToFetch(c: ComponentView, all: readonly ComponentView[]): ComponentView[] {
  return c.dependsOn.flatMap((id) => all.filter((o) => o.id === id && (o.state === "missing" || o.state === "failed" || o.state === "paused")));
}

function componentRow(c: ComponentView, all: readonly ComponentView[]): CapabilityRow {
  const deps = depsToFetch(c, all);
  const status = statusOf(c);
  const note = c.providedBy ?? (status === "locked" ? c.cannotInstall : undefined);
  return {
    key: `component:${c.id}`,
    kind: "component",
    id: c.id,
    title: c.title,
    summary: c.summary,
    status,
    byDefault: c.wanted,
    download: c.size + deps.reduce((sum, d) => sum + d.size, 0),
    downloadWith: deps.map((d) => d.title),
    component: c,
    ...(note !== undefined ? { note } : {}),
  };
}

function pluginRow(p: PluginInfo, all: readonly ComponentView[]): CapabilityRow {
  const base = { key: `plugin:${p.name}`, kind: "plugin" as const, id: p.name, title: p.title, summary: p.summary, plugin: p };
  const feature = PLUGIN_FEATURE[p.name];
  const c = feature === undefined ? undefined : all.find((o) => hasFeature(o, feature));
  const byDefault = DEFAULT_ON_PLUGINS.has(p.name) || c?.wanted === true;
  if (p.state === "running") return { ...base, status: "on", byDefault, download: 0, downloadWith: [] };
  // 它要的外部组件没装：勾它就是先下那个组件，装好再启用
  if (p.missing && p.cannotEnable !== undefined && c && statusOf(c) !== "on") {
    const row = componentRow(c, all);
    return { ...base, status: row.status, byDefault, download: row.download, downloadWith: row.downloadWith, component: c, ...(row.note !== undefined ? { note: row.note } : {}) };
  }
  if (p.cannotEnable !== undefined && !(p.missing && c)) return { ...base, status: "locked", byDefault: false, download: 0, downloadWith: [], note: p.cannotEnable };
  return { ...base, status: "available", byDefault, download: 0, downloadWith: [], ...(p.problem !== undefined && !p.missing ? { note: p.problem } : {}) };
}

/** 这一步的几行：先插件后组件；还没取到的那一半不列 */
export function capabilityRows(components: ComponentsView | undefined, plugins: readonly PluginInfo[] | undefined): CapabilityRow[] {
  const all = components?.components ?? [];
  const pluginRows = CAPABILITY_PLUGINS.flatMap((name) => (plugins ?? []).filter((p) => p.name === name)).map((p) => pluginRow(p, all));
  const componentRows = CAPABILITY_FEATURES.flatMap((feature) => all.filter((c) => hasFeature(c, feature))).map((c) => componentRow(c, all));
  return [...pluginRows, ...componentRows];
}

/** 第一次拿到清单时默认勾哪些 */
export function defaultTicked(rows: readonly CapabilityRow[]): Set<string> {
  return new Set(rows.filter((row) => row.status === "available" && row.byDefault).map((row) => row.key));
}

/** 勾的这些一共要下多少（两个语音模型共用一个程序，只算一次） */
export function capabilityTotal(rows: readonly CapabilityRow[], ticked: ReadonlySet<string>, components: ComponentsView | undefined): number {
  const all = components?.components ?? [];
  const seen = new Map<string, number>();
  for (const row of rows) {
    if (!ticked.has(row.key) || row.status !== "available" || !row.component) continue;
    seen.set(row.component.id, row.component.size);
    for (const dep of depsToFetch(row.component, all)) seen.set(dep.id, dep.size);
  }
  return [...seen.values()].reduce((sum, size) => sum + size, 0);
}

/** 点"开始"要做的：直接启用的插件、要装的组件（可能带着一个装好后要启用的插件） */
export interface CapabilityPlan {
  plugins: string[];
  components: ComponentView[];
  /** 组件装好了才能启用的插件（Claude Code） */
  afterInstall: string[];
}

export function capabilityPlan(rows: readonly CapabilityRow[], ticked: ReadonlySet<string>): CapabilityPlan {
  const chosen = rows.filter((row) => ticked.has(row.key) && row.status === "available");
  const direct = chosen.filter((row) => row.kind === "plugin" && !row.component);
  const waiting = chosen.filter((row) => row.kind === "plugin" && row.component);
  const fetched = chosen.filter((row) => row.component).flatMap((row) => (row.component ? [row.component] : []));
  return { plugins: direct.map((row) => row.id), components: [...new Map(fetched.map((c) => [c.id, c])).values()], afterInstall: waiting.map((row) => row.id) };
}

/** 调接口要的 */
export interface CapabilityApi {
  componentAction(id: string, action: ComponentAction, extra?: { licenseAccepted?: boolean }): Promise<ComponentsView>;
  pluginAction(name: string, body: { action: "enable"; idempotencyKey: string }): Promise<PluginActionResult>;
  /** 要确认许可的组件：弹确认框，回同意没有 */
  confirmLicense(c: ComponentView): Promise<boolean>;
  newKey(): string;
}

export interface CapabilityResult {
  /** 最后一次回的组件清单（一个组件都没动是 undefined） */
  components?: ComponentsView;
  plugins?: PluginInfo[];
  /** 没成的（行的 key → 原因）：不挡别的项 */
  failures: Map<string, string>;
  /** 没同意许可、没有下载的（行的 key） */
  declined: string[];
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 做一个组件的事：要确认许可的先确认，没同意不发请求。回 undefined 是没同意 */
async function actOn(c: ComponentView, action: ComponentAction, api: CapabilityApi): Promise<ComponentsView | undefined> {
  if (!componentNeedsLicense(c)) return api.componentAction(c.id, action);
  if (!(await api.confirmLicense(c))) return undefined;
  return api.componentAction(c.id, action, { licenseAccepted: true });
}

/** 启用插件，再一个个装组件（一个一个来：确认框一次一个、插件接口也是一次一个）；下载在后台，接口马上回，进度靠页面轮询 */
export async function applyCapabilities(plan: CapabilityPlan, rows: readonly CapabilityRow[], api: CapabilityApi): Promise<CapabilityResult> {
  const result: CapabilityResult = { failures: new Map(), declined: [] };
  for (const name of plan.plugins) {
    try {
      result.plugins = (await api.pluginAction(name, { action: "enable", idempotencyKey: api.newKey() })).plugins;
    } catch (err) {
      result.failures.set(`plugin:${name}`, messageOf(err));
    }
  }
  for (const c of plan.components) {
    // 这个组件是哪几行要的（Claude Code 的 SDK 记在插件那一行）
    const keys = rows.filter((row) => row.component?.id === c.id).map((row) => row.key);
    try {
      const next = await actOn(c, "install", api);
      if (next) result.components = next;
      else result.declined.push(...keys);
    } catch (err) {
      for (const key of keys) result.failures.set(key, messageOf(err));
    }
  }
  return result;
}

/** 重试一项：依赖停着的先接着下（不然它一跑就报"要先装好依赖"），再是它自己；回最后一次的清单，没同意许可是 undefined */
export async function retryCapability(c: ComponentView, all: readonly ComponentView[], api: CapabilityApi): Promise<ComponentsView | undefined> {
  let last: ComponentsView | undefined;
  for (const dep of depsToFetch(c, all).filter((d) => d.state !== "missing")) last = await actOn(dep, "resume", api);
  return (await actOn(c, c.state === "missing" ? "install" : "resume", api)) ?? last;
}

/** 这一行要显示进度的那个组件：它自己在等依赖时看依赖（模型排着队、程序正在下） */
export function progressOwner(c: ComponentView, all: readonly ComponentView[]): ComponentView {
  if (c.state !== "queued") return c;
  return c.dependsOn.flatMap((id) => all.filter((o) => o.id === id && componentBusy(o.state)))[0] ?? c;
}

/** 这一行的组件停下来的原因：它自己只说"要先装好依赖"时，把依赖真正的原因也带上 */
export function stoppedDependency(c: ComponentView, all: readonly ComponentView[]): ComponentView | undefined {
  return c.dependsOn.flatMap((id) => all.filter((o) => o.id === id && o.state === "failed" && o.error !== undefined))[0];
}

/** 这个组件用的常驻服务（语音模型用 audio.cpp 的）：页面上看它起没起来 */
export function serviceOwner(c: ComponentView, all: readonly ComponentView[]): ComponentView | undefined {
  if (c.service) return c;
  return c.dependsOn.flatMap((id) => all.filter((o) => o.id === id && o.service))[0];
}

/** 这一页要不要每秒重取：有在下的、有服务正在起来 */
export function capabilityActive(view: ComponentsView | undefined): boolean {
  return view?.components.some((c) => componentBusy(c.state) || c.service?.state === "starting") ?? false;
}

/** 现在装了什么：装好的、别处已有的组件（带版本），运行中的插件 */
export function installedNow(components: ComponentsView | undefined, plugins: readonly PluginInfo[] | undefined): { components: ComponentView[]; plugins: PluginInfo[] } {
  return {
    components: (components?.components ?? []).filter((c) => c.state === "installed" || c.state === "update" || c.state === "provided"),
    plugins: (plugins ?? []).filter((p) => p.state === "running"),
  };
}
