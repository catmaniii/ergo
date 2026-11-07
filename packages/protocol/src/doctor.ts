// 体检（319b）：设置 · 更多 · 体检一页。守护进程的 GET /api/doctor 回这一份（DoctorView）。
// 两层（409 加了第二层）：
// - checks：原来的八项（端口、Node、pi、服务管家、模型的 key、组件、磁盘、外网入口），每项是**结构化的事实**（端口号、版本号、
//   剩多少 GB……）+ ok + fix（"怎么修"的文案键，doctor.fix.*）。id、事实的字段名定了不改（410 起在上面加东西）；
//   查不了（探测器抛错）的那一项 ok: false、fix 是 DOCTOR_FIX_UNKNOWN、data 是这一项的空值。
// - groups：页面按块显示的样子——"二狗本身"一块（八项在这里，加上以后内核自己登记的检查），每个在跑或没装上的插件一块
//   （插件自己登记的体检项，加上二狗替它生成的：插件本身、它的数据源、它的 agent 运行时）。每项是五种结果之一（DoctorLevel），
//   带事实、怎么修（文案键 + 参数，DoctorMessage）、可选的"从什么时候起"、可选的一个动作（DoctorAction），
//   还有守护进程按当前语言拼好的那几句（text）：插件的文案键在插件自己的语言文件里（<插件>.doctor.*），网页的词典里没有
//   这些区域（WEB_NAMESPACES），所以给人看的句子由守护进程拼；换了语言网页重新取一遍。
// - 停用、移除了的插件那一块不显示（它的检查项跟着撤了），只在 off 里列一下。
// - 总状态取最差的；"没查出来"（unknown）不拉低总状态、单独数；"不适用"（na）不算。
// - 平时体检只读本机：不联网、不调模型、不改任何状态；可以连本机上二狗在用的服务的端口（cost: local，用户 11-07 同意）。
//   每次查现算，不缓存。
// 不引用 TypeBox：网页只用常量和类型。
import type { RejectedConnectionAddress } from "./connection-addresses.ts";

/** 八项检查，顺序就是网页上从上到下的顺序 */
export const DOCTOR_CHECKS = ["ports", "node", "pi", "supervisor", "model", "components", "disk", "external"] as const;
export type DoctorCheckId = (typeof DOCTOR_CHECKS)[number];

/**
 * 每一项查出来的事实，形状按 id 各不同：
 * - ports：配置里的两个端口（本机、外网）和"127.0.0.1 上有人在听、而且听的是二狗自己"没有；
 * - node：现在跑的 Node 版本（不带 v）和 ADR-0031 那条线（pi 测过的大版本，现在是 22）；
 * - pi：读到的 pi 版本（读不到就没有）；
 * - supervisor：服务管家有没有回应、它的端口（读得到才有）；
 * - model：模型的 key 配没配（不真发请求）；
 * - components：照清单的默认该装、现在还不能用的功能（清单是随程序发布的那份）；空数组是都装好了；
 * - disk：数据目录所在卷还剩多少、一共多少（GB）、是哪个目录；
 * - external：本机记着的外网入口依据（不真连出去）：configured 是查到了依据——服务管家里的 tailnet、隧道登记（kind 是哪一种），
 *   或者没被吊销的已配对设备（kind 是 paired，devices 是几台）。没查到依据不等于没配：手动跑的 tailscale serve 服务管家不知道。
 *   rejected是服务管家给了、手机却用不了的入口（接到了别的端口、不是 https）：有就算不健康，修法是 doctor.fix.externalRejected
 */
export interface DoctorCheckDataById {
  ports: { local: number; external: number; localUp: boolean; externalUp: boolean };
  node: { running: string; expected: string };
  pi: { version?: string };
  supervisor: { running: boolean; port?: number };
  model: { configured: boolean };
  components: { missing: string[] };
  disk: { freeGb: number; totalGb: number; path: string };
  external: { configured: boolean; kind?: "tailscale" | "headscale" | "tunnel" | "manual" | "paired"; devices?: number; rejected?: RejectedConnectionAddress[] };
}

