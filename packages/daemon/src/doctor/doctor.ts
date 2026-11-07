// 体检（319b、409）：设置 · 更多 · 体检一页。网关的 GET /api/doctor 经这里现算一份（DoctorView），秘书的只读体检工具（tool.ts）也读它。
// 原来的八项是端口、Node 版本、pi 版本、服务管家、模型的 key、组件、磁盘空间、外网入口，形状在共享协议包的 doctor.ts；
// 409 起页面按块显示："二狗本身"一块（八项，加上内核登记的检查），每个在跑或没装上的插件一块——插件在 setup 里
// ctx.doctor.register 登记的检查项（checks.ts），加上二狗替它生成的插件本身、它的数据源、它的 agent 运行时（auto.ts）。
//
// 几条规矩：
// - 平时体检只查本机：不联网、不调用模型、不写任何东西；可以连这台电脑上二狗在用的服务的端口（cost: local，用户 11-07 同意的放宽：
//   不然语音合成服务停了这种事查不出来）；
// - 一项抛错、超时只算这一项"没查出来"（八项是 ok: false、fix 是 doctor.fix.retry、data 是这一项的空值；登记的检查是 unknown），
//   别的项照常——体检不能因为一个洞全挂。所有项并行查；
// - 结果五种：正常、注意、坏了、没查出来、不适用（DoctorLevel）；总状态取最差的，"没查出来""不适用"不拉低；
// - 八项的事实是结构化的（端口号、版本号、剩多少 GB）；登记的检查交文案键 + 参数（插件的键在插件自己的语言文件里，网页拿不到，
//   所以这里按当前语言把每项的几句话拼好放进 text，网页照着显示）；
// - 每项查什么由组合根注入（DoctorProbes、登记表、插件 / 数据源 / 运行时的现状），测试注入假的；这一份也提供正式用的那几个探测器（进程、文件系统那些）。
//
// 八项不健康时算几级（BAD_LEVEL）：端口、pi、模型的 key、磁盘不到 1 GB 是坏了（聊不了天、手机连不上、写不进去）；
// Node 版本、服务管家、组件、外网入口是注意（能用，但打了折扣）。
//
// 各项的 ok 判法：
// - ports：两个端口都有人在听、而且听的是二狗自己（查得到占用者时按 pid 认；查不到时只按"有人在听"算，见 portsProbe）；
// - node：跑着的 Node 大版本对得上 ADR-0031 那条线（pi 测过的，现在是 22）；
// - pi：读得到 pi-coding-agent 的版本；
// - supervisor：服务管家的命令行有回应（lsm status --json 回得出来）；
// - model：模型的 key 配好了（modelSettings.keyView()，不真发请求）；
// - components：照组件清单的默认该装的功能都还不能用的，一个都不缺；
// - disk：数据目录所在卷还剩 1 GB 以上；
// - external：查到了外网入口的依据（服务管家里的登记，或者已配对的设备；不真连出去）。
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  type AgentRuntimeView,
  coreDoctorItem,
  DOCTOR_CHECKS,
  DOCTOR_CORE_GROUP,
  DOCTOR_FIX_UNKNOWN,
  type ComponentsView,
  type DoctorCheckData,
  type DoctorCheckDataById,
  type DoctorCheckId,
  type DoctorCheckView,
  doctorCounts,
  type DoctorGroupView,
  type DoctorItemView,
  doctorItemText,
  type DoctorLevel,
  type DoctorOffPlugin,
  type DoctorView,
  type PluginInfo,
  type RejectedConnectionAddress,
  sortDoctorGroups,
  sortDoctorItems,
  t,
  worstLevel,
} from "@ergo/protocol";
import { DAEMON_SERVICE_ID } from "../cli/service.ts";
import type { DataSourceDoctorFacts } from "../data-sources/service.ts";
import { listeningPids } from "../process/port-owner.ts";
import type { InstallLayout } from "../release/layout.ts";
import { type DoctorItemDraft, pluginItem, runtimeItem, sourceItem } from "./auto.ts";
import { type DoctorCheckRegistry, type DoctorCost, type DoctorFinding, type RegisteredDoctorCheck, runDoctorCheck } from "./checks.ts";

/** 二狗和 pi 用的 Node 大版本（ADR-0031：跟着 pi 的测试线走，现在是 22） */
export const DOCTOR_NODE_MAJOR = 22;

