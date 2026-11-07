// 体检的话（409）：原来八项的事实怎么拼成一句、"怎么修"、名字，一句话（DoctorMessage）按当前语言拼——
// 守护进程（拼好放进 DoctorView 的 text、秘书的体检工具读的句子）和网页（演示页的假数据、八项的老测试）都用这一份；
// 319b 时它在网页的 app/doctor.ts 里，守护进程也要拼了才挪到这里。文案在 locales/*/doctor.json。
// 不引用 TypeBox：网页只用常量、类型和这几个函数。
import { DOCTOR_FIX_UNKNOWN, type DoctorCheckDataById, type DoctorCheckId, type DoctorCheckView, type DoctorItemView, type DoctorLevel, type DoctorMessage } from "./doctor.ts";
import { formatList, formatNumber, t, tTable } from "./i18n/runtime.ts";

/** 组件打开的功能（清单里 enables 的 id）在页面上的叫法；不认得的功能写 id 本身 */
const FEATURE_NAME = tTable({
  "memory.semantic": "doctor.feature.memorySemantic",
  "voice.input": "doctor.feature.voiceInput",
  "voice.reply": "doctor.feature.voiceReply",
  "runtime.claude-code": "doctor.feature.runtimeClaudeCode",
});

const featureName = (id: string): string => (FEATURE_NAME as Readonly<Record<string, string>>)[id] ?? id;

/** GB 数按当前语言写（一位小数） */
const gb = (n: number) => formatNumber(n, { maximumFractionDigits: 1 });

/** 一句话按当前语言拼出来（键 + 参数） */
export function doctorText(message: DoctorMessage): string {
  return t(message.key, message.params);
}

/**
 * 八项各自的事实写成一句话：顶层那句的键和参数（参数里嵌的小句——"在听，是二狗自己"、缺的功能的名字——已经按当前语言写好）
 */
const FACT: { readonly [Id in DoctorCheckId]: (data: DoctorCheckDataById[Id]) => DoctorMessage } = {
  ports: (data) => ({
    key: "doctor.fact.ports",
    params: {
      local: data.local,
      external: data.external,
      localState: t(data.localUp ? "doctor.fact.portsUp" : "doctor.fact.portsDown"),
      externalState: t(data.externalUp ? "doctor.fact.portsUp" : "doctor.fact.portsDown"),
    },
  }),
  node: (data) => ({ key: "doctor.fact.node", params: { running: data.running, expected: data.expected } }),
  pi: (data) => (data.version === undefined ? { key: "doctor.fact.piMissing" } : { key: "doctor.fact.pi", params: { version: data.version } }),
  supervisor: (data) => {
    if (!data.running) return { key: "doctor.fact.supervisorDown" };
    const base: DoctorMessage = data.port === undefined ? { key: "doctor.fact.supervisorNoPort" } : { key: "doctor.fact.supervisor", params: { port: data.port } };
    // 410：命令行有回应，但二狗和它的连接断着（在重连）
    return data.link === "waiting" ? { key: "doctor.fact.supervisorLinkWaiting", params: { base: doctorText(base) } } : base;
  },
  model: (data) => ({ key: data.configured ? "doctor.fact.model" : "doctor.fact.modelMissing" }),
  components: (data) => (data.missing.length === 0 ? { key: "doctor.fact.components" } : { key: "doctor.fact.componentsMissing", params: { features: formatList(data.missing.map(featureName)) } }),
  disk: (data) => {
    const base: DoctorMessage = { key: "doctor.fact.disk", params: { path: data.path, free: gb(data.freeGb), total: gb(data.totalGb) } };
    // 410：服务管家的数据和日志在另一个卷上时一并写
    if (data.supervisor === undefined) return base;
    const svc = data.supervisor;
    return { key: "doctor.fact.diskSupervisor", params: { base: doctorText(base), path: svc.path, free: gb(svc.freeGb), total: gb(svc.totalGb) } };
  },
  // 没查到依据时只说查到的（服务管家里没登记），不断言"没配"：手动跑的 tailscale serve 服务管家不知道
  external: (data) => {
    const found: DoctorMessage = !data.configured
      ? { key: "doctor.fact.externalUnregistered" }
      : data.kind === "paired"
        ? { key: "doctor.fact.externalPaired", params: { count: data.devices ?? 0 } }
        : { key: "doctor.fact.external", params: { kind: t(`doctor.kind.${data.kind ?? "tailscale"}`) } };
    let message = found;
    const rejected = data.rejected ?? [];
    // 服务管家给了、手机用不了的入口：写清是哪个、为什么（接错端口是要修的事故）
    if (rejected.length > 0) {
      const entries = rejected.map((r) => (r.reason === "wrong_port" ? t("doctor.fact.externalRejected.wrongPort", { url: r.url, port: r.port ?? "?" }) : t("doctor.fact.externalRejected.notHttps", { url: r.url })));
      message = { key: "doctor.fact.externalRejected", params: { base: doctorText(message), count: rejected.length, entries: formatList(entries) } };
    }
    // 410：服务管家从外面打不通的入口（登记了不等于通）：哪个、为什么
    const unreachable = (data.entries ?? []).filter((entry) => entry.reachable === false);
    if (unreachable.length > 0) {
      const list = unreachable.map((entry) => (entry.why ? t("doctor.fact.externalUnreachable.why", { url: entry.url, why: entry.why }) : entry.url));
      const key = unreachable.length === data.entries!.length ? "doctor.fact.externalUnreachableAll" : "doctor.fact.externalUnreachable";
      message = { key, params: { base: doctorText(message), bad: unreachable.length, total: data.entries!.length, entries: formatList(list) } };
    }
    // 二狗和服务管家的连接停在等待：入口通不通是断之前的结果
    if (data.link === "waiting") message = { key: "doctor.fact.externalLinkWaiting", params: { base: doctorText(message) } };
    return message;
  },
};

