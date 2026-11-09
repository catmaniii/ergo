// 组件服务：守护进程里一份下载器，设置 · 组件、以后的 `ergo components`、`npm run download-model` 共用。
// - 状态：清单里每个组件装了没有（装着的记在 <组件区>/installed.json；没有记录、但文件都在而且大小对得上的——以前用下载命令放进去的——
//   也算装好了）、别处有没有（provided 的检测）、正在下的进度。
// - 装：一次下一个组件（排队），依赖的先装；先查磁盘空间，再探速挑快的下载地址，文件下到 <组件区>/.staging/<id>/ 里——不解开的文件
//   直接按装好后的样子摆在 root/ 下，压缩包放 archives/、全下好以后解进 root/——都下好、校验过了才把 root 整个换成正式的目录
//   （旧的先改名成 .old-<时间>，换上了再删；换到一半被打断的，下次启动时改回来），正式的目录里不会出现下了一半的东西。
// - 暂停、取消、守护进程停下：中止正在下的；暂停和停下留着下了一半的（重启后是"暂停了"，点继续接着下），取消连临时目录一起删。
// - 离线导入：一个文件、一个文件夹、一个 .tar / .tgz 包，按清单里的大小和校验值认（sha256；npm 的包是 sha512；都没写的小文件按大小和名字），
//   认得的放进临时目录、凑齐了就照常换上；还差的写明，点继续会从网上下剩下的。
// - 只认清单里的校验值：镜像只是换个地方下，内容对不上就不用（见 downloader.ts）。
// - 许可：清单里写了要确认的，第一次下载前接口要带 licenseAccepted，没带不开始；确认过的记在 <组件区>/licenses.json，
//   许可换了版本（revision）要重新确认。离线导入也算用它：导入齐了还没确认的，停在"出错了"，写明要先确认。
// - 装好以后还要接上的（见 host.ts）：常驻服务的事交给 host，这里只在换上前后、删前后叫它一声。
// - 查更新（ADR-0042，取清单、验签在 update-check.ts）：查到的新条目先放着（offered），状态显示"有新版本"，正在用的那一条一个字节不动；
//   点了"更新"（或者这个组件还没装、点了安装）才按新条目下，换上之后它成了现在用的，并记进 installed.json（重启时随程序的清单还是旧的，比随程序的新才用它）。
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  activeLocale,
  type ComponentAction,
  type ComponentFeatureGate,
  type ComponentImportResult,
  type ComponentManualFile,
  type ComponentPhase,
  type ComponentProgress,
  type ComponentsView,
  type ComponentState,
  type ComponentView,
  componentBusy,
  formatList,
  t,
} from "@ergo/protocol";
import { RequestRejected } from "../errors.ts";
import { sizeLabel } from "../media/file-types.ts";
import { compareVersions } from "../release/layout.ts";
import { renameRetryingAsync, writeFileAtomic } from "../util/atomic-file.ts";
import { type ChecksumAlgorithm, checksumMismatch, checksumsOf, DownloadError, type DownloadUrl, digestFile, downloadFile, freeBytesOf, matchesChecksums, probeSources, sizeOf } from "./downloader.ts";
import type { ComponentHost } from "./host.ts";
import {
  type ComponentManifest,
  dependencyOrder,
  fileKey,
  fileSources,
  type LoadedManifest,
  type ManifestComponent,
  type ManifestFile,
  type ManifestPart,
  type ManifestVariant,
  pendingParts,
  pickVariant,
  validManifestComponent,
  variantFiles,
} from "./manifest.ts";
import type { ComponentProbes } from "./probes.ts";
import { extractTar, walkTar } from "./tar.ts";
import type { Transport } from "./transport.ts";
import type { UpdateChecker } from "./update-check.ts";
import { extractZip, findInTree } from "./zip.ts";

export interface ComponentsOptions {
  /** 数据目录（清单里的 target 相对它） */
  root: string;
  /** 组件区（installed.json、临时目录 .staging 在这里） */
  componentsDir: string;
  manifest: LoadedManifest;
  probes: ComponentProbes;
  transport: Transport;
  /** 这台电脑的平台（不给按 process） */
  machine?: { platform: string; arch: string };
  /** 某个目录所在的盘还剩多少字节（测试换成假的：磁盘不够） */
  freeBytes?: (dir: string) => number;
  /** 环境变量 HF_ENDPOINT（以前 npm run download-model 换镜像的用法）：Hugging Face 的地址换成它、排最前 */
  hfEndpoint?: string | undefined;
  /** 多久没收到字节算卡住、换下一个地址（毫秒）；不给是 30 秒 */
  stallMs?: number;
  /** 探速取多少字节；不给是 256 KB */
  probeBytes?: number;
  /** 探速最多等多久（毫秒）；不给是 8 秒 */
  probeTimeoutMs?: number;
  /** 查磁盘空间时多留多少字节；不给是 64 MB */
  diskMargin?: number;
  /** 装好以后还要接上的（常驻服务）；不给就只管文件 */
  host?: ComponentHost;
  /** 查更新；不给就没有 */
  updates?: UpdateChecker;
  log: (line: string) => void;
}

/** 装着的记录（installed.json） */
interface InstallRecord {
  version: string;
  variant: string;
  installedAt: string;
  from: "download" | "import";
  /** 查更新换上的：装的是新版本清单里的哪一条、那份清单是哪一版发布的；随程序的清单赶上来之前用它 */
  entry?: ManifestComponent;
  entryRelease?: string;
}

interface RecordsFile {
  format: 1;
  components: Record<string, InstallRecord>;
}

/** 确认过的许可（licenses.json）：组件 id → 确认的是哪个许可的哪一版、什么时候 */
interface LicensesFile {
  format: 1;
  accepted: Record<string, { name: string; revision: string; at: string }>;
}

/** 正在做（或者停在半路）的一个组件 */
interface Job {
  id: string;
  state: "queued" | "downloading" | "paused" | "installing" | "failed";
  phase?: ComponentPhase;
  done: number;
  total: number;
  speed?: number;
  source?: string;
  error?: string;
  missingFiles?: string[];
  /** 这次失败是下不下来（不通、内容不对）：组件页给下载地址和手动导入的办法 */
  downloadFailed?: boolean;
  from: "download" | "import";
  controller?: AbortController;
  stopReason?: "pause" | "cancel" | "stop";
  /** 最近几秒收到的字节（算速度） */
  samples: { at: number; bytes: number }[];
  waiters: (() => void)[];
}