/** 磁盘剩多少算够（GB，严格大于这个数） */
export const DOCTOR_DISK_MIN_GB = 1;

/** 一项的取值函数（可以是同步的，也可以是查一会儿才回来的） */
export type DoctorProbe<Id extends DoctorCheckId> = () => DoctorCheckDataById[Id] | Promise<DoctorCheckDataById[Id]>;

/** 八项的取值函数（组合根注入，测试换成假的） */
export type DoctorProbes = { readonly [Id in DoctorCheckId]: DoctorProbe<Id> };

/** 挑要查的项时看的：哪一块（DOCTOR_CORE_GROUP 或插件名）、哪一项、开销 */
export interface DoctorCheckRef {
  group: string;
  id: string;
  cost: DoctorCost;
}

export interface DoctorRunOptions {
  /**
   * 只查这些（后台盯着的那几项、以后的分档用）；不给是全部。挑掉的八项不在 checks 里，挑掉的别的项不在块里，没剩下一项的块不出现
   */
  include?(check: DoctorCheckRef): boolean;
}

export interface DoctorService {
  /** 现在各项的样子（每次现算，互不影响，并行查） */
  view(options?: DoctorRunOptions): Promise<DoctorView>;
}

export interface DoctorOptions {
  probes: DoctorProbes;
  /** 查的时刻（毫秒时间戳）；不给是此刻。测试换成固定的 */
  now?: () => number;
  /** 这份二狗是怎么装的（pi 缺了时修法不一样）；不给当仓库里直接跑的 */
  install?: Pick<InstallLayout, "kind" | "info">;
  /** 登记着的体检项（插件的、内核的，checks.ts）；不给是没有 */
  checks?: Pick<DoctorCheckRegistry, "list">;
  /** 插件清单里每个插件现在的样子（插件宿主的 info()，按清单的先后）；不给是没有插件块 */
  plugins?: () => readonly PluginInfo[];
  /** 每个数据源（数据源服务的 doctorFacts）；不给是没有 */
  dataSources?: () => readonly DataSourceDoctorFacts[];
  /** 登记了的 agent 运行时（登记表的 view().runtimes）；只看插件登记的，pi 不在体检里 */
  runtimes?: () => readonly AgentRuntimeView[];
  /** 用着这个运行时、还没结束的任务和项目有几个（没装的运行时有人用才算坏）；不给当没有 */
  runtimeUsers?: (runtimeId: string) => number;
  /** 写日志（哪项没查出来、为什么；给开发者看的） */
  log?: (line: string) => void;
}

/** 八项不健康时算几级（见文件头） */
const BAD_LEVEL: { readonly [Id in DoctorCheckId]: "warn" | "error" } = {
  ports: "error",
  node: "warn",
  pi: "error",
  supervisor: "warn",
  model: "error",
  components: "warn",
  disk: "error",
  external: "warn",
};

/** 八项各自的开销：探端口、跑服务管家的命令行是 local，别的只读内存和文件 */
const LEGACY_COST: { readonly [Id in DoctorCheckId]: DoctorCost } = {
  ports: "local",
  node: "passive",
  pi: "passive",
  supervisor: "local",
  model: "passive",
  components: "passive",
  disk: "passive",
  external: "passive",
};

/** 八项里一项算几级：好的正常，查不了的没查出来，坏的照 BAD_LEVEL */
export function legacyLevel(check: DoctorCheckView): DoctorLevel {
  if (check.ok) return "ok";
  return check.fix === DOCTOR_FIX_UNKNOWN ? "unknown" : BAD_LEVEL[check.id];
}

/** 草稿拼上按当前语言的句子 */
const rendered = (draft: DoctorItemDraft): DoctorItemView => ({ ...draft, text: doctorItemText(draft) });

/** 登记的一项查出来的结果写成块里的一项 */
function registeredItem(check: RegisteredDoctorCheck, finding: DoctorFinding): DoctorItemDraft {
  return {
    id: check.id,
    level: finding.level,
    title: typeof check.title === "string" ? { key: check.title } : check.title,
    fact: finding.fact,
    ...(finding.fix === undefined ? {} : { fix: finding.fix }),
    ...(finding.since === undefined ? {} : { since: finding.since }),
    ...(finding.action === undefined ? {} : { action: finding.action }),
  };
}

