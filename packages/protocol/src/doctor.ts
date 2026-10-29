// 体检（319 号票的 319b）：设置 · 更多 · 体检一页的八项检查。守护进程的 GET /api/doctor 回这一份（DoctorView）。
// - 每项查出来的是**结构化的事实**（端口号、版本号、剩多少 GB……），不是拼好的中文句子：给用户看的那句话由网页按当前语言拼
//   （locales/*/doctor.json 的 doctor.fact.*），所以换语言不用重查、守护进程里也不写界面的字。
// - ok 是"这一项健康"（判法写在每一项的注释里）；fix 是"怎么修"的文案键（网页按当前语言取 doctor.fix.*），健康时没有。
// - 查不了（探测器抛错）的那一项 ok: false、fix 是 DOCTOR_FIX_UNKNOWN、data 是这一项的空值（能空就空、能 0 就 0），
//   网页见到这个键就写"这次没查出来"，不拿 data 拼句子——别的项照常。
// - 只查本机：不联网（除了探本机端口）、不调用模型、不改任何状态；每次查现算，不缓存。
// 不引用 TypeBox：网页只用常量和类型。

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
 * - external：配没配外网入口（只报"配了没有"，不真连出去），配了的话是哪一种
 */
export interface DoctorCheckDataById {
  ports: { local: number; external: number; localUp: boolean; externalUp: boolean };
  node: { running: string; expected: string };
  pi: { version?: string };
  supervisor: { running: boolean; port?: number };
  model: { configured: boolean };
  components: { missing: string[] };
  disk: { freeGb: number; totalGb: number; path: string };
  external: { configured: boolean; kind?: "tailscale" | "headscale" | "tunnel" };
}

export type DoctorCheckData = DoctorCheckDataById[DoctorCheckId];

/** 一项检查：ok 是这一项健康；data 是查出来的事实（形状按 id 各不同，见 DoctorCheckDataById）；fix 是"怎么修"的文案键（网页按当前语言取） */
export interface DoctorCheckView {
  id: DoctorCheckId;
  ok: boolean;
  data: DoctorCheckData;
  fix?: string;
}

/** GET /api/doctor：八项检查（按 DOCTOR_CHECKS 的先后）和查的时刻 */
export interface DoctorView {
  checks: DoctorCheckView[];
  /** 查的时刻（ISO） */
  at: string;
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
