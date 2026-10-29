// 运营手段"服务"（133 号票）的一个服务写得对不对、补齐成什么样、交给 LSM 的定义长什么样（纯函数，文件系统只看在不在）：
// - 工作目录：相对项目的工作目录写（不写就是工作目录本身），或者写绝对路径；按真实路径（展开符号链接、目录联接）看，要在项目的
//   工作目录或项目档案里面（不能出界），要已经存在；
// - 环境变量：普通的值（value）、密钥的引用（secret：二狗数据目录密钥区 secrets/ 里的文件名，上线时由 LSM 从那个文件读出来注入，
//   照 ergo-daemon 自己的模型 key 的规矩）、用户级环境变量（userEnv）三选一。方案里不许有密钥：看名字像密钥的（照 LSM 的
//   SECRET_NAME_RE）不许写值，看值像密钥的（sk-…、ghp_…、一长串随机的字母数字）也拒；LSM_ 开头的、ERGO_BASE_PATH（有网页的
//   由运行时注入）不能自己写；
// - 端口：由维护者给（服务管家不分配端口），不能是二狗自己的端口，不能和别的项目现在在 LSM 上的服务撞（和 LSM 里别的服务撞了
//   LSM 登记时会拒，原因写进"上线失败"）；
// - 同一份方案里两个服务不能同名、同端口（checkPlan）。
// 交给 LSM 的定义（LSM 的 docs/link-protocol.md §7.4）：名字是 <项目编号>-<服务名>，密钥的引用换成密钥区里的绝对路径（from: file），
// 有网页的多注入一个 ERGO_BASE_PATH（/apps/<应用名>，132 号票的前缀约定）；不写停机命令（停、重启都带 force），不写 autoRestart（默认关）；
// 命令开头是 node 的换成二狗自己那份 Node（withOwnNode：项目服务跟着二狗的 Node 版本走，用安装包装的电脑上 PATH 里可能根本没有 node）。
import fs from "node:fs";
import path from "node:path";
import { APP_BASE_PATH_ENV, appBasePath, appUrl, isNameOrOld, oldNameOf, OPERATION_SERVICE_MEANS, type OperationItemDraft, type OperationService, type OperationServiceDraft, serviceAppName } from "@ergo/protocol";
import type { LsmServiceDefinition } from "../lsm/link.ts";
import { realPathOf } from "../util/real-path.ts";
import { specText } from "./texts.ts";

/** 看名字像密钥的变量（照 LSM 的 src/owned.mjs：按下划线分段认） */
const SECRET_NAME = /(?:^|_)(?:API_?KEY|SECRET(?:_KEY)?|TOKEN|PASSW(?:OR)?D|CREDENTIALS?|PRIVATE_KEY|ACCESS_KEY)(?:_|$)/i;

/** 看值像密钥的：常见的几家的写法，或者 32 个以上字母数字混着、没有空格和路径符号的一长串 */
const SECRET_VALUES = [
  /^sk-[A-Za-z0-9_-]{16,}/,
  /^(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}/,
  /^xox[abposr]-[A-Za-z0-9-]{10,}/,
  /^AKIA[0-9A-Z]{16}$/,
  /^AIza[0-9A-Za-z_-]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
];
const looksRandom = (v: string) => /^[A-Za-z0-9_+=-]{32,}$/.test(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v);
export const looksLikeSecret = (value: string): boolean => SECRET_VALUES.some((re) => re.test(value)) || looksRandom(value);

/** 密钥区里的文件名：只许名字，不许路径 */
const SECRET_FILE = /^[A-Za-z0-9._-]{1,120}$/;

/** 别的服务占着的端口：说法（"二狗的本机端口"、"项目 p-2 的服务「看板」"） */
export type TakenPorts = ReadonlyMap<number, string>;

export interface ServiceSpecContext {
  projectId: string;
  /** 项目的工作目录、项目档案（真实路径） */
  workdir: string;
  records: string;
  /** 不能用的端口（二狗自己的端口、别的项目现在在 LSM 上的服务；同一个服务自己的不算）→ 说法 */
  takenPorts(app: string): TakenPorts;
}