/** 一块：标题、项排好（不适用的放最后）、块的结果取最差的 */
function groupOf(id: string, kind: DoctorGroupView["kind"], title: string, items: readonly DoctorItemView[]): DoctorGroupView {
  const sorted = sortDoctorItems(items);
  return { id, kind, title, level: worstLevel(sorted.map((item) => item.level)), items: sorted };
}

/** 总状态：所有项里最差的，"没查出来""不适用"不算（一项都不算时是正常） */
export function overallLevel(groups: readonly DoctorGroupView[]): DoctorLevel {
  return worstLevel(groups.flatMap((group) => group.items.map((item) => item.level)).filter((level) => level !== "unknown" && level !== "na"));
}

/** 每一项的 ok 判法 */
const OK: { readonly [Id in DoctorCheckId]: (data: DoctorCheckDataById[Id]) => boolean } = {
  ports: (data) => data.localUp && data.externalUp,
  node: (data) => data.running.split(".")[0] === data.expected,
  pi: (data) => data.version !== undefined,
  supervisor: (data) => data.running,
  model: (data) => data.configured,
  components: (data) => data.missing.length === 0,
  disk: (data) => data.freeGb > DOCTOR_DISK_MIN_GB,
  external: (data) => data.configured && (data.rejected?.length ?? 0) === 0,
};

/**
 * 查不了时这一项给的值：能空就空（pi 的 version、服务管家的 port）、能 0 就 0、布尔一律 false。
 * 网页见到 fix 是 doctor.fix.retry 就写"这次没查出来"，不拿这些值拼句子（所以 0 不会显示成"剩 0 GB"）
 */
const FALLBACK: { readonly [Id in DoctorCheckId]: DoctorCheckDataById[Id] } = {
  ports: { local: 0, external: 0, localUp: false, externalUp: false },
  node: { running: "", expected: String(DOCTOR_NODE_MAJOR) },
  pi: {},
  supervisor: { running: false },
  model: { configured: false },
  components: { missing: [] },
  disk: { freeGb: 0, totalGb: 0, path: "" },
  external: { configured: false },
};

/** pi 缺了怎么修：仓库里跑的（开发模式联接的也是）装依赖；一行命令装的程序目录里没有 npm，要重装；npm 装的用 npm 重装 */
function piFix(install: DoctorOptions["install"]): string {
  if (install?.kind === "npm") return "doctor.fix.piNpm";
  return install?.kind === "installed" && install.info?.kind !== "link" ? "doctor.fix.piInstalled" : "doctor.fix.pi";
}

/** 怎么修的文案键：外网入口接错了端口和没配是两回事，修法不一样；pi 按安装方式 */
function fixOf(id: DoctorCheckId, data: DoctorCheckData, install: DoctorOptions["install"]): string {
  if (id === "pi") return piFix(install);
  return id === "external" && ((data as DoctorCheckDataById["external"]).rejected?.length ?? 0) > 0 ? "doctor.fix.externalRejected" : `doctor.fix.${id}`;
}

/** 按 id 挑判法（两边是同一种形状，TS 认不出这层对应关系） */

function judge(id: DoctorCheckId, data: DoctorCheckData): boolean {
  return (OK[id] as (data: DoctorCheckData) => boolean)(data);
}

/**
 * 体检：每次 view() 现算（查的时刻取 now）——八项（顺序照 DOCTOR_CHECKS）和登记的检查项一起并行查，再读插件、数据源、运行时的现状
 * 生成二狗替插件的那几项，按块拼好（二狗本身在最前，插件块有问题的在前），每项的句子按当前语言拼好。
 * 八项各自在 try 里查：一项抛错只让这一项是"查不了"（ok: false、fix 是 doctor.fix.retry、data 是这一项的空值）；
 * 登记的检查超时、抛错只算这一项"没查出来"（runDoctorCheck）；别的项照常出结果
 */
