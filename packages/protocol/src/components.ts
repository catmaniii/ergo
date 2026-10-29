// 组件（323 号票，议题 26"安装包、组件和源码安装"）：模型、语音这些大件不放进安装包，装完按需下载。
// 组件清单是随版本发布的一份数据（守护进程的 src/components/manifest.json）：每个组件的版本、大小、几个下载地址、校验值、装到哪、
// 打开哪些功能、依赖哪些别的组件、默认装不装（默认装 / 问了再装 / 检测到才装）。下载器在守护进程里一份，网页（设置 · 组件）和
// 以后的 `ergo components` 命令（318 号票）都经同一套 HTTP 接口：
// - GET /api/components：清单里的全部组件现在的样子（ComponentsView）；
// - POST /api/components：装上照默认该装的（ComponentsActionBody，components-schema.ts）；
// - POST /api/components/<id>：装、更新、删、暂停、继续、取消（ComponentActionBody）；
// - POST /api/component-import：离线导入自己下好的文件（一个文件、一个文件夹、一个 .tar / .tgz 包；ComponentImportBody → ComponentImportResult）。
// 给人看的字守护进程按当前语言写好。没装的组件对应的功能在界面上灰掉，点一下就去装（features）。
// 不引用 TypeBox。

/**
 * 一个组件现在怎样：
 * - installed 装好了（从这里装的，或者以前用下载命令放进去的、大小对得上）；update 装着旧版本、清单里有新的；
 * - provided 不是从这里装的、但别处已经有了（配置里的识别程序、随程序装好的 SDK……），对应的功能照样能用；
 * - missing 没装；queued 排着等下载；downloading 正在下（含探速、校验）；paused 暂停了（下了一半的留着，继续接着下）；
 * - installing 下好了、正在换上；failed 出错了（原因在 error，下了一半的留着，重试接着下）
 */
export const COMPONENT_STATES = ["installed", "update", "provided", "missing", "queued", "downloading", "paused", "installing", "failed"] as const;
export type ComponentState = (typeof COMPONENT_STATES)[number];

/** 清单里写的"默认"：install 默认装；ask 问了再装；detected 检测到了才装（比如本机装了 Claude Code） */
export const COMPONENT_DEFAULTS = ["install", "ask", "detected"] as const;
export type ComponentDefault = (typeof COMPONENT_DEFAULTS)[number];

/** 正在做的哪一步：探速（挑快的下载地址）、下载、校验、换上 */
export const COMPONENT_PHASES = ["probing", "downloading", "verifying", "installing"] as const;
export type ComponentPhase = (typeof COMPONENT_PHASES)[number];

/** 对一个组件做的事 */
export const COMPONENT_ACTIONS = ["install", "update", "remove", "pause", "resume", "cancel"] as const;
export type ComponentAction = (typeof COMPONENT_ACTIONS)[number];

/** 组件打开的功能（清单里 enables 写的 id）。界面上按它灰掉对应的入口 */
export const COMPONENT_FEATURES = {
  /** 素材按意思检索（向量模型 bge-m3） */
  memorySemantic: "memory.semantic",
  /** 按住说话（语音识别） */
  voiceInput: "voice.input",
  /** 用语音回复（语音合成） */
  voiceReply: "voice.reply",
  /** 用 Claude Code 做任务、项目 */
  runtimeClaudeCode: "runtime.claude-code",
} as const;

/** 下载的进度 */
export interface ComponentProgress {
  phase: ComponentPhase;
  /** 已经下好的字节（含以前下了一半、这次接着下的） */
  done: number;
  /** 一共要下多少字节 */
  total: number;
  /** 现在的速度（字节 / 秒）；刚开始、暂停着没有 */
  speed?: number;
  /** 照现在的速度还要几秒 */
  etaSeconds?: number;
  /** 正从哪个下载地址下（给人看的名字） */
  source?: string;
}

export interface ComponentFeatureView {
  id: string;
  /** 给人看的名字（"按意思检索素材"） */
  title: string;
}