export interface Components {
  /** 设置 · 组件要的全部 */
  view(): ComponentsView;
  /** 装、更新、删、暂停、继续、取消，常驻服务的启动、停止；做不了的抛 RequestRejected（不认得的 not_found）。licenseAccepted：用户看过并确认了许可 */
  act(id: string, action: ComponentAction, extra?: { licenseAccepted?: boolean }): Promise<ComponentsView>;
  /** 装上照默认该装、还没装的 */
  installDefaults(): Promise<ComponentsView>;
  /** 离线导入这台电脑上的一个文件、文件夹、.tar / .tgz 包 */
  importFrom(input: string): Promise<ComponentImportResult>;
  /** 查一次有没有新版本（有新版本只是显示，不下载）；没查成不抛错，原因在 view().updates.error */
  checkUpdates(signal?: AbortSignal): Promise<ComponentsView>;
  /** 装着、有新版本的组件 */
  pendingUpdates(): { id: string; title: string; version: string }[];
  /** 等某个组件（不给是全部）手头的事停下来：装好了、出错了、暂停了 */
  whenIdle(id?: string): Promise<void>;
  /** 取清单前现看一眼要联网、探端口才知道的（已有用户自己配的语音合成吗、服务通不通） */
  refresh(): Promise<void>;
  /** 有变化（状态、进度）时通知 */
  onChange(listener: () => void): () => void;
  /** 守护进程停下：中止正在下的（下了一半的留着，下次是"暂停了"） */
  stop(): Promise<void>;
}

const STAGING = ".staging";
const RECORDS = "installed.json";
const LICENSES = "licenses.json";
const SPEED_WINDOW_MS = 5000;

/** 有这句就用它，没有用 fallback（清单里新加的组件、版本还没写进语言文件时） */
function tOr(key: string, fallback: string, params?: Record<string, unknown>): string {
  const locale = activeLocale();
  return key in locale.messages || key in locale.fallback ? t(key, params) : fallback;
}

/** 组件 id 写进语言文件的 key：bge-m3 → bgeM3 */
const keyOf = (id: string) => id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** 一个文件在临时目录里的名字（压缩包）：路径里的 / 换掉 */
const archiveName = (file: ManifestFile) => encodeURIComponent(file.path);

/** 组件给人看的名字（语言文件里没有的写 id） */
const title = (c: ManifestComponent) => tOr(`components.item.${keyOf(c.id)}.title`, c.id);

/** 打好的包（离线导入时一项项认） */
const isPack = (file: string) => /\.(tar|tgz|tar\.gz)$/i.test(file);

/** 一个目录里的文件一共多大（读不了的不算） */
function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile()) total += sizeOf(path.join(entry.parentPath, entry.name));
    }
  } catch {
    // 读不了的不算
  }
  return total;
}