export function createDoctor(options: DoctorOptions): DoctorService {
  const log = options.log ?? (() => {});

  /** 八项里的一项 */
  const legacy = async (id: DoctorCheckId): Promise<DoctorCheckView> => {
    try {
      const data = (await (options.probes[id] as DoctorProbe<DoctorCheckId>)()) as DoctorCheckData;
      const ok = judge(id, data);
      return { id, ok, data, ...(ok ? {} : { fix: fixOf(id, data, options.install) }) };
    } catch {
      return { id, ok: false, data: FALLBACK[id], fix: DOCTOR_FIX_UNKNOWN };
    }
  };

  /** 读现状（插件、数据源、运行时）：读不出来记日志、当没有（不让整份体检失败） */
  const read = <T>(what: string, get: (() => readonly T[]) | undefined): readonly T[] => {
    if (!get) return [];
    try {
      return get();
    } catch (err) {
      log(`体检读 ${what} 出错，这一样当没有：${err instanceof Error ? err.message : String(err)}`); // @i18n-ignore log：给开发者看的
      return [];
    }
  };

  const view = async (run: DoctorRunOptions = {}): Promise<DoctorView> => {
    const at = new Date((options.now ?? Date.now)()).toISOString();
    const wanted = (group: string, id: string, cost: DoctorCost) => run.include?.({ group, id, cost }) ?? true;
    const legacyIds = DOCTOR_CHECKS.filter((id) => wanted(DOCTOR_CORE_GROUP, id, LEGACY_COST[id]));
    const registered = (options.checks?.list() ?? []).filter((check) => wanted(check.plugin ?? DOCTOR_CORE_GROUP, check.id, check.cost));
    // 八项和登记的检查一起并行查：一项抛错、超时只算它自己
    const [checks, findings] = await Promise.all([Promise.all(legacyIds.map(legacy)), Promise.all(registered.map((check) => runDoctorCheck(check, log)))]);
    const ofGroup = (group: string) => registered.flatMap((check, i) => ((check.plugin ?? DOCTOR_CORE_GROUP) === group ? [rendered(registeredItem(check, findings[i]!))] : []));

    // 二狗本身：八项，加上内核登记的
    const coreItems = [...checks.map((check) => coreDoctorItem(check, legacyLevel(check))), ...ofGroup(DOCTOR_CORE_GROUP)];
    const groups: DoctorGroupView[] = coreItems.length > 0 ? [groupOf(DOCTOR_CORE_GROUP, "core", t("doctor.group.core"), coreItems)] : [];

    // 插件块：在跑、没装上的各一块（二狗替它生成的几项在前，它自己登记的在后）；停用、移除了的只列名字
    const now = Date.parse(at);
    const sources = read("dataSources", options.dataSources);
    const runtimes = read("runtimes", options.runtimes);
    const off: DoctorOffPlugin[] = [];
    const seen = new Set<string>();
    const auto = (draft: DoctorItemDraft | undefined, group: string): DoctorItemView[] => (draft && wanted(group, draft.id, "passive") ? [rendered(draft)] : []);
    for (const info of read("plugins", options.plugins)) {
      seen.add(info.name);
      if (info.state === "disabled" || info.state === "removed") {
        off.push({ plugin: info.name, title: info.title, state: info.state });
        continue;
      }
      const items = [
        ...auto(pluginItem(info), info.name),
        ...sources.filter((facts) => facts.view.plugin === info.name).flatMap((facts) => auto(sourceItem(facts, now), info.name)),
        ...runtimes.filter((runtime) => runtime.plugin === info.name).flatMap((runtime) => auto(runtimeItem(runtime, options.runtimeUsers?.(runtime.id) ?? 0), info.name)),
        ...ofGroup(info.name),
      ];
      if (items.length > 0) groups.push(groupOf(info.name, "plugin", info.title, items));
    }
    // 登记了检查、却不在插件清单里的（测试里只给了登记表）：照插件名单独一块
    for (const plugin of new Set(registered.flatMap((check) => (check.plugin === undefined || seen.has(check.plugin) ? [] : [check.plugin])))) {
      groups.push(groupOf(plugin, "plugin", plugin, ofGroup(plugin)));
    }

    const sorted = sortDoctorGroups(groups);
    return { checks, groups: sorted, off, level: overallLevel(sorted), counts: doctorCounts(sorted), at };
  };
  return { view };
}

// ───────── 正式用的探测器（组合根按数据目录、服务管家目录拼起来交给上面） ─────────

/** Node 版本：现在跑的这个（process.version 去掉 v）和 ADR-0031 那条线 */
export function nodeProbe(): DoctorCheckDataById["node"] {
  return { running: process.version.replace(/^v/, ""), expected: String(DOCTOR_NODE_MAJOR) };
}

/**
 * 两个端口上是不是二狗自己在听（端口号由网关给：生产里就是配置里的 ports，测试里是系统挑的）。
 * 先连一下 127.0.0.1:port 看有没有人在听；在听的话再核占用它的进程号是不是自己（Windows 上 netstat 查得到）。
 * 查不到占用者（不是 Windows、netstat 跑不了）时只按"有人在听"算——这一点做不到就只报通不通
 */