/** 设置 · 组件里的一个组件：给人看的字都按守护进程当前的语言写好 */
export interface ComponentView {
  id: string;
  title: string;
  /** 一句话说它是什么 */
  summary: string;
  /** 清单里的版本 */
  version: string;
  /** 装着的版本（装了的才有；和 version 不一样就是 update） */
  installedVersion?: string;
  state: ComponentState;
  /** 清单里写的默认 */
  default: ComponentDefault;
  /** 默认的说法："默认装" / "问了再装" / "本机装了 Claude Code 才装" */
  defaultText: string;
  /** 照清单的默认，这台电脑上该不该装（install 的该；detected 的看检测到没有；ask 的不该） */
  wanted: boolean;
  /** detected 的那项检测到了什么（没检测到的写没检测到） */
  detectedText?: string;
  /** 用哪一版（CUDA 版 / CPU 版 / Windows x64……）和为什么 */
  variant?: { id: string; title: string; reason?: string };
  /** 要下载多少字节（这台电脑用的那一版；清单里还没写全的只算写了的） */
  size: number;
  /** 装好后在磁盘上占多少字节（装了的才有） */
  diskSize?: number;
  /** 装好后打开的功能 */
  enables: ComponentFeatureView[];
  /** 依赖的组件（id，按清单的先后） */
  dependsOn: string[];
  /** 从哪几个地方下（给人看的名字，按清单的先后） */
  sources: string[];
  /** 装在哪（这台电脑上的完整路径） */
  location: string;
  /** provided 时：谁提供的（"用的是配置里的识别程序：python"） */
  providedBy?: string;
  /** 不能从这里装的原因（这一版清单还没有下载地址、这台电脑的平台没有……）；能装是 undefined */
  cannotInstall?: string;
  /** 正在下、暂停着、出错了时的进度（下了一半的） */
  progress?: ComponentProgress;
  /** 出错的原因（failed 才有）；暂停着、导入了一部分时的说明也写在这里 */
  error?: string;
  /** 还差哪些文件（离线导入了一部分时；给人看的文件名） */
  missingFiles?: string[];
}

/** 一个功能现在能不能用：组件装好了或者别处有（ready），没有就灰掉、点一下去装那个组件 */
export interface ComponentFeatureGate {
  feature: string;
  /** 打开它的组件 */
  component: string;
  /** 组件给人看的名字 */
  title: string;
  ready: boolean;
}

/** GET /api/components：清单里的全部组件（按清单的先后） */
export interface ComponentsView {
  components: ComponentView[];
  features: ComponentFeatureGate[];
  /** 组件清单本身：随哪一版发布、签没签名（发布钥匙的签名由 318 号票发版时加；没签名的照用，界面上写明） */
  manifest: { release: string; signed: boolean };
  /** 照默认该装、还没装的（"装上默认的组件"那个按钮装它们） */
  defaultsMissing: string[];
}

/** 离线导入的结果 */
export interface ComponentImportResult {
  /** 这次装好的组件（id） */
  installed: string[];
  /** 认出来、放进去了的文件：哪个组件的哪个文件 */
  matched: { component: string; file: string }[];
  /** 认不出的（给人看的文件名；大小、校验值对不上清单里的任何一个） */
  unknown: string[];
  /** 认出了一部分、还差的（组件 → 文件） */
  missing: { component: string; files: string[] }[];
  view: ComponentsView;
}

/** 这个功能现在没法用时，要装的是哪个组件（能用、不认得这个功能、还没取到清单都是 undefined） */
export function missingComponentFor(view: ComponentsView | undefined, feature: string): ComponentFeatureGate | undefined {
  const gate = view?.features.find((f) => f.feature === feature);
  return gate && !gate.ready ? gate : undefined;
}

/** 正在动的（排着、在下、在换上）：界面上这时每秒重取一次 */
export function componentBusy(state: ComponentState): boolean {
  return state === "queued" || state === "downloading" || state === "installing";
}