export type DoctorCheckData = DoctorCheckDataById[DoctorCheckId];

/** 一项检查：ok 是这一项健康；data 是查出来的事实（形状按 id 各不同，见 DoctorCheckDataById）；fix 是"怎么修"的文案键（网页按当前语言取） */
export interface DoctorCheckView {
  id: DoctorCheckId;
  ok: boolean;
  data: DoctorCheckData;
  fix?: string;
}

/**
 * 一项的结果（409），五种：
 * - ok 正常；
 * - warn 注意（黄）：能用，但打了折扣；
 * - error 坏了（红）：相关的功能用不了；
 * - unknown 没查出来（灰）：查的时候超时或出错，不算坏，不拉低总状态；
 * - na 不适用：没开这个功能、没连这个数据源，就不查（页面上淡显、排在块的最后）
 */
export const DOCTOR_LEVELS = ["ok", "warn", "error", "unknown", "na"] as const;
export type DoctorLevel = (typeof DOCTOR_LEVELS)[number];

/** 一句话：文案键 + 参数（参数里的时间、数字由出这句话的一方先按当前语言写好） */
export interface DoctorMessage {
  key: string;
  params?: Readonly<Record<string, string | number>>;
}

/**
 * 一项可以带的一个动作按钮（网页认得这几种；不认得的不画）：
 * - open：跳到二狗的某一页，route 是网页的地址（"#/more/data-sources/looki"）；也可以是这台电脑上别的网页（http(s)://……，
 *   比如服务管家的网页 http://127.0.0.1:7420/，413 的语音合成停了"去看看"跳它），网页新开一页打开；
 * - compact：现在压缩某个 agent 的对话（和会话 ⚙ 里"现在压缩"同一个接口，POST /api/agents/<agent id>/compact）
 */
export type DoctorAction = { kind: "open"; route: string } | { kind: "compact"; agentId: string };

/** open 的 route 是不是二狗之外的网页（http(s)://……，新开一页打开）；不是就是二狗自己的地址（#/……） */
export function isExternalDoctorRoute(route: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(route);
}

/** 动作的种类（网页按它挑按钮上的字） */
export const DOCTOR_ACTION_KINDS = ["open", "compact"] as const;

/** 分块里的一项 */
export interface DoctorItemView {
  /** 块里唯一：八项是 "ports" 这样的 id；二狗替插件生成的是 "plugin"、"source:<数据源 id>"、"runtime:<运行时 id>"；插件登记的是它自己起的 id */
  id: string;
  level: DoctorLevel;
  /** 这一项的名字、查出来的事实、怎么修（健康时一般没有）：文案键 + 参数 */
  title: DoctorMessage;
  fact: DoctorMessage;
  fix?: DoctorMessage;
  /** 从什么时候起是这个样子（ISO）；不知道就没有 */
  since?: string;
  action?: DoctorAction;
  /** 上面三句由守护进程按当前语言拼好的样子（网页照它显示） */
  text: { title: string; fact: string; fix?: string };
}

/** 页面上的一块："二狗本身"（core），或者一个插件（plugin，id 是插件名） */
export interface DoctorGroupView {
  /** "二狗本身"是 DOCTOR_CORE_GROUP；插件块是插件名 */
  id: string;
  kind: "core" | "plugin";
  /** 块的标题（按当前语言：插件给人看的名字） */
  title: string;
  /** 块里最差的（worstLevel） */
  level: DoctorLevel;
  items: DoctorItemView[];
}

/** "二狗本身"那一块的 id */
export const DOCTOR_CORE_GROUP = "ergo";

/** 停用、移除了的插件：它那块不显示，只列一下 */
export interface DoctorOffPlugin {
  plugin: string;
  title: string;
  state: "disabled" | "removed";
}