/** 出错的原因写给人看 */
function errorText(err: unknown): string {
  if (err instanceof DownloadError) {
    if (err.kind === "checksum") return t("components.error.checksum", { reason: err.message });
    if (err.kind === "unreachable") return t("components.error.unreachable", { reason: err.message });
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export function createComponents(options: ComponentsOptions): Components {
  const { manifest: shipped, signed } = options.manifest;
  const machine = { platform: options.machine?.platform ?? process.platform, arch: options.machine?.arch ?? process.arch };
  const freeBytes = options.freeBytes ?? freeBytesOf;
  const stallMs = options.stallMs ?? 30_000;
  const probeBytes = options.probeBytes ?? 256 * 1024;
  const probeTimeoutMs = options.probeTimeoutMs ?? 8000;
  const diskMargin = options.diskMargin ?? 64 * 1024 * 1024;
  const log = (line: string) => options.log(`[组件] ${line}`);
  const jobs = new Map<string, Job>();
  const queue: string[] = [];
  let running: string | undefined;
  let stopping = false;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const fn of listeners) fn();
  };

  const recordsPath = path.join(options.componentsDir, RECORDS);
  const readRecords = (): Record<string, InstallRecord> => {
    try {
      const raw = JSON.parse(fs.readFileSync(recordsPath, "utf8")) as Partial<RecordsFile>;
      return raw.format === 1 && raw.components && typeof raw.components === "object" ? raw.components : {};
    } catch {
      return {};
    }
  };
  const writeRecords = (records: Record<string, InstallRecord>) => writeFileAtomic(recordsPath, `${JSON.stringify({ format: 1, components: records } satisfies RecordsFile, null, 2)}\n`);

  // 现在用的清单：随程序发布的那份；查更新换上过的组件用换上时的那一条（比随程序的新才算，升级了二狗本身就回到随程序的）
  const adoptedRelease = new Map<string, string>();
  const startRecords = readRecords();
  const manifest: ComponentManifest = {
    ...shipped,
    components: shipped.components.map((c) => {
      const record = startRecords[c.id];
      if (!record?.entry || record.entryRelease === undefined || !validManifestComponent(record.entry)) return c;
      if (record.entry.id !== c.id || record.entry.version !== record.version || compareVersions(record.entryRelease, shipped.release) <= 0) return c;
      adoptedRelease.set(c.id, record.entryRelease);
      return record.entry;
    }),
  };
  const byId = new Map(manifest.components.map((c) => [c.id, c]));
  let order = dependencyOrder(manifest.components);

  // 查更新查到的：比现在用的新、还没换上的条目。要下的、要显示的都按它（goalOf），正在用的 byId 不动，下载失败、取消了旧的照常用
  const offered = new Map<string, ManifestComponent>();
  let offeredRelease: string | undefined;
  const goalOf = (c: ManifestComponent): ManifestComponent => offered.get(c.id) ?? c;
  const offerLatest = (latest: ComponentManifest) => {
    // 手上正在下的那一个不受影响，下完算它
    const inFlight = running === undefined ? undefined : offered.get(running);
    offered.clear();
    if (running !== undefined && inFlight) offered.set(running, inFlight);
    if (compareVersions(latest.release, shipped.release) <= 0) return;
    offeredRelease = latest.release;
    for (const next of latest.components) {
      const current = byId.get(next.id);
      if (!current || next.id === running || current.version === next.version) continue;
      // 位置换了、要的依赖这一版没有：要升级二狗本身才行，这里不提示
      if (current.target !== next.target) continue;
      if (![...(next.dependsOn ?? []), ...(next.serve ? [next.serve.host] : [])].every((id) => byId.has(id))) continue;
      offered.set(next.id, next);
    }
  };
  /** 新条目换上了：它成了现在用的 */
  const adopt = (c: ManifestComponent) => {
    if (offered.get(c.id) !== c || offeredRelease === undefined) return;
    adoptedRelease.set(c.id, offeredRelease);
    offered.delete(c.id);
    byId.set(c.id, c);
    manifest.components = manifest.components.map((other) => (other.id === c.id ? c : other));
    order = dependencyOrder(manifest.components);
  };

  const licensesPath = path.join(options.componentsDir, LICENSES);
  const readLicenses = (): LicensesFile["accepted"] => {
    try {
      const raw = JSON.parse(fs.readFileSync(licensesPath, "utf8")) as Partial<LicensesFile>;
      return raw.format === 1 && raw.accepted && typeof raw.accepted === "object" ? raw.accepted : {};
    } catch {
      return {};
    }
  };
  /** 许可不用确认，或者确认过这一版了 */
  const licenseSettled = (c: ManifestComponent): boolean => {
    if (!c.license?.confirm) return true;
    const accepted = readLicenses()[c.id];
    return accepted !== undefined && accepted.name === c.license.name && accepted.revision === (c.license.revision ?? "");
  };
  /** 记下确认过了 */
  const rememberLicense = (c: ManifestComponent) => {
    if (!c.license?.confirm || licenseSettled(c)) return;
    const accepted = { ...readLicenses(), [c.id]: { name: c.license.name, revision: c.license.revision ?? "", at: new Date().toISOString() } };
    fs.mkdirSync(options.componentsDir, { recursive: true });
    writeFileAtomic(licensesPath, `${JSON.stringify({ format: 1, accepted } satisfies LicensesFile, null, 2)}\n`);
    log(`${c.id}：用户确认了许可 ${c.license.name}`);
  };

  const targetOf = (c: ManifestComponent) => path.join(options.root, ...c.target.split("/"));
  const stagingOf = (id: string) => path.join(options.componentsDir, STAGING, id);
  const stagingRoot = (id: string) => path.join(stagingOf(id), "root");
  const stagingArchives = (id: string) => path.join(stagingOf(id), "archives");
  const variantOf = (c: ManifestComponent) => pickVariant(c, { ...machine, gpu: c.variants.some((v) => v.when?.gpu !== undefined) ? options.probes.gpu() : "none" });
  const component = (id: string): ManifestComponent => {
    const c = byId.get(id);
    if (!c) throw new RequestRejected("not_found", t("components.reject.unknown", { id }));
    return c;
  };

  /** 一版里的文件：在临时目录、正式目录里各放哪 */
  const plan = (c: ManifestComponent, variant: ManifestVariant) =>
    variantFiles(variant).map(({ part, file }) => {
      const key = fileKey(part, file);
      return {
        part,
        file,
        key,
        /** 下好、校验过的放这里 */
        staged: file.extract ? path.join(stagingArchives(c.id), archiveName(file)) : path.join(stagingRoot(c.id), ...key.split("/")),
        /** 装好后在正式目录里：不解开的是这个文件，解开的是解到的目录 */
        installed: path.join(targetOf(c), ...key.split("/")),
      };
    });

  /** 装好的文件都在：不解开的大小对得上，解开的目录在 */
  const filesPresent = (c: ManifestComponent, variant: ManifestVariant): boolean => {
    const files = plan(c, variant);
    return files.length > 0 && files.every((f) => (f.file.extract ? fs.existsSync(f.installed) : sizeOf(f.installed) === f.file.size && fs.existsSync(f.installed)));
  };

  /** 这个组件不能从这里装的原因；能装是 undefined */
  const cannotInstall = (c: ManifestComponent, variant: ManifestVariant | undefined): string | undefined => {
    if (!variant) return t("components.cannot.platform", { platform: `${machine.platform}-${machine.arch}` });
    const pending = pendingParts(variant);
    if (pending.length > 0) return t("components.cannot.pending", { parts: formatList(pending.map((p) => tOr(`components.pending.${keyOf(p)}`, p))) });
    if (plan(c, variant).length === 0) return t("components.cannot.noFiles");
    return options.host?.blocked(c);
  };

  /** 装着（从这里装的，或者文件都在）、别处有，都算这个功能能用 */
  const stateOf = (c: ManifestComponent, records: Record<string, InstallRecord>): ComponentState => {
    const job = jobs.get(c.id);
    if (job) return job.state;
    const variant = variantOf(c);
    const record = records[c.id];
    if (record && record.version !== c.version && fs.existsSync(targetOf(c))) return "update";
    if (variant && filesPresent(c, variant)) return offered.has(c.id) ? "update" : "installed";
    if (c.provided !== undefined && options.probes.provided(c.provided) !== undefined) return "provided";
    return "missing";
  };
  /** 现在用的那一版文件都在（换新版本下到一半、失败了，旧的照常用） */
  const stillThere = (c: ManifestComponent) => {
    const variant = variantOf(c);
    return variant !== undefined && filesPresent(c, variant);
  };
  const ready = (state: ComponentState, c: ManifestComponent) =>
    state === "installed" || state === "update" || state === "provided" || (c.provided !== undefined && options.probes.provided(c.provided) !== undefined) || (jobs.has(c.id) && stillThere(c));

  const wanted = (c: ManifestComponent): boolean => c.default === "install" || (c.default === "detected" && c.detect !== undefined && options.probes.detect(c.detect) !== undefined);

  /** 下不下来、暂停着时：还差的文件和下载地址，可以自己下好再从文件导入 */
  const manualFiles = (c: ManifestComponent, variant: ManifestVariant | undefined, state: ComponentState, job: Job | undefined): ComponentManualFile[] => {
    if (!variant || !(state === "paused" || (state === "failed" && job?.downloadFailed === true))) return [];
    return plan(c, variant)
      .filter((f) => !(fs.existsSync(f.staged) && sizeOf(f.staged) === f.file.size))
      .map((f) => ({ name: path.posix.basename(f.file.path), size: f.file.size, links: fileSources(c, f.part, f.file, options.hfEndpoint).map(({ source, url }) => ({ title: source.title, url })) }))
      .filter((f) => f.links.length > 0);
  };

  const progressOf = (job: Job): ComponentProgress | undefined => {
    if (job.total === 0 && job.state !== "downloading" && job.state !== "installing") return undefined;
    const speed = job.state === "downloading" ? job.speed : undefined;
    const eta = speed !== undefined && speed > 0 ? Math.ceil((job.total - job.done) / speed) : undefined;
    return {
      phase: job.phase ?? "downloading",
      done: job.done,
      total: job.total,
      ...(speed !== undefined ? { speed: Math.round(speed) } : {}),
      ...(eta !== undefined ? { etaSeconds: eta } : {}),
      ...(job.source !== undefined && job.state === "downloading" ? { source: job.source } : {}),
    };
  };

  const viewOf = (c: ManifestComponent, records: Record<string, InstallRecord>): ComponentView => {
    // 有新版本时：版本、大小、地址、许可写要换上的那一条；装着的版本看记录
    const goal = goalOf(c);
    const variant = variantOf(goal);
    const state = stateOf(c, records);
    const job = jobs.get(c.id);
    const record = records[c.id];
    const files = variant ? plan(goal, variant) : [];
    const provided = c.provided === undefined ? undefined : options.probes.provided(c.provided);
    const detected = c.detect === undefined ? undefined : options.probes.detect(c.detect);
    const sources = [...new Map((variant?.parts ?? []).flatMap((p) => p.sources ?? goal.sources ?? []).map((s) => [s.id, s.title])).values()];
    const gpuReason = variant?.when?.gpu === undefined ? undefined : variant.when.gpu === "nvidia" ? t("components.variant.reason.nvidia") : t("components.variant.reason.noNvidia");
    const noGpuVariant = variant && variant.when?.gpu === undefined && goal.variants.some((v) => v.when?.gpu === "nvidia") ? t("components.variant.reason.noNvidia") : undefined;
    const reason = gpuReason ?? noGpuVariant;
    const progress = job ? progressOf(job) : undefined;
    const installed = state === "installed" || state === "update";
    const blocked = cannotInstall(goal, variant);
    const service = options.host?.service(c);
    const manual = manualFiles(goal, variant, state, job);
    return {
      id: c.id,
      title: title(c),
      summary: tOr(`components.item.${keyOf(c.id)}.summary`, ""),
      version: goal.version,
      ...(record ? { installedVersion: record.version } : installed ? { installedVersion: c.version } : {}),
      state,
      default: c.default,
      defaultText: c.default === "detected" ? tOr(`components.default.detected.${keyOf(c.id)}`, t("components.default.detectedOther")) : t(`components.default.${c.default}`),
      wanted: wanted(c),
      ...(c.default === "detected" ? { detectedText: detected ?? t("components.detect.none") } : {}),
      ...(variant ? { variant: { id: variant.id, title: tOr(`components.variant.${keyOf(variant.id)}`, variant.id), ...(reason ? { reason } : {}) } } : {}),
      size: files.reduce((sum, f) => sum + f.file.size, 0),
      ...(installed ? { diskSize: dirSize(targetOf(c)) } : {}),
      enables: c.enables.map((id) => ({ id, title: tOr(`components.feature.${keyOf(id.replace(/\./g, "-"))}`, id) })),
      dependsOn: c.dependsOn ?? [],
      sources,
      location: targetOf(c),
      ...(state === "provided" && provided ? { providedBy: provided } : {}),
      ...(blocked !== undefined ? { cannotInstall: blocked } : {}),
      ...(progress ? { progress } : {}),
      ...(job?.error !== undefined ? { error: job.error } : {}),
      ...(job?.missingFiles && job.missingFiles.length > 0 ? { missingFiles: job.missingFiles } : {}),
      ...(goal.license
        ? {
            license: {
              name: goal.license.name,
              summary: tOr(`components.item.${keyOf(c.id)}.licenseSummary`, goal.license.summary),
              url: goal.license.url,
              confirm: goal.license.confirm,
              accepted: licenseSettled(goal),
              ...(goal.license.attribution !== undefined ? { attribution: goal.license.attribution } : {}),
            },
          }
        : {}),
      ...(c.recommended ? { recommended: true } : {}),
      ...(c.slowWithoutGpu && options.probes.gpu() === "none" ? { note: t("components.note.noGpuSlow") } : {}),
      ...(service ? { service } : {}),
      ...(manual.length > 0 ? { manualDownload: manual } : {}),
    };
  };

  const view = (): ComponentsView => {
    const records = readRecords();
    const components = manifest.components.map((c) => viewOf(c, records));
    const features: ComponentFeatureGate[] = manifest.components.flatMap((c) => {
      const shown = components.find((v) => v.id === c.id)!;
      return c.enables.map((feature) => ({ feature, component: c.id, title: shown.title, ready: ready(shown.state, c) }));
    });
    const defaultsMissing = components.filter((v) => v.wanted && v.cannotInstall === undefined && (v.state === "missing" || v.state === "failed" || v.state === "paused")).map((v) => v.id);
    return {
      components,
      features,
      manifest: { release: manifest.release, signed },
      defaultsMissing,
      ...(options.updates ? { updates: { where: options.updates.where, ...options.updates.last(), available: pendingUpdates().map((c) => c.id) } } : {}),
    };
  };

  /** 装着（旧版本的文件都在）、有新版本的；正在换的也算，换上了才不算 */
  const pendingUpdates = () =>
    manifest.components.flatMap((c) => {
      const next = offered.get(c.id);
      return next && stillThere(c) ? [{ id: c.id, title: title(c), version: next.version }] : [];
    });

  // ───────── 排队和做 ─────────

  const settle = (job: Job) => {
    const waiters = job.waiters.splice(0);
    for (const fn of waiters) fn();
  };
  const newJob = (id: string, from: Job["from"] = "download"): Job => ({ id, state: "queued", done: 0, total: 0, from, samples: [], waiters: [] });

  /** 排上（已经在排、在做的不再排）；from 给了的记下这次的东西从哪来（离线导入凑齐的） */
  const enqueue = (id: string, from?: Job["from"]) => {
    let job = jobs.get(id);
    if (job && (job.state === "downloading" || job.state === "installing" || (job.state === "queued" && queue.includes(id)))) return;
    if (!job) {
      job = newJob(id, from);
      jobs.set(id, job);
    }
    if (from !== undefined) job.from = from;
    job.state = "queued";
    delete job.error;
    delete job.stopReason;
    delete job.downloadFailed;
    queue.push(id);
    notify();
    pump();
  };

  const pump = () => {
    if (running !== undefined || stopping) return;
    const next = queue.shift();
    if (next === undefined) return;
    const job = jobs.get(next);
    if (!job || job.state !== "queued") return pump();
    running = next;
    void run(job).finally(() => {
      running = undefined;
      settle(job);
      notify();
      pump();
    });
  };

  /** 一个组件的临时目录配不配得上现在这一版（版本、哪一版）；配不上的整个删掉重来 */
  const prepareStaging = (c: ManifestComponent, variant: ManifestVariant) => {
    const dir = stagingOf(c.id);
    const metaFile = path.join(dir, "meta.json");
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as { version?: string; variant?: string };
      if (meta.version === c.version && meta.variant === variant.id) return;
    } catch {
      // 没有、读不了：重来
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(metaFile, JSON.stringify({ version: c.version, variant: variant.id }));
  };

  /** 同一个组件别的程序（守护进程和下载命令）在下：锁住临时目录 */
  const lock = (id: string): (() => void) => {
    const file = path.join(stagingOf(id), ".lock");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(file, String(process.pid), { flag: "wx" });
        return () => fs.rmSync(file, { force: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const pid = Number(fs.readFileSync(file, "utf8"));
        let alive = false;
        try {
          if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
            process.kill(pid, 0);
            alive = true;
          }
        } catch {
          alive = false;
        }
        if (alive) throw new Error(t("components.error.locked", { pid }), { cause: err });
        fs.rmSync(file, { force: true });
      }
    }
    throw new Error(t("components.error.locked", { pid: "?" }));
  };

  /** 正式目录里已经有的（以前用下载命令放进去的）：大小、校验值对得上的直接拿来用，下了一半的 .part 挪过来接着下 */
  const reuseInstalled = async (files: ReturnType<typeof plan>, signal: AbortSignal, onVerifying: () => void) => {
    for (const f of files) {
      if (f.file.extract || fs.existsSync(f.staged)) continue;
      if (sizeOf(f.installed) === f.file.size && fs.existsSync(f.installed)) {
        onVerifying();
        if (!(await matchesChecksums(f.installed, f.file, signal))) continue;
        fs.mkdirSync(path.dirname(f.staged), { recursive: true });
        try {
          fs.linkSync(f.installed, f.staged);
        } catch {
          fs.copyFileSync(f.installed, f.staged);
        }
        log(`${f.key}：正式目录里已经有了，直接用`);
        continue;
      }
      const oldPart = `${f.installed}.part`;
      if (fs.existsSync(oldPart) && !fs.existsSync(`${f.staged}.part`)) {
        fs.mkdirSync(path.dirname(f.staged), { recursive: true });
        await renameRetryingAsync(oldPart, `${f.staged}.part`).catch(() => undefined);
      }
    }
  };

  /** 下好了：解开压缩包，把临时目录的 root 整个换成正式的目录 */
  const commit = async (c: ManifestComponent, variant: ManifestVariant, files: ReturnType<typeof plan>, signal: AbortSignal) => {
    const root = stagingRoot(c.id);
    fs.mkdirSync(root, { recursive: true });
    // 几个包可以解到同一处（程序包和运行库包）：同一处只在第一个包之前清一次
    const cleared = new Set<string>();
    for (const f of files) {
      if (!f.file.extract) continue;
      const dest = path.join(root, ...f.file.extract.to.split("/"));
      if (!cleared.has(dest)) fs.rmSync(dest, { recursive: true, force: true });
      cleared.add(dest);
      const { format, beside, strip = 0 } = f.file.extract;
      // 运行库放到程序旁边：程序在包里第几层不写死，按文件名找
      const program = beside === undefined ? undefined : findInTree(dest, beside);
      if (beside !== undefined && program === undefined) throw new Error(t("components.error.programMissing", { program: beside }));
      try {
        if (format === "zip") {
          await extractZip(f.staged, program === undefined ? dest : path.dirname(program), { strip, flatten: beside !== undefined, signal });
        } else {
          await extractTar(f.staged, dest, { gzip: format === "tgz", strip, signal });
        }
      } catch (err) {
        if (signal.aborted) throw new DownloadError("stopped", "已中止"); // @i18n-ignore log：上层按状态换成给人看的
        throw new Error(t("components.error.extract", { file: f.file.path, reason: err instanceof Error ? err.message : String(err) }), { cause: err });
      }
    }
    // 常驻服务的程序组件：解完了找不到程序就不换上（包的结构没有核对过，不能等到 6 GB 的模型下完才发现）
    if (c.service && !findInTree(root, c.service.program)) throw new Error(t("components.error.programMissing", { program: c.service.program }));
    const target = targetOf(c);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const old = `${target}.old-${Date.now()}`;
    const hadOld = fs.existsSync(target);
    try {
      if (hadOld) await options.host?.beforeReplace(c);
      if (hadOld) await renameRetryingAsync(target, old);
      try {
        await renameRetryingAsync(root, target);
      } catch (err) {
        if (hadOld) await renameRetryingAsync(old, target).catch(() => undefined);
        throw err;
      }
    } catch (err) {
      throw new Error(t("components.error.busy", { reason: err instanceof Error ? err.message : String(err) }), { cause: err });
    }
    if (hadOld) await fs.promises.rm(old, { recursive: true, force: true }).catch((err: unknown) => log(`旧版本 ${old} 没删掉（${err instanceof Error ? err.message : String(err)}），下次启动再删`));
    const records = readRecords();
    // 不是随程序的那一条：记下这一条和它是哪一版发布的（重启后还按它认）
    const entryRelease = offered.get(c.id) === c ? offeredRelease : adoptedRelease.get(c.id);
    records[c.id] = { version: c.version, variant: variant.id, installedAt: new Date().toISOString(), from: jobs.get(c.id)?.from ?? "download", ...(entryRelease !== undefined ? { entry: c, entryRelease } : {}) };
    writeRecords(records);
    fs.rmSync(stagingOf(c.id), { recursive: true, force: true });
  };

  const run = async (job: Job): Promise<void> => {
    const c = goalOf(component(job.id));
    const variant = variantOf(c);
    const controller = new AbortController();
    job.controller = controller;
    const signal = controller.signal;
    let release: (() => void) | undefined;
    try {
      const blocked = cannotInstall(c, variant);
      if (blocked !== undefined || !variant) throw new Error(blocked);
      // 没确认过许可的不下载（点安装时接口就拦了；走到这里的是离线导入凑齐的、依赖带上的）
      if (!licenseSettled(c)) throw new Error(t("components.error.licenseRequired", { license: c.license?.name ?? "" }));
      // 依赖的先装：还没有的（没装、别处也没有）先排上，自己排回它们后面
      const records = readRecords();
      const missingDeps = (c.dependsOn ?? []).filter((dep) => !ready(stateOf(component(dep), records), component(dep)));
      for (const dep of missingDeps) {
        const depJob = jobs.get(dep);
        if (depJob?.state === "failed" || depJob?.state === "paused") throw new Error(t("components.error.dependency", { title: title(component(dep)) }));
      }
      if (missingDeps.length > 0) {
        job.state = "queued";
        for (const dep of order.filter((id) => missingDeps.includes(id))) enqueue(dep);
        queue.push(job.id);
        return;
      }
      prepareStaging(c, variant);
      release = lock(c.id);
      const files = plan(c, variant);
      job.state = "downloading";
      job.phase = "downloading";
      delete job.error;
      delete job.missingFiles;
      job.total = files.reduce((sum, f) => sum + f.file.size, 0);
      const doneBytes = () => files.reduce((sum, f) => sum + (fs.existsSync(f.staged) ? f.file.size : Math.min(sizeOf(`${f.staged}.part`), f.file.size)), 0);
      job.done = doneBytes();
      notify();
      await reuseInstalled(files, signal, () => {
        job.phase = "verifying";
        notify();
      });
      const pending = files.filter((f) => !(sizeOf(f.staged) === f.file.size && fs.existsSync(f.staged)));
      // 磁盘空间：还要下的 + 压缩包解开的 + 留一点
      const need = pending.reduce((sum, f) => sum + f.file.size - Math.min(sizeOf(`${f.staged}.part`), f.file.size), 0) + files.reduce((sum, f) => sum + (f.file.extract?.unpackedSize ?? 0), 0) + diskMargin;
      const free = freeBytes(options.componentsDir);
      if (free < need) throw new DownloadError("disk", t("components.error.disk", { need: sizeLabel(need), free: sizeLabel(free), dir: options.componentsDir }));
      job.done = doneBytes();
      // 探速：几个地址各取还要下的最大那个文件的开头一小段，快的排前面
      const rank = new Map<string, number>();
      const probeTarget = pending.toSorted((a, b) => b.file.size - a.file.size)[0];
      const probeUrls = probeTarget ? toUrls(c, probeTarget.part, probeTarget.file) : [];
      // 要下的都很小（不到探速那一段的两倍）就不探了，直接按清单的先后下
      if (probeTarget && probeUrls.length > 1 && probeTarget.file.size >= probeBytes * 2) {
        job.phase = "probing";
        notify();
        const results = await probeSources(probeUrls, { transport: options.transport, bytes: probeBytes, size: probeTarget.file.size, timeoutMs: probeTimeoutMs, signal });
        results.forEach((r, i) => rank.set(r.sourceId, i));
        log(`${c.id} 探速：${results.map((r) => `${r.sourceId} ${r.speed === undefined ? `没探成（${r.error ?? ""}）` : `${sizeLabel(r.speed)}/s`}`).join("，")}`);
      }
      job.phase = "downloading";
      notify();
      for (const f of pending) {
        const base = files.filter((x) => x !== f).reduce((sum, x) => sum + (fs.existsSync(x.staged) && sizeOf(x.staged) === x.file.size ? x.file.size : 0), 0);
        const urls = toUrls(c, f.part, f.file).toSorted((a, b) => (rank.get(a.sourceId) ?? 99) - (rank.get(b.sourceId) ?? 99));
        await downloadFile(
          { name: `${c.id}/${f.file.extract ? f.file.path : f.key}`, urls, size: f.file.size, sha256: f.file.sha256, sha512: f.file.sha512, part: `${f.staged}.part`, dest: f.staged },
          {
            transport: options.transport,
            signal,
            stallMs,
            log,
            onBytes(done, from) {
              job.done = base + done;
              job.source = from.title;
              job.phase = "downloading";
              const at = performance.now();
              job.samples.push({ at, bytes: job.done });
              while (job.samples.length > 2 && at - job.samples[0]!.at > SPEED_WINDOW_MS) job.samples.shift();
              const first = job.samples[0]!;
              if (at - first.at >= 500) job.speed = (job.done - first.bytes) / ((at - first.at) / 1000);
            },
            onVerifying() {
              job.phase = "verifying";
              notify();
            },
          },
        );
        job.done = doneBytes();
        notify();
      }
      job.state = "installing";
      job.phase = "installing";
      delete job.speed;
      notify();
      await commit(c, variant, files, signal);
      adopt(c);
      jobs.delete(job.id);
      log(`${c.id} ${c.version}（${variant.id}）装好了`);
      options.host?.installed(c);
    } catch (err) {
      const reason = stopping && job.stopReason === undefined ? "stop" : job.stopReason;
      if (signal.aborted || (err instanceof DownloadError && err.kind === "stopped")) {
        if (reason === "cancel") {
          fs.rmSync(stagingOf(job.id), { recursive: true, force: true });
          jobs.delete(job.id);
          log(`${c.id} 取消了，下了一半的删掉`);
        } else {
          job.state = "paused";
          delete job.speed;
          log(`${c.id} 暂停了，下了一半的留着`);
        }
        return;
      }
      job.state = "failed";
      delete job.speed;
      job.error = errorText(err);
      job.downloadFailed = err instanceof DownloadError && (err.kind === "unreachable" || err.kind === "checksum");
      log(`${c.id} 没装成：${job.error}`);
    } finally {
      release?.();
      delete job.controller;
    }
  };

  const toUrls = (c: ManifestComponent, part: ManifestPart, file: ManifestFile): DownloadUrl[] =>
    fileSources(c, part, file, options.hfEndpoint).map(({ source, url }) => ({ sourceId: source.id, title: source.title, url }));

  const stopJob = async (job: Job, reason: "pause" | "cancel"): Promise<void> => {
    if (job.controller) {
      job.stopReason = reason;
      const done = new Promise<void>((resolve) => job.waiters.push(resolve));
      job.controller.abort();
      await done;
      return;
    }
    const at = queue.indexOf(job.id);
    if (at !== -1) queue.splice(at, 1);
    if (reason === "cancel") {
      fs.rmSync(stagingOf(job.id), { recursive: true, force: true });
      jobs.delete(job.id);
    } else {
      job.state = "paused";
    }
    settle(job);
  };

  // ───────── 启动时：换到一半被打断的改回来，临时目录里下了一半的是"暂停了" ─────────

  // 上次查到的新版本：先认下来（临时目录里下了一半的可能就是它）
  const savedLatest = options.updates?.saved();
  if (savedLatest) offerLatest(savedLatest);

  for (const installedEntry of manifest.components) {
    const c = goalOf(installedEntry);
    const target = targetOf(c);
    const parent = path.dirname(target);
    const base = path.basename(target);
    let olds: string[] = [];
    try {
      olds = fs
        .readdirSync(parent)
        .filter((name) => name.startsWith(`${base}.old-`))
        .toSorted();
    } catch {
      olds = [];
    }
    if (!fs.existsSync(target) && olds.length > 0) {
      const latest = olds.pop()!;
      try {
        fs.renameSync(path.join(parent, latest), target);
        log(`${c.id}：上次换到一半被打断了，旧版本改回来`);
      } catch (err) {
        log(`${c.id}：旧版本 ${latest} 没改回来（${err instanceof Error ? err.message : String(err)}）`);
      }
    }
    for (const name of olds) fs.rmSync(path.join(parent, name), { recursive: true, force: true });
    const staging = stagingOf(c.id);
    if (!fs.existsSync(staging)) continue;
    const variant = variantOf(c);
    let meta: { version?: string; variant?: string } = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(staging, "meta.json"), "utf8")) as typeof meta;
    } catch {
      meta = {};
    }
    if (!variant || meta.version !== c.version || meta.variant !== variant.id) {
      fs.rmSync(staging, { recursive: true, force: true });
      continue;
    }
    const files = plan(c, variant);
    const done = files.reduce((sum, f) => sum + (fs.existsSync(f.staged) ? f.file.size : Math.min(sizeOf(`${f.staged}.part`), f.file.size)), 0);
    const job = newJob(c.id);
    job.state = "paused";
    job.done = done;
    job.total = files.reduce((sum, f) => sum + f.file.size, 0);
    jobs.set(c.id, job);
  }

  // 上次离线导入时解包用的临时目录（导入到一半守护进程停了）
  try {
    for (const name of fs.readdirSync(path.join(options.componentsDir, STAGING))) {
      if (name.startsWith(".import-")) fs.rmSync(path.join(options.componentsDir, STAGING, name), { recursive: true, force: true });
    }
  } catch {
    // 还没有临时目录
  }

  // ───────── 离线导入 ─────────

  const importFrom = async (input: string): Promise<ComponentImportResult> => {
    const resolved = path.resolve(input.trim().replace(/^"(.*)"$/, "$1"));
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new RequestRejected("bad_params", t("components.reject.importMissing", { path: resolved }));
    }
    // 认得的文件：按大小分好，再按校验值（sha256、sha512，都没写的按名字）对
    const records = readRecords();
    const candidates = new Map<number, { c: ManifestComponent; variant: ManifestVariant; f: ReturnType<typeof plan>[number] }[]>();
    for (const entry of manifest.components) {
      const c = goalOf(entry);
      const variant = variantOf(c);
      if (!variant || cannotInstall(c, variant) !== undefined) continue;
      const job = jobs.get(c.id);
      if (job && (job.state === "downloading" || job.state === "installing")) continue;
      const state = stateOf(entry, records);
      if (state === "installed") continue;
      for (const f of plan(c, variant)) {
        const list = candidates.get(f.file.size) ?? [];
        list.push({ c, variant, f });
        candidates.set(f.file.size, list);
      }
    }
    const matched: ComponentImportResult["matched"] = [];
    const unknown: string[] = [];
    const touched = new Set<string>();
    const place = async (name: string, size: number, digest: (algorithm: ChecksumAlgorithm) => Promise<string>, copyTo: (dest: string) => Promise<void>): Promise<boolean> => {
      const list = candidates.get(size) ?? [];
      if (list.length === 0) return false;
      // 同一个文件的同一种校验值只算一次
      const known = new Map<ChecksumAlgorithm, Promise<string>>();
      const digestOf = (algorithm: ChecksumAlgorithm) => {
        let value = known.get(algorithm);
        if (value === undefined) {
          value = digest(algorithm);
          known.set(algorithm, value);
        }
        return value;
      };
      for (const { c, variant, f } of list) {
        const expected = checksumsOf(f.file);
        if (expected.length > 0) {
          const digests: Partial<Record<ChecksumAlgorithm, string>> = {};
          for (const e of expected) digests[e.algorithm] = await digestOf(e.algorithm);
          if (checksumMismatch(expected, digests) !== undefined) continue;
        } else if (path.basename(f.file.path) !== path.basename(name)) continue;
        if (!touched.has(c.id)) prepareStaging(c, variant);
        touched.add(c.id);
        if (!(fs.existsSync(f.staged) && sizeOf(f.staged) === f.file.size)) {
          fs.mkdirSync(path.dirname(f.staged), { recursive: true });
          const temp = `${f.staged}.import`;
          await copyTo(temp);
          await renameRetryingAsync(temp, f.staged);
          fs.rmSync(`${f.staged}.part`, { force: true });
        }
        matched.push({ component: c.id, file: f.file.extract ? f.file.path : f.key });
        return true;
      }
      return false;
    };
    const fromFile = async (file: string, size: number) => {
      const ok = await place(file, size, async (algorithm) => (await digestFile(file, [algorithm]))[algorithm]!, (dest) => fs.promises.copyFile(file, dest));
      if (!ok) unknown.push(path.basename(file));
    };
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(resolved, { withFileTypes: true, recursive: true }).filter((e) => e.isFile());
      for (const entry of entries.slice(0, 2000)) {
        const file = path.join(entry.parentPath, entry.name);
        await fromFile(file, sizeOf(file));
      }
    } else if (isPack(resolved) && !candidates.has(stat.size)) {
      // 打好的包：一项项认（包本身不是清单里的文件时）
      const temp = path.join(options.componentsDir, STAGING, `.import-${process.pid}-${Date.now()}`);
      fs.mkdirSync(temp, { recursive: true });
      try {
        let n = 0;
        await walkTar(resolved, { gzip: !/\.tar$/i.test(resolved) }, async (entry) => {
          if (entry.type !== "file") return undefined;
          if (!candidates.has(entry.size)) {
            unknown.push(entry.path);
            return undefined;
          }
          const scratch = path.join(temp, String(n++));
          const out = fs.createWriteStream(scratch);
          // 包里的一项不知道要对哪种校验值：边写边把两种都算上
          const hashes = { sha256: createHash("sha256"), sha512: createHash("sha512") };
          return {
            async write(chunk: Buffer) {
              hashes.sha256.update(chunk);
              hashes.sha512.update(chunk);
              if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", resolve));
            },
            async end() {
              await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
              const digests = { sha256: hashes.sha256.digest("hex"), sha512: hashes.sha512.digest("hex") };
              const ok = await place(entry.path, entry.size, (algorithm) => Promise.resolve(digests[algorithm]), (dest) => renameRetryingAsync(scratch, dest));
              if (!ok) unknown.push(entry.path);
              fs.rmSync(scratch, { force: true });
            },
          };
        });
      } catch (err) {
        throw new RequestRejected("bad_params", t("components.reject.importBadPack", { reason: err instanceof Error ? err.message : String(err) }));
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    } else {
      await fromFile(resolved, stat.size);
    }
    // 凑齐了的照常换上（排队，等它做完）；还差的写明，停在"暂停了"
    const installed: string[] = [];
    const missing: ComponentImportResult["missing"] = [];
    for (const id of order.filter((x) => touched.has(x))) {
      const c = goalOf(component(id));
      const variant = variantOf(c)!;
      const lacking = plan(c, variant).filter((f) => !(fs.existsSync(f.staged) && sizeOf(f.staged) === f.file.size));
      if (lacking.length === 0) {
        enqueue(id, "import");
        await whenIdle(id);
        if (stateOf(component(id), readRecords()) === "installed") installed.push(id);
        continue;
      }
      const lackingNames = lacking.map((f) => (f.file.extract ? f.file.path : f.key));
      missing.push({ component: id, files: lackingNames });
      const job = jobs.get(id) ?? newJob(id, "import");
      job.state = "paused";
      job.total = plan(c, variant).reduce((sum, f) => sum + f.file.size, 0);
      job.done = job.total - lacking.reduce((sum, f) => sum + f.file.size, 0);
      job.missingFiles = lackingNames;
      job.error = t("components.importPartial", { count: lacking.length });
      jobs.set(id, job);
    }
    notify();
    log(`离线导入 ${resolved}：认出 ${matched.length} 个文件，认不出 ${unknown.length} 个，装好了 ${installed.join("、") || "没有"}`);
    return { installed, matched, unknown, missing, view: view() };
  };

  const whenIdle = (id?: string): Promise<void> => {
    const pendingJobs = [...jobs.values()].filter((job) => (id === undefined || job.id === id) && componentBusy(job.state));
    if (pendingJobs.length === 0) return Promise.resolve();
    return Promise.all(pendingJobs.map((job) => new Promise<void>((resolve) => job.waiters.push(resolve)))).then(() => whenIdle(id));
  };

  /** 要确认许可的：没带确认标记不开始；带了记下（真能开始以后才记，见调用处） */
  const requireLicense = (c: ManifestComponent, accepted: boolean | undefined) => {
    if (licenseSettled(c) || accepted === true) return;
    throw new RequestRejected("not_allowed", t("components.reject.licenseRequired", { title: title(c), license: c.license?.name ?? "", url: c.license?.url ?? "" }));
  };

  // 接口后面的（常驻服务）要看哪些装好了：按当时装的那一版（换了显卡以后清单挑的可能不是装着的那一版）
  options.host?.attach({
    manifest,
    installed(id) {
      const c = byId.get(id);
      if (!c) return undefined;
      const recorded = readRecords()[id];
      const variant = (recorded && c.variants.find((v) => v.id === recorded.variant)) ?? variantOf(c);
      return variant && filesPresent(c, variant) ? { dir: targetOf(c), variant } : undefined;
    },
    changed: notify,
  });

  /** 正在查的那一次（点了检查更新、每晚的作业碰到一起时只查一次） */
  let checking: Promise<void> | undefined;

  return {
    view,
    async act(id, action, extra) {
      const c = component(id);
      const goal = goalOf(c);
      const job = jobs.get(id);
      const records = readRecords();
      const state = stateOf(c, records);
      switch (action) {
        case "install":
        case "update": {
          if (state === "installed" || state === "queued" || state === "downloading" || state === "installing") break;
          if (action === "install" && state === "update") break;
          const blocked = cannotInstall(goal, variantOf(goal));
          if (blocked !== undefined) throw new RequestRejected("not_allowed", t("components.reject.cannotInstall", { title: title(c), reason: blocked }));
          requireLicense(goal, extra?.licenseAccepted);
          await options.host?.preflight(goal);
          rememberLicense(goal);
          enqueue(id);
          break;
        }
        case "resume":
          if (job && (job.state === "paused" || job.state === "failed")) {
            requireLicense(goal, extra?.licenseAccepted);
            rememberLicense(goal);
            enqueue(id);
          }
          break;
        case "start":
        case "stop":
          if (!options.host) throw new RequestRejected("not_allowed", t("components.reject.noService"));
          await options.host.control(c, action);
          break;
        case "pause":
          if (job && (job.state === "queued" || job.state === "downloading")) await stopJob(job, "pause");
          break;
        case "cancel":
          if (job && job.state !== "installing") await stopJob(job, "cancel");
          break;
        case "remove": {
          if (job && (job.state === "queued" || job.state === "downloading" || job.state === "installing")) throw new RequestRejected("not_allowed", t("components.reject.running", { title: title(c) }));
          const target = targetOf(c);
          if (!fs.existsSync(target) && !records[id]) throw new RequestRejected("not_allowed", t("components.reject.notInstalled", { title: title(c) }));
          const dependents = manifest.components.filter((other) => (other.dependsOn ?? []).includes(id) && (stateOf(other, records) === "installed" || stateOf(other, records) === "update"));
          if (dependents.length > 0) throw new RequestRejected("not_allowed", t("components.reject.neededBy", { title: title(c), names: formatList(dependents.map(title)) }));
          await options.host?.beforeRemove(c);
          try {
            await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
          } catch (err) {
            throw new RequestRejected("not_allowed", t("components.error.busy", { reason: err instanceof Error ? err.message : String(err) }));
          }
          delete records[id];
          writeRecords(records);
          if (job) {
            fs.rmSync(stagingOf(id), { recursive: true, force: true });
            jobs.delete(id);
          }
          log(`${id} 删掉了（${target}）`);
          options.host?.removed(c);
          notify();
          break;
        }
      }
      return view();
    },
    async installDefaults() {
      const missing = view().defaultsMissing;
      for (const id of order.filter((x) => missing.includes(x))) enqueue(id);
      return view();
    },
    importFrom,
    async checkUpdates(signal) {
      const updates = options.updates;
      if (updates) {
        checking ??= updates
          .check(signal)
          .then((latest) => {
            if (latest) offerLatest(latest);
            notify();
          })
          .finally(() => {
            checking = undefined;
          });
        await checking;
      }
      return view();
    },
    pendingUpdates,
    whenIdle,
    refresh: () => options.host?.refresh() ?? Promise.resolve(),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async stop() {
      stopping = true;
      options.host?.stop();
      queue.length = 0;
      const current = running === undefined ? undefined : jobs.get(running);
      if (current?.controller) {
        const done = new Promise<void>((resolve) => current.waiters.push(resolve));
        current.controller.abort();
        await done;
      }
      for (const job of jobs.values()) if (job.state === "queued") job.state = "paused";
    },
  };
}
