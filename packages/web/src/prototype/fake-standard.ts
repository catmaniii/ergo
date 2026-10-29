// 原型的项目规范（258 号票）：照假项目的类型和状态编一份只读接口的返回——筹备中的都还是模板原样，建设中的规格、进展写了，
// 用了一阵的都写了；"旧作品集网站"当作规范上线之前建的项目（没有版本、缺架构图），看得到"缺"长什么样。
// 261 号票："家庭网盘"有本项目的规范改写（不要架构图、进展按周写；还有一张等你确认的"规范改写"卡：多一份运维手册、跟新版规范），
// 原型里假装框架已经出了 v2（只有它看得到"有新版"）。
// 262 号票：旧作品集网站还有一张等你选的"补齐规范文档"卡（fake-conversations.ts），项目页"规范"一块下面看得到。
import {
  type GoLiveChecklistItem,
  PROJECT_STANDARD_LATEST,
  type Project,
  type ProjectStandardView,
  STANDARD_CHECKLIST_ITEM_LABEL,
  STANDARD_CHECKLIST_TO,
  type StandardDocView,
  type StandardOverrideEntry,
  type StandardOverrideView,
  standardOverrideText,
} from "../state/index.ts";
import { FAKE_PROJECTS } from "./fake-data.ts";

const AT = "2026-10-06T22:30:00.000+08:00";

/** 规范上线之前建的假项目 */
const LEGACY = new Set(["p-oldsite"]);

/** 有规范改写的假项目（261 号票）：家庭网盘不画架构图、进展按周写；原型里假装框架出了 v2 */
const NETDISK = "p-netdisk";
const NETDISK_LATEST = "v2";
const NETDISK_WHY = "家里自己用的网盘：不画架构图，进展按周写一节就够";
const NETDISK_OVERRIDES: ReadonlyArray<StandardOverrideEntry & { why: string; path: string }> = [
  { kind: "drop", doc: "architecture", revision: 1, confirmedAt: "2026-10-05T20:12:00.000+08:00", why: NETDISK_WHY, path: "architecture.md" },
  { kind: "change", doc: "progress", note: "按周写，每周一节", revision: 1, confirmedAt: "2026-10-05T20:12:00.000+08:00", why: NETDISK_WHY, path: "progress.md" },
];

/** 家庭网盘现在生效的改写（一句话按现在的语言现取） */
const netdiskOverrides = (): StandardOverrideView[] => NETDISK_OVERRIDES.map((o) => ({ ...o, summary: standardOverrideText(o) }));

/** 编的：这份写了没有 */
function written(p: Project, key: StandardDocView["key"]): boolean {
  if (p.state === "preparing") return false;
  if (p.state === "building") return key === "spec" || key === "progress";
  return true;
}

function docs(p: Project): StandardDocView[] {
  const legacy = LEGACY.has(p.id);
  const overrides = p.id === NETDISK ? NETDISK_OVERRIDES : [];
  const doc = (key: StandardDocView["key"], path: string, role: StandardDocView["role"], fromTemplate = true): StandardDocView => {
    const o = overrides.find((x) => x.kind !== "add" && x.doc === key);
    const override = o ? { override: o.kind } : {};
    if (o?.kind === "drop") return { key, path, role, exists: false, ...override };
    if (legacy && (key === "architecture" || key === "tickets" || key === "ops")) return { key, path, role, exists: false };
    return { key, path, role, exists: true, modifiedAt: AT, ...(fromTemplate ? { untouched: !legacy && !written(p, key) } : {}), ...override };
  };
  const dev = p.kind === "dev";
  return [
    doc("spec", "spec.md", "required"),
    ...(dev ? [doc("architecture", "architecture.md", "required")] : []),
    doc("progress", "progress.md", "required"),
    doc("adr", "adr/", "required"),
    ...(dev ? [doc("tickets", "tickets/", "kind"), doc("ops", "ops.json", "before_in_use")] : []),
    doc("charter", "charter.md", "auxiliary", false),
    doc("glossary", "glossary.md", "auxiliary", false),
    doc("manifest", "manifest.md", "auxiliary", false),
    doc("scopeRecords", "scope-records.md", "auxiliary", false),
  ];
}

/** 原型里一个项目的规范；不是假项目的（真连接建出的项目不会走到这里）没有 */
export function fakeProjectStandard(projectId: string): ProjectStandardView | undefined {
  const p = FAKE_PROJECTS.find((x) => x.id === projectId);
  if (!p) return undefined;
  const to = STANDARD_CHECKLIST_TO[p.state];
  return {
    projectId,
    version: LEGACY.has(p.id) ? null : PROJECT_STANDARD_LATEST,
    latest: p.id === NETDISK ? NETDISK_LATEST : PROJECT_STANDARD_LATEST,
    kind: p.kind ?? null,
    docs: docs(p),
    checklist: { from: p.state, to, items: to === null ? [] : [{ id: "progress_written", label: STANDARD_CHECKLIST_ITEM_LABEL.progress_written, done: written(p, "progress") }] },
    overrides: p.id === NETDISK ? netdiskOverrides() : [],
  };
}

/**
 * 原型里项目页点"转入使用"出的卡上的清单（259 号票）：照上面编的写了没有——开发类五项（架构图、ops.json 还是模板原样，没有服务的两项
 * 算做到），其他类只查进展
 */
export function fakeGoLiveChecklist(p: Project): GoLiveChecklistItem[] {
  const L = STANDARD_CHECKLIST_ITEM_LABEL;
  const progress: GoLiveChecklistItem = written(p, "progress")
    ? { id: "progress_written", label: L.progress_written, done: true }
    : { id: "progress_written", label: L.progress_written, done: false, detail: "progress.md 还是模板原样" };
  if (p.kind !== "dev") return [progress];
  return [
    { id: "architecture", label: L.architecture, done: false, detail: "architecture.md 还是模板原样" },
    { id: "ops", label: L.ops, done: false, detail: "ops.json 还是模板原样" },
    { id: "services", label: L.services, done: true, detail: "没有服务，不用登记" },
    { id: "public_entry", label: L.public_entry, done: true, detail: "不要外网" },
    progress,
  ];
}
