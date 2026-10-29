// 体检（319 号票的 319b）在网页上的这一半里"不碰浏览器"的那部分：取八项检查（GET /api/doctor）、演示页的假数据、
// 把每项查出来的结构化事实按当前语言拼成一句话、"怎么修"的文案；页面要的"再查一遍"也走这里的 loadDoctor。
// 八项是哪八项、形状是什么在共享协议包的 doctor.ts；真相在守护进程，这边一个字节也不存。
// 这些函数都不碰 window、不引 React（Node 里直接查，test/pages/doctor.test.ts）：钩子和演示页判断在 app/page-doctor.ts。
import {
  DOCTOR_CHECKS,
  DOCTOR_FIX_UNKNOWN,
  type DoctorCheckDataById,
  type DoctorCheckId,
  type DoctorCheckView,
  type DoctorView,
  formatDate,
  formatList,
  formatNumber,
  HTTP_PATHS,
  type HttpErrorBody,
  t,
  tTable,
} from "../state/index.ts";

/** 取八项检查现在各自的样子（GET /api/doctor，每次现查，不缓存） */
export async function fetchDoctor(): Promise<DoctorView> {
  const res = await fetch(HTTP_PATHS.doctor, { credentials: "same-origin" });
  if (!res.ok) {
    const error = (await res.json().catch(() => undefined)) as HttpErrorBody | undefined;
    throw new Error(error?.message ?? t("doctor.requestFailed", { status: res.status }));
  }
  return (await res.json()) as DoctorView;
}

/**
 * 取一遍：打开页面时、点"再查一遍"时都走这一条。演示页（没有守护进程）不请求网络，给编好的数据
 */
export async function loadDoctor(demo: boolean, load: () => Promise<DoctorView> = fetchDoctor): Promise<DoctorView> {
  return demo ? demoDoctorView() : load();
}

/** 演示页的假数据：六项是好的，组件缺记忆的向量模型、外网入口没配——各带一句"怎么修" */
export function demoDoctorView(): DoctorView {
  const data: { [Id in DoctorCheckId]: DoctorCheckDataById[Id] } = {
    ports: { local: 8810, external: 8811, localUp: true, externalUp: true },
    node: { running: "22.23.4", expected: "22" },
    pi: { version: "1.0.4" },
    supervisor: { running: true, port: 7420 },
    model: { configured: true },
    components: { missing: ["memory.semantic"] },
    disk: { freeGb: 42.3, totalGb: 476.8, path: "C:\\Users\\demo\\.ergo" },
    external: { configured: false },
  };
  return {
    checks: DOCTOR_CHECKS.map((id) => {
      const ok = id !== "components" && id !== "external";
      return { id, ok, data: data[id], ...(ok ? {} : { fix: `doctor.fix.${id}` }) };
    }),
    at: "2026-10-28T09:30:00.000Z",
  };
}

/** 组件打开的功能（清单里 enables 的 id）在页面上的叫法；不认得的功能写 id 本身 */
const FEATURE_NAME = tTable({
  "memory.semantic": "doctor.feature.memorySemantic",
  "voice.input": "doctor.feature.voiceInput",
  "voice.reply": "doctor.feature.voiceReply",
  "runtime.claude-code": "doctor.feature.runtimeClaudeCode",
});

const featureName = (id: string): string => (FEATURE_NAME as Readonly<Record<string, string>>)[id] ?? id;

/** 每一项的事实拼成一句话（端口号、版本号、剩多少 GB 都按当前语言写） */
const FACT: { readonly [Id in DoctorCheckId]: (data: DoctorCheckDataById[Id]) => string } = {
  ports: (data) =>
    t("doctor.fact.ports", {
      local: data.local,
      external: data.external,
      localState: t(data.localUp ? "doctor.fact.portsUp" : "doctor.fact.portsDown"),
      externalState: t(data.externalUp ? "doctor.fact.portsUp" : "doctor.fact.portsDown"),
    }),
  node: (data) => t("doctor.fact.node", { running: data.running, expected: data.expected }),
  pi: (data) => (data.version === undefined ? t("doctor.fact.piMissing") : t("doctor.fact.pi", { version: data.version })),
  supervisor: (data) =>
    data.running ? (data.port === undefined ? t("doctor.fact.supervisorNoPort") : t("doctor.fact.supervisor", { port: data.port })) : t("doctor.fact.supervisorDown"),
  model: (data) => t(data.configured ? "doctor.fact.model" : "doctor.fact.modelMissing"),
  components: (data) => (data.missing.length === 0 ? t("doctor.fact.components") : t("doctor.fact.componentsMissing", { features: formatList(data.missing.map(featureName)) })),
  disk: (data) =>
    t("doctor.fact.disk", {
      path: data.path,
      free: formatNumber(data.freeGb, { maximumFractionDigits: 1 }),
      total: formatNumber(data.totalGb, { maximumFractionDigits: 1 }),
    }),
  external: (data) =>
    data.configured ? t("doctor.fact.external", { kind: t(`doctor.kind.${data.kind ?? "tailscale"}`) }) : t("doctor.fact.externalMissing"),
};

/** 一项查出来的事实写成一句话；这次没查出来的写"这次没查出来"（data 是空值，不能拿它拼句子） */
export function doctorFactText(check: DoctorCheckView): string {
  if (check.fix === DOCTOR_FIX_UNKNOWN) return t("doctor.fact.unknown");
  return (FACT[check.id] as (data: DoctorCheckView["data"]) => string)(check.data);
}

/** "怎么修"那一句（没有就不写）；这一项查不了时说的是"再查一遍" */
export function doctorFixText(check: DoctorCheckView): string | undefined {
  return check.fix === undefined ? undefined : t(check.fix);
}

/** 一项的名字（八项各自的名字，按当前语言） */
export function doctorCheckTitle(id: DoctorCheckId): string {
  return t(`doctor.check.${id}.title`);
}

/** 查的时刻写成一句话（本地日期和时间） */
export function doctorAtText(view: DoctorView): string {
  return t("doctor.at", { time: formatDate(view.at, { dateStyle: "short", timeStyle: "medium" }) });
}