export function portsProbe(ports: () => { local: number; external: number }): () => Promise<DoctorCheckDataById["ports"]> {
  return async () => {
    const { local, external } = ports();
    const [localUp, externalUp] = await Promise.all([portIsOurs(local), portIsOurs(external)]);
    return { local, external, localUp, externalUp };
  };
}

/** 连一下 127.0.0.1 的这个端口：在听、而且占着它的是这个进程（查不到占用者时按在听算） */
async function portIsOurs(port: number): Promise<boolean> {
  if (!(Number.isInteger(port) && port > 0)) return false;
  if (!(await portListening(port))) return false;
  // 连得上，已知有人在听：netstat 这一眼没有、状态乱报也再找找
  const owners = await listeningPids(port, { known: true });
  return owners.length === 0 || owners.includes(process.pid);
}

/** 探活最多等这么久（毫秒）：本机端口不该等太久，体检不能被一个端口拖住 */
const PORT_PROBE_TIMEOUT_MS = 500;

function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * pi 的版本：读随程序装好的 node_modules 里 pi-coding-agent 的 package.json 的 version。
 * 读不到（依赖没装、文件坏了）就没有 version——这就是"pi 坏了"的正常样子，不算体检自己查不了
 */
export function piVersionProbe(packageJson: string): () => DoctorCheckDataById["pi"] {
  return () => {
    try {
      const raw = JSON.parse(fs.readFileSync(packageJson, "utf8")) as { version?: unknown };
      return typeof raw.version === "string" && raw.version !== "" ? { version: raw.version } : {};
    } catch {
      return {};
    }
  };
}

/** 服务管家的命令行（bin/lsm.mjs）和它的数据目录 */
export interface SupervisorCommand {
  /** 跑 lsm 的 node（二狗自己那份） */
  node: string;
  /** packages/supervisor/bin/lsm.mjs */
  script: string;
  /** 服务管家的数据目录（--data-dir） */
  dataDir: string;
  /** 最多等多久（毫秒），超时当没回应 */
  timeoutMs?: number;
}

/** 服务管家用默认的这么多毫秒：它没在跑时 lsm 本地直连探一遍注册表，超了就不等 */
export const SUPERVISOR_PROBE_TIMEOUT_MS = 5_000;

/**
 * 服务管家在不在：跑 `lsm status --json --data-dir <目录>`，退出码 0 而且打印得出来就是有回应（服务管家没在跑时
 * lsm 自己本地直连探一遍，照样有回应——这一项只判"这套东西还能不能管二狗"）。端口从它的 manager.yaml 读（和 ergo 命令同一个读法）
 */
export function supervisorProbe(command: SupervisorCommand): () => Promise<DoctorCheckDataById["supervisor"]> {
  return async () => {
    const port = managerPort(path.join(command.dataDir, "registry", "manager.yaml"));
    const stdout = await runQuietly(command.node, [command.script, "status", "--json", "--data-dir", command.dataDir], command.timeoutMs ?? SUPERVISOR_PROBE_TIMEOUT_MS);
    const running = stdout !== undefined && isJson(stdout);
    return { running, ...(port === undefined ? {} : { port }) };
  };
}

/** 服务管家设置里的端口（manager.yaml 的 port:）；读不到是 undefined */
export function managerPort(managerYaml: string): number | undefined {
  try {
    const port = Number(/^port:\s*(\d+)/m.exec(fs.readFileSync(managerYaml, "utf8"))?.[1]);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
  } catch {
    return undefined;
  }
}

/** 跑一条命令收下它的输出；起不来、超时、退出码不是 0 都是 undefined */
function runQuietly(file: string, args: readonly string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(file, [...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => resolve(err ? undefined : stdout));
  });
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** 字节换成 GB（一位小数） */
const gbOf = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;

/** 数据目录所在卷还剩多少、一共多少（GB，一位小数） */
export function diskProbe(dir: string): () => DoctorCheckDataById["disk"] {
  return () => {
    const stats = fs.statfsSync(dir);
    return { freeGb: gbOf(stats.bsize * stats.bavail), totalGb: gbOf(stats.bsize * stats.blocks), path: dir };
  };
}