/** GET /api/doctor：原来的八项（按 DOCTOR_CHECKS 的先后）、分块的样子、总状态和查的时刻 */
export interface DoctorView {
  checks: DoctorCheckView[];
  /** 分块：二狗本身在最前，插件块按有问题的在前（坏了、注意、其余），同一档里按插件清单的先后 */
  groups: DoctorGroupView[];
  /** 停用、移除了的插件（按清单的先后） */
  off: DoctorOffPlugin[];
  /** 总状态：所有块里最差的（unknown、na 不算；什么都没有是 ok） */
  level: DoctorLevel;
  /** 坏了、要注意、没查出来的各几项 */
  counts: { error: number; warn: number; unknown: number };
  /** 查的时刻（ISO） */
  at: string;
}

/** 五种结果的轻重：越大越差。unknown、na 不参与比较（排最低） */
const LEVEL_RANK: Readonly<Record<DoctorLevel, number>> = { na: -2, unknown: -1, ok: 0, warn: 1, error: 2 };

/**
 * 一组结果里最差的：error > warn > ok；"没查出来"、"不适用"不拉低。
 * 全是 unknown（或 unknown 和 na）时是 unknown，全是 na 时是 na，一项都没有是 ok
 */
export function worstLevel(levels: Iterable<DoctorLevel>): DoctorLevel {
  let worst: DoctorLevel | undefined;
  for (const level of levels) if (worst === undefined || LEVEL_RANK[level] > LEVEL_RANK[worst]) worst = level;
  return worst ?? "ok";
}

/** 每一项各几项：坏了、要注意、没查出来 */
export function doctorCounts(groups: readonly DoctorGroupView[]): DoctorView["counts"] {
  const counts = { error: 0, warn: 0, unknown: 0 };
  for (const group of groups) for (const item of group.items) if (item.level === "error" || item.level === "warn" || item.level === "unknown") counts[item.level] += 1;
  return counts;
}

/**
 * 块的先后：二狗本身在最前；插件块里坏了的在前、然后是要注意的、其余的（正常、没查出来、不适用）最后，同一档里照原来的先后（插件清单）
 */
export function sortDoctorGroups(groups: readonly DoctorGroupView[]): DoctorGroupView[] {
  const rank = (group: DoctorGroupView) => (group.kind === "core" ? 3 : group.level === "error" ? 2 : group.level === "warn" ? 1 : 0);
  return groups.map((group, at) => ({ group, at })).toSorted((a, b) => rank(b.group) - rank(a.group) || a.at - b.at).map(({ group }) => group);
}

/** 块里各项的先后：照原来的先后，"不适用"的挪到最后 */
export function sortDoctorItems(items: readonly DoctorItemView[]): DoctorItemView[] {
  return [...items.filter((item) => item.level !== "na"), ...items.filter((item) => item.level === "na")];
}

/** 查不了的那一项用的 fix（网页写"这次没查出来"）：别的 fix 说的是这一项坏了怎么修 */
export const DOCTOR_FIX_UNKNOWN = "doctor.fix.retry";

/** 取某一项（没有这一项是 undefined）：网页按 id 拼句子时用 */
export function doctorCheck(view: DoctorView, id: DoctorCheckId): DoctorCheckView | undefined {
  return view.checks.find((check) => check.id === id);
}

/**
 * 某一项查出来的事实，按 id 收窄了类型（网页按 id 拼句子时不用断言）：没有这一项是 undefined。
 * 注意 DoctorCheckView 的 data 本身是八种形状的并集，不知道 id 时别乱取字段
 */
export function doctorDataOf<Id extends DoctorCheckId>(view: DoctorView, id: Id): DoctorCheckDataById[Id] | undefined {
  return doctorCheck(view, id)?.data as DoctorCheckDataById[Id] | undefined;
}
