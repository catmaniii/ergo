// 项目的服务（133 号票，纯函数）：运营手段"服务"上线之后，项目卡、项目页（页头、运营方案那一节）、两张运营方案的卡、秘书给的入口卡上的
// "打开「X」"和在不在线。数据是项目列表频道上的临时事件 project_services（UiState.projectServices，守护进程按 LSM 推来的状态现算）。
// 点了怎么办：上线了、有网页的在内置浏览器里打开（服务不在线时转发给出"现在没在运行"的说明页）；还没上线、要你手动、上线失败的
// 不打开，提示原因。
import {
  type OperationService,
  type ProjectServiceView,
  serviceCanOpen,
  serviceEnvText,
  serviceOpenLabel,
  serviceShown,
  serviceStateText,
  type ServiceStateKind,
  t,
} from "./protocol.ts";
import type { UiState } from "./ui-state.ts";

/** 一个项目还算在上面的服务（撤下了的不算），按应用名 */
export function projectServicesOf(state: Pick<UiState, "projectServices">, projectId: string): ProjectServiceView[] {
  return state.projectServices.filter((v) => v.projectId === projectId && serviceShown(v));
}

/** 运营方案里的某一条对应的服务（撤下了的也给：项目页上写"已撤下"） */
export function serviceOfItem(state: Pick<UiState, "projectServices">, projectId: string, key: string): ProjectServiceView | undefined {
  return state.projectServices.find((v) => v.projectId === projectId && v.key === key);
}

export function serviceByApp(state: Pick<UiState, "projectServices">, app: string): ProjectServiceView | undefined {
  return state.projectServices.find((v) => v.app === app);
}

/** 入口的样子 */
export interface ServiceEntryView {
  /** "打开「简报站」" */
  label: string;
  /** 点了能不能在内置浏览器里打开 */
  canOpen: boolean;
  /** 状态的颜色 */
  kind: ServiceStateKind;
  /** "在线"、"离线"、"上线失败"…… */
  text: string;
  /** 原因、LSM 的说明 */
  detail?: string;
  /** 打不开时点了提示什么 */
  hint?: string;
}

export function serviceEntryView(view: ProjectServiceView): ServiceEntryView {
  const state = serviceStateText(view);
  const canOpen = serviceCanOpen(view);
  const base = { label: serviceOpenLabel(view.title), canOpen, kind: state.kind, text: state.text, ...(state.detail ? { detail: state.detail } : {}) };
  if (canOpen) return base;
  const hint =
    view.url === undefined
      ? t("state.projectServices.noWeb", { title: view.title })
      : state.detail
        ? t("state.projectServices.stateDetail", { title: view.title, state: state.text, detail: state.detail })
        : t("state.projectServices.state", { title: view.title, state: state.text });
  return { ...base, hint };
}

/** 点了入口做什么：上线了、有网页的在内置浏览器里打开（标题栏先写这一条的名字），别的提示原因 */
export type ServiceEntryClick = { kind: "open"; url: string; title: string } | { kind: "hint"; text: string };

export function serviceEntryClick(view: ProjectServiceView): ServiceEntryClick {
  const e = serviceEntryView(view);
  if (e.canOpen && view.url !== undefined) return { kind: "open", url: view.url, title: view.title };
  return { kind: "hint", text: e.hint ?? t("state.projectServices.state", { title: view.title, state: e.text }) };
}

/** 开关的说法："开""关" */
const onOff = (on: boolean): string => t(on ? "state.projectServices.on" : "state.projectServices.off");

/** 服务那一条的细节一项项（卡上、项目页上）：启动命令、工作目录、端口、环境变量、健康检查、开机自启、挂了自动重启（开着才列）、网页 */
export function serviceSpecRows(s: OperationService): Array<{ label: string; value: string }> {
  const web = s.web ? `/apps/${s.app}${s.web.home}` : undefined;
  return [
    { label: t("state.projectServices.spec.command"), value: s.command },
    { label: t("state.projectServices.spec.cwd"), value: s.cwd },
    { label: t("state.projectServices.spec.port"), value: String(s.port) },
    ...(s.env.length > 0 ? [{ label: t("state.projectServices.spec.env"), value: s.env.map(serviceEnvText).join(t("state.projectServices.listSep")) }] : []),
    ...(s.health ? [{ label: t("state.projectServices.spec.health"), value: s.health.path }] : []),
    { label: t("state.projectServices.spec.autostart"), value: onOff(s.autostart) },
    ...(s.autoRestart ? [{ label: t("state.projectServices.spec.autoRestart"), value: onOff(true) }] : []),
    {
      label: t("state.projectServices.spec.web"),
      value: web === undefined ? t("state.projectServices.spec.noWeb") : s.web?.prefix === "keep" ? t("state.projectServices.spec.webKeepPrefix", { path: web }) : web,
    },
  ];
}

/** 改了的服务，改了哪几处 */
export function serviceChangedFields(before: OperationService, after: OperationService): string[] {
  const out: string[] = [];
  if (before.name !== after.name) out.push(t("state.projectServices.changed.name", { before: before.name, after: after.name }));
  if (before.command !== after.command) out.push(t("state.projectServices.changed.command", { before: before.command, after: after.command }));
  if (before.cwd !== after.cwd) out.push(t("state.projectServices.changed.cwd", { before: before.cwd, after: after.cwd }));
  if (before.port !== after.port) out.push(t("state.projectServices.changed.port", { before: before.port, after: after.port }));
  if (JSON.stringify(before.env) !== JSON.stringify(after.env)) out.push(t("state.projectServices.changed.env"));
  if (JSON.stringify(before.health ?? null) !== JSON.stringify(after.health ?? null)) out.push(t("state.projectServices.changed.health"));
  if (before.autostart !== after.autostart) out.push(t("state.projectServices.changed.autostart", { before: onOff(before.autostart), after: onOff(after.autostart) }));
  if (before.autoRestart !== after.autoRestart) out.push(t("state.projectServices.changed.autoRestart", { before: onOff(before.autoRestart), after: onOff(after.autoRestart) }));
  if (JSON.stringify(before.web ?? null) !== JSON.stringify(after.web ?? null)) out.push(t("state.projectServices.changed.web"));
  return out;
}