/** 八项里一项查出来的事实（一句话的键和参数）；这次没查出来的是"这次没查出来"（data 是空值，不能拿它拼句子） */
export function doctorCheckFact(check: DoctorCheckView): DoctorMessage {
  if (check.fix === DOCTOR_FIX_UNKNOWN) return { key: "doctor.fact.unknown" };
  return (FACT[check.id] as (data: DoctorCheckView["data"]) => DoctorMessage)(check.data);
}

/** 八项里一项的事实写成一句话 */
export function doctorFactText(check: DoctorCheckView): string {
  return doctorText(doctorCheckFact(check));
}

/** 八项里一项"怎么修"那一句（没有就不写）；这一项查不了时说的是"再查一遍" */
export function doctorFixText(check: DoctorCheckView): string | undefined {
  return check.fix === undefined ? undefined : t(check.fix);
}

/** 八项里一项的名字（按当前语言） */
export function doctorCheckTitle(id: DoctorCheckId): string {
  return t(`doctor.check.${id}.title`);
}

/** 一项的三句话按当前语言拼好（DoctorItemView 的 text） */
export function doctorItemText(item: Pick<DoctorItemView, "title" | "fact" | "fix">): DoctorItemView["text"] {
  return { title: doctorText(item.title), fact: doctorText(item.fact), ...(item.fix === undefined ? {} : { fix: doctorText(item.fix) }) };
}

/** 八项里的一项写成"二狗本身"那一块里的一项（结果几种由守护进程判好交来，level） */
export function coreDoctorItem(check: DoctorCheckView, level: DoctorLevel): DoctorItemView {
  const title: DoctorMessage = { key: `doctor.check.${check.id}.title` };
  const fact = doctorCheckFact(check);
  const fix: DoctorMessage | undefined = check.fix === undefined ? undefined : { key: check.fix };
  const shape = { title, fact, ...(fix === undefined ? {} : { fix }) };
  return { id: check.id, level, ...shape, text: doctorItemText(shape) };
}