/** a 在 b 里面（或就是 b）：按真实路径比，Windows 上不分大小写 */
function inside(a: string, b: string): boolean {
  const rel = path.relative(process.platform === "win32" ? b.toLowerCase() : b, process.platform === "win32" ? a.toLowerCase() : a);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 工作目录换成真实路径（不存在的是 undefined） */
export function serviceCwd(draft: Pick<OperationServiceDraft, "cwd">, ctx: Pick<ServiceSpecContext, "workdir">): { written: string; real: string | undefined } {
  const written = draft.cwd === undefined ? ctx.workdir : path.isAbsolute(draft.cwd) ? draft.cwd : path.resolve(ctx.workdir, draft.cwd);
  const real = realPathOf(written);
  return { written, real: real !== undefined && isDir(real) ? real : undefined };
}

const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** 一条服务写得对不对（这一条自己的；几条之间撞没撞见 servicePlanProblems）；对的是空数组 */
export function serviceProblems(item: OperationItemDraft, ctx: ServiceSpecContext): string[] {
  const s = item.service;
  if (!s) return [specText.needService()];
  const problems: string[] = [];
  if (item.schedule || item.event) problems.push(specText.noTrigger);
  if (item.approach === "workflow" || item.workflow) problems.push(specText.noWorkflow);
  if (item.manual) problems.push(specText.noManual);
  if (s.name.includes("--")) problems.push(specText.nameDash(s.name));
  if (/[\r\n]/.test(s.command)) problems.push(specText.commandOneLine);
  // 工作目录：在项目的工作目录或项目档案里，要存在
  const cwd = serviceCwd(s, ctx);
  if (cwd.real === undefined) problems.push(specText.cwdMissing(cwd.written));
  else if (!inside(cwd.real, ctx.workdir) && !inside(cwd.real, ctx.records)) problems.push(specText.cwdOutside(cwd.written, ctx.workdir, ctx.records));
  // 环境变量：三选一、不许密钥
  const seen = new Set<string>();
  for (const e of s.env ?? []) {
    const upper = e.name.toUpperCase();
    if (seen.has(upper)) problems.push(specText.envDuplicate(e.name));
    seen.add(upper);
    if (upper.startsWith("LSM_")) problems.push(specText.envLsm(e.name));
    if (isNameOrOld(upper, APP_BASE_PATH_ENV)) problems.push(specText.envBasePath);
    const sources = [e.value !== undefined, e.secret !== undefined, e.userEnv === true].filter(Boolean).length;
    if (sources !== 1) problems.push(specText.envOneSource(e.name));
    if (e.value !== undefined) {
      if (SECRET_NAME.test(e.name)) problems.push(specText.envSecretName(e.name));
      else if (looksLikeSecret(e.value)) problems.push(specText.envSecretValue(e.name));
      if (/[\r\n]/.test(e.value)) problems.push(specText.envOneLine(e.name));
    }
    if (e.secret !== undefined && (!SECRET_FILE.test(e.secret) || e.secret.startsWith("."))) problems.push(specText.envSecretFile(e.name, e.secret));
  }
  // 端口
  const app = serviceAppName(ctx.projectId, s.name);
  const holder = ctx.takenPorts(app).get(s.port);
  if (holder !== undefined) problems.push(specText.portTaken(s.port, holder));
  if (s.web?.home !== undefined && /\s/.test(s.web.home)) problems.push(specText.homeSpace);
  return problems;
}

/** 同一份方案里用"服务"的几条：不能同名、同端口 */
export function servicePlanProblems(items: readonly OperationItemDraft[]): string[] {
  const problems: string[] = [];
  const names = new Map<string, string>();
  const ports = new Map<number, string>();
  for (const item of items) {
    if (item.means !== OPERATION_SERVICE_MEANS || !item.service) continue;
    const name = names.get(item.service.name);
    if (name !== undefined) problems.push(specText.planSameName(item.service.name, name, item.name));
    else names.set(item.service.name, item.name);
    const port = ports.get(item.service.port);
    if (port !== undefined) problems.push(specText.planSamePort(item.service.port, port, item.name));
    else ports.set(item.service.port, item.name);
  }
  return problems;
}

/** 补齐（校验过了才叫）：工作目录换成真实路径，开机自启（开）、挂了自动重启（关）、首页、前缀约定补上默认 */
export function normalizeService(draft: OperationServiceDraft, ctx: ServiceSpecContext): OperationService {
  const cwd = serviceCwd(draft, ctx);
  return {
    name: draft.name,
    app: serviceAppName(ctx.projectId, draft.name),
    command: draft.command.trim(),
    cwd: cwd.real ?? cwd.written,
    env: (draft.env ?? []).map((e) => ({ ...e })),
    port: draft.port,
    ...(draft.health ? { health: { ...draft.health } } : {}),
    autostart: draft.autostart !== false,
    autoRestart: draft.autoRestart === true,
    ...(draft.web ? { web: { home: draft.web.home ?? "/", prefix: draft.web.prefix ?? "strip" } } : {}),
  };
}

/** 有网页的入口地址（/apps/<应用名>/<首页>） */
export const serviceUrl = (service: Pick<OperationService, "app" | "web">): string | undefined => (service.web ? appUrl(service.app, service.web.home.replace(/^\/+/, "")) : undefined);

/** 交给 LSM 的定义（services.put）：密钥的引用换成密钥区里的绝对路径，有网页的注入 ERGO_BASE_PATH（312 号票：另带一份旧名字的，早先做的服务照样读得到） */
export function lsmDefinition(service: OperationService, labels: { title: string; projectName: string }, secretsDir: string, nodePath?: string): LsmServiceDefinition {
  const env: NonNullable<LsmServiceDefinition["env"]> = service.env.map((e) => {
    if (e.secret !== undefined) return { name: e.name, from: "file", path: path.join(secretsDir, e.secret), ...(e.optional ? { optional: true } : {}) };
    if (e.userEnv) return { name: e.name, from: "userEnv", ...(e.optional ? { optional: true } : {}) };
    // LSM 把空值当成取不到：空值的算可选
    return { name: e.name, from: "literal", value: e.value ?? "", ...(e.optional || !e.value ? { optional: true } : {}) };
  });
  if (service.web) for (const name of [APP_BASE_PATH_ENV, oldNameOf(APP_BASE_PATH_ENV)]) env.push({ name, from: "literal", value: appBasePath(service.app) });
  return {
    name: service.app,
    title: oneLine80(`${labels.projectName} · ${labels.title}`),
    project: oneLine80(`二狗 · ${labels.projectName}`), // @i18n-ignore fixed：LSM 里的分组名，换语言不跟着变
    command: withOwnNode(service.command, nodePath),
    cwd: service.cwd,
    port: service.port,
    ...(env.length > 0 ? { env } : {}),
    ...(service.health ? { health: { path: service.health.path, ...(service.health.timeoutMs === undefined ? {} : { timeoutMs: service.health.timeoutMs }) } } : {}),
    autostart: service.autostart,
    // put 是整份替换：关着的也写上（关掉之前开着的）
    autoRestart: service.autoRestart,
  };
}

/** 命令开头的 node（或 node.exe）：后面是空白或命令结束 */
const NODE_HEAD = /^\s*node(?:\.exe)?(?=\s|$)/i;

/**
 * 命令开头是 node 的换成 nodePath（加引号：LSM 经 cmd.exe /d /s /c 跑字符串命令，路径带空格也认）；不给 nodePath、开头不是 node 的
 * （npm、python、带路径的 node……）原样不动。
 */
export function withOwnNode(command: string, nodePath: string | undefined): string {
  return nodePath && NODE_HEAD.test(command) ? command.replace(NODE_HEAD, `"${nodePath}"`) : command;
}

/** LSM 的 title、project 是一行字，最多 80 个字 */
const oneLine80 = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
};