/**
 * 照组件清单的默认该装、现在还不能用的功能：清单里 default 是 install 的组件（现在只有记忆的向量模型 bge-m3）所打开的功能里，
 * ready 还是假的那些。清单里的默认换了、加了组件，这里跟着变，不写死组件 id。清单读坏了（组件页一个组件都没有）时这里看不出缺什么，
 * 组合根把这种情况当"查不了"（探测器抛错），不是当"都不缺"
 */
export function missingDefaultFeatures(view: ComponentsView): string[] {
  const shouldInstall = new Set(view.components.filter((component) => component.default === "install").flatMap((component) => component.enables.map((feature) => feature.id)));
  return view.features.filter((gate) => !gate.ready && shouldInstall.has(gate.feature)).map((gate) => gate.feature);
}

/**
 * 外网入口的依据（都是本机记着的，不真连出去），按这个先后看，查到一样就报这一样：
 * - registry/tailnet.yaml 里有二狗的一项 → 开了 tailnet 入口（VPS 上搭的是自建 headscale 的话报 headscale，否则是 Tailscale）；
 * - registry/services/ergo-daemon.yaml 的 exposure.via → 经某条隧道出网（VPS 隧道）；
 * - 有已配对的设备 → 报几台（两个端口都只绑 127.0.0.1，设备配得上一般说明有东西把外面接了进来，只有在这台电脑上打开外网端口配对的例外；手动跑的 tailscale serve 服务管家不知道，靠这一条认）。
 * 本机的外网端口 8811 有人听不算依据：它默认就开，算了这一项就永远是好的。
 * 用户在设备配对页手填了地址也算依据（排在已配对设备前面：手机还没配对时它就是唯一的依据）。
 * 都没有是 configured: false，只表示没查到依据、不等于没配（文件读不了也算没查到）；网页就照这个说，不断言"没配"。
 * 服务管家给了、手机用不了的入口（接到了别的端口、不是 https）放进 rejected：不管别的依据有没有，这一项都算不健康
 */
export function externalProbe(options: {
  svcDataDir: string;
  pairedDevices: () => number;
  /** 连接地址那边算好的（pairing/addresses.ts）：手填了没有、哪些入口用不了；不给是都没有 */
  addresses?: () => { manual: boolean; rejected: RejectedConnectionAddress[] };
}): () => DoctorCheckDataById["external"] {
  const found = (): DoctorCheckDataById["external"] => {
    const registry = path.join(options.svcDataDir, "registry");
    if (hasTailnetEntry(path.join(registry, "tailnet.yaml"))) {
      return { configured: true, kind: hasHeadscale(path.join(options.svcDataDir, "vps-setup.json")) ? "headscale" : "tailscale" };
    }
    if (exposureVia(path.join(registry, "services", `${DAEMON_SERVICE_ID}.yaml`)) !== undefined) return { configured: true, kind: "tunnel" };
    if (options.addresses?.().manual) return { configured: true, kind: "manual" };
    const devices = options.pairedDevices();
    return devices > 0 ? { configured: true, kind: "paired", devices } : { configured: false };
  };
  return () => {
    const rejected = options.addresses?.().rejected ?? [];
    return { ...found(), ...(rejected.length > 0 ? { rejected } : {}) };
  };
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** tailnet.yaml 的 entries 里有没有二狗这一项（列表里的 - id: ergo-daemon，引号、空格都认） */
function hasTailnetEntry(file: string): boolean {
  const text = readText(file);
  return text !== undefined && new RegExp(`^\\s*-?\\s*id:\\s*['"]?${DAEMON_SERVICE_ID}['"]?\\s*$`, "m").test(text);
}

/** vps-setup.json 里记着自建 headscale 那一种（lsm vps setup headscale 搭的） */
function hasHeadscale(file: string): boolean {
  const text = readText(file);
  if (text === undefined) return false;
  try {
    const state = JSON.parse(text) as { modes?: Record<string, unknown> };
    return state.modes?.headscale !== undefined && state.modes.headscale !== null;
  } catch {
    return false;
  }
}

/** 登记里 exposure 段接的是哪条隧道（via 后面的 id）；没写、读不到是 undefined */
function exposureVia(file: string): string | undefined {
  const text = readText(file);
  return text === undefined ? undefined : /(^|\n)\s*exposure:\s*\n\s*via:\s*['"]?([^\s'"#]+)/.exec(text)?.[2];
}
