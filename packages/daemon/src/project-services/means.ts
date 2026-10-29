// 运营手段"服务"（133 号票，在 130 号票的运营手段登记表里登记）：项目做成一个服务，用户在卡上确认一次就到 LSM 上线（登记、启动、
// 开机自启），有网页的经二狗转发（/apps/<项目编号>-<服务名>/），项目卡片上有入口，点了在内置浏览器里打开。
// - 校验（check / checkPlan / normalize，spec.ts）：服务名、启动命令、工作目录不出界、环境变量里没有密钥、端口不撞二狗自己的和
//   别的项目的服务；补齐成绝对路径、默认值；
// - 前缀下自检（selfCheck）：有网页的，交的时候服务正好在跑就抓首页查一遍（132 号票的 checkAppPrefix），不守前缀约定的整份退回；
//   没在跑的写进工具结果"上线后再查"；
// - 卡上的说法（describe）："上线服务「X」（端口 …，开机自启）"；
// - 生效（apply）：不建任务，追加"该在 LSM 上"（service_desired，present），真正的登记、启动在事务之后由 project-services.ts 异步做；
// - 撤销（revoke）：方案里去掉了、改了要重建的，追加"撤下"（改了的接着由 apply 追加新的"该在 LSM 上"：同一个名字的照最新的做，
//   就是更新登记、重启）；
// - 还跑着没有（alive）：该在 LSM 上、还在上线中或上线了、LSM 没说它失败或没了——不然照旧的再交一份就是"重新开起来"；
// - 暂停 / 恢复（项目停用、归档 / 重新启用、取消归档）：撤下 / 重新上线。
import { OPERATION_SERVICE_MEANS, type OperationItem, type Project, serviceTriggerText, t } from "@ergo/protocol";
import type { PrefixCheckResult } from "../apps/prefix-check.ts";
import { prefixCheckReport } from "../apps/prefix-check.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import { type OperationMeans, OPERATIONS_CHANNEL } from "../projects/api.ts";
import { PROJECT_SERVICE_EVENTS, type ServiceDesiredPayload, type ServiceDesiredWhy } from "./events.ts";
import { normalizeService, serviceCwd, servicePlanProblems, serviceProblems, type ServiceSpecContext, type TakenPorts } from "./spec.ts";
import { portHolderText, selfCheckText, specText } from "./texts.ts";
import { serviceRow, serviceRows } from "./views.ts";
import type { ServiceStatus } from "@ergo/protocol";

export interface ServiceMeansDeps {
  store: EventStore;
  /** 项目的工作目录、项目档案（真实路径） */
  paths(project: Project): { workdir: string; records: string };
  /** 二狗自己的端口（本机、外网） */
  daemonPorts(): { local: number; external: number };
  /** LSM 推来的在不在线 */
  status(app: string): ServiceStatus;
  /** 前缀下自检（apps/prefix-check.ts 的 checkAppPrefix） */
  prefixCheck(target: string, app: string, prefix: "strip" | "keep"): Promise<PrefixCheckResult>;
  /** 交的时候自检最多等多久（毫秒） */
  selfCheckTimeoutMs?: number;
  now(): string;
}

const SELF_CHECK_TIMEOUT_MS = 3_000;

