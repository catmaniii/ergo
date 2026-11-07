// 设置 · 数据与设备 · 服务（428）：在二狗里看和开关服务管家里"和二狗有关的"服务（判定在 ergo-related.ts，别的服务不出现）。
// 守护进程经它和服务管家之间那条带身份的连接（管理指令，packages/supervisor/docs/link-protocol.md §9）取列表、启停、看日志，
// 和秘书的服务管家工具（418）走同一条通道、守同样的规矩：
// - 二狗离不开的（命脉：二狗自己、它的外网隧道、tailnet 网关……）不给停、重启、关开机自启，守护进程先在本地拒一遍，服务管家最后裁决；
// - 用户亲手点的不出审批卡；强制停有正常停止办法的服务、关开机自启，网页上先弹一个确认框（MANAGED_SERVICE_CONFIRM_ACTIONS）；
// - 没有正常停止 / 重启办法的服务，点"停止""重启"就直接强制停 / 强制重启（用户 11-07 定的，和 418 一样），结果里写明；
// - 日志截短、擦掉像密钥的，和秘书的 lsm_logs 同一套。
// 形状：GET /api/managed-services（ManagedServicesView）、POST /api/managed-services/<id>（请求体在 managed-services-schema.ts，
// 回 ManagedServiceActionResult）、GET /api/managed-services/<id>/logs（ManagedServiceLogsView）。给人看的字由网页按当前语言拼；
// 服务管家写的原因（lastError、受保护的原因、失败的 message）是它的话，原样带过来。不引用 TypeBox。
import type { ErgoUse } from "./ergo-related.ts";

/** 和服务管家的管理指令通不通：disabled 二狗不是服务管家拉起来的；waiting 还没连上；unsupported 服务管家太老；supported 能用 */
export const MANAGED_SERVICES_SUPPORT = ["disabled", "waiting", "unsupported", "supported"] as const;
export type ManagedServicesSupport = (typeof MANAGED_SERVICES_SUPPORT)[number];

/**
 * 二狗为什么离不开它（受保护）：self 二狗自己；tunnel 二狗的外网隧道；gateway tailnet 网关；other 别的（服务管家写的原因在 why 里，
 * 比如二狗硬依赖它、登记里标了 lifeline: true）
 */
export type ManagedServiceProtection = { kind: "self" | "tunnel" | "gateway" | "other"; why: string[] };

/** 页面上的一个服务 */
export interface ManagedServiceView {
  /** 服务管家里的全名（名下的是 ergo-daemon--<名字>） */
  id: string;
  /** 登记里的名字（没写是 id） */
  title: string;
  /** STOPPED / STARTING / RUNNING / DEGRADED / STOPPING / FAILED / ORPHAN；认不得的原样 */
  state: string;
  /** 在跑（RUNNING、DEGRADED） */
  up: boolean;
  port: number | null;
  /** 开机自启（在服务管家的开机名单上） */
  autostart: boolean;
  /** 从什么时候起在跑（毫秒时间戳）；没在跑、不知道是 null */
  since: number | null;
  /** 服务管家记的最后一次出错（起不来、停不下的原因） */
  lastError: string | null;
  /** 为什么和二狗有关（按 ERGO_USES 的先后，至少一条） */
  uses: ErgoUse[];
  /** 有正常的停止办法：没有的"停止"会直接强制停 */
  canStop: boolean;
  /** 有正常的重启办法：没有的"重启"会先强制停再起来 */
  canRestart: boolean;
  /** 接入了忙闲、现在正忙，和忙的原因（服务自己报的） */
  busy: boolean;
  busyReason: string | null;
  /** 挂着"等空闲再停" */
  pendingStop: boolean;
  /** 二狗离不开它：不给停止、重启、关开机自启 */
  protection?: ManagedServiceProtection;
}

/** GET /api/managed-services */
export interface ManagedServicesView {
  support: ManagedServicesSupport;
  /** 和二狗有关的服务（二狗自己在最前）；取不到时是空的 */
  services: ManagedServiceView[];
  /** support 是 supported 却没取到列表：原因（code 照服务管家、接入层的错误码，message 是它们的话） */
  error?: { code: string; message: string };
  /** 服务管家的网页（只在装二狗的那台电脑上打得开）；二狗不是服务管家拉起来的没有 */
  managerUrl?: string;
  /** 取的时刻（毫秒） */
  at: number;
}

/** 页面上能点的操作 */
export const MANAGED_SERVICE_ACTIONS = ["start", "stop", "force_stop", "restart", "cancel_stop", "autostart_on", "autostart_off"] as const;
export type ManagedServiceAction = (typeof MANAGED_SERVICE_ACTIONS)[number];

/** 点了先弹确认框的：强制停（有正常停止办法时才有这个按钮）、关开机自启 */
export const MANAGED_SERVICE_CONFIRM_ACTIONS: readonly ManagedServiceAction[] = Object.freeze(["force_stop", "autostart_off"]);

/** 对受保护的服务不能做的（守护进程本地先拒，服务管家也会回 protected） */
export const MANAGED_SERVICE_GUARDED_ACTIONS: readonly ManagedServiceAction[] = Object.freeze(["stop", "force_stop", "restart", "autostart_off"]);

/**
 * POST /api/managed-services/<id> 的结果。ok 时：forced 是没有正常办法、自动改成了强制停 / 强制重启；already 本来就是那样；
 * pending 排上了（正忙，等空闲再停）；note 是服务管家另外交代的；service 是做完之后的样子（服务管家带了才有）。
 * 失败时 code 是错误码（服务管家、接入层的，加上这边的 not-related：不是和二狗有关的服务），message 是原因（服务管家的话原样）
 */
export type ManagedServiceActionResult =
  | { ok: true; action: ManagedServiceAction; forced?: boolean; already?: boolean; pending?: boolean; note?: string; service?: ManagedServiceView }
  | { ok: false; action: ManagedServiceAction; code: string; message: string; service?: ManagedServiceView };

/**
 * GET /api/managed-services/<id>/logs：最后几十行（行数不给按守护进程的默认，和秘书的 lsm_logs 一样；每行截短、擦掉像密钥的；
 * 太长只留最后的，cut 是前面还有被截掉的）。
 * label 是这一份日志的名字，sources 是这个服务一共有哪几份（source 是第几份，0 是命令行输出）
 */
export type ManagedServiceLogsView =
  | { ok: true; id: string; source: number; label: string; lines: string[]; cut: boolean; sources: { source: number; label: string }[] }
  | { ok: false; id: string; code: string; message: string };