export function serviceMeans(deps: ServiceMeansDeps): OperationMeans {
  const { store } = deps;

  /** 不能用的端口：二狗自己的、别的项目（和这个项目别的服务）现在该在 LSM 上的 */
  const takenPorts = (app: string): TakenPorts => {
    const ports = deps.daemonPorts();
    const taken = new Map<number, string>([
      [ports.local, portHolderText.daemonLocal()],
      [ports.external, portHolderText.daemonExternal()],
    ]);
    for (const row of serviceRows(store.reader)) {
      if (row.app !== app && row.desired.present) taken.set(row.desired.service.port, portHolderText.service(row.projectId, row.desired.title));
    }
    return taken;
  };

  const specContext = (project: Project): ServiceSpecContext => ({ projectId: project.id, ...deps.paths(project), takenPorts });

  /** 这一条的"该在 LSM 上 / 撤下" */
  const desired = (item: OperationItem, project: Project, present: boolean, why: ServiceDesiredWhy, key: string): NewEvent => {
    const payload: ServiceDesiredPayload = { projectId: project.id, key: item.key, title: item.name, app: item.service!.app, present, service: item.service!, why, time: deps.now() };
    return { channel: OPERATIONS_CHANNEL, type: PROJECT_SERVICE_EVENTS.desired, payload, idempotencyKey: `${key}#service:${item.service!.app}:${present ? "up" : "down"}` };
  };

  return {
    id: OPERATION_SERVICE_MEANS,
    get label() {
      return t("projectServices.means.label");
    },
    // @i18n-ignore-start model：工具说明
    hint:
      "项目做成一个要常驻的服务（网页、接口……）时用：确认后运行时交给 Local Service Manager 登记、启动、开机自启，有网页的经二狗转发、项目卡片上有入口，用户点了在内置浏览器里打开。" +
      "写 service：name 服务名、command 启动命令、port 端口（你定，撞了会被拒）、cwd 工作目录（相对项目的工作目录，不能出界）、env 环境变量（密钥不写值，写 secret 引用密钥区里的文件，或 userEnv）、health 健康检查、autostart 开机自启（默认开）、autoRestart 挂了自动重启（默认关，要一直在线、重拉没坏处的才开）、web 有网页的写首页路径和前缀约定；" +
      "instructions 写这个服务是做什么的；capabilities 写 {}。不写 schedule、event、workflow",
    // @i18n-ignore-end
    automatic: true,
    check: (item, ctx) => serviceProblems(item, specContext(ctx.project)),
    checkPlan: (items) => servicePlanProblems(items),
    normalize: (item, draft, ctx) => ({ ...item, service: normalizeService(draft.service!, specContext(ctx.project)) }),
    async selfCheck(item) {
      const s = item.service;
      if (!s?.web) return { problems: [], notes: [] };
      const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), deps.selfCheckTimeoutMs ?? SELF_CHECK_TIMEOUT_MS).unref());
      try {
        const result = await Promise.race([deps.prefixCheck(`http://127.0.0.1:${s.port}`, s.app, s.web.prefix), timeout]);
        if (result === "timeout") return { problems: [], notes: [selfCheckText.notRunning(item.name, s.port)] };
        if (result.findings.length > 0) return { problems: [selfCheckText.problems(prefixCheckReport(result))], notes: [] };
        return { problems: [], notes: [selfCheckText.passed(item.name)] };
      } catch {
        return { problems: [], notes: [selfCheckText.notRunning(item.name, s.port)] };
      }
    },
    describe: (item) => (item.service ? serviceTriggerText(item.name, item.service) : t("projectServices.means.trigger")),
    apply(item, ctx) {
      const s = item.service;
      if (!s) throw new RequestRejected("bad_params", specText.needService());
      // 交上来之后可能变了：别的项目的服务占了这个端口、工作目录没了
      const holder = takenPorts(s.app).get(s.port);
      if (holder !== undefined) throw new RequestRejected("conflict", specText.portTaken(s.port, holder));
      if (serviceCwd({ cwd: s.cwd }, deps.paths(ctx.project)).real === undefined) throw new RequestRejected("not_found", specText.cwdMissing(s.cwd));
      return { events: [desired(item, ctx.project, true, "confirmed", ctx.key)] };
    },
    revoke(_binding, ctx) {
      const s = ctx.item.service;
      if (!s) return [];
      const row = serviceRow(store.reader, s.app);
      return row?.desired.present ? [desired(ctx.item, ctx.project, false, "removed", ctx.key)] : [];
    },
    alive(_binding, { item }) {
      const s = item.service;
      if (!s) return false;
      const row = serviceRow(store.reader, s.app);
      if (!row?.desired.present) return false;
      const state = row.rollout?.state;
      if (state === undefined) return true;
      if (state !== "live") return false;
      const now = deps.status(s.app);
      return now !== "failed" && now !== "missing";
    },
    pause(_binding, ctx) {
      const s = ctx.item.service;
      const row = s && serviceRow(store.reader, s.app);
      return row?.desired.present ? [desired(ctx.item, ctx.project, false, "retired", ctx.key)] : [];
    },
    resume(_binding, ctx) {
      // 生效过的（视图里有它）才重新上线：确认时就没生效的（端口撞了……）不在这里开起来
      const s = ctx.item.service;
      const row = s && serviceRow(store.reader, s.app);
      return row && !row.desired.present ? [desired(ctx.item, ctx.project, true, "reactivated", ctx.key)] : [];
    },
  };
}
