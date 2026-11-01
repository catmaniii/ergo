// 运营层对外的入口（280 号票，方案 C 第 4 点，docs/research/29-plugin-expansion-review.html）。运营层是 project-ops/（秘书的
// project_ops、维护者的 check_ops、运营接口清单的验收和登记）和 project-services/（替项目到 LSM 上线、撤下、一键启停、/apps 转发、
// 缩略图）两个目录，照插件的纪律写，但一直开着、不给开关（不是插件，ADR-0027 的"五个插件，其余留内核"照旧）：
// - 项目系统的其余部分（projects/、work-orders/、operations/）和内核只从这里拿运营层的东西，不 import 这两个目录里的别的文件；
//   装它的只有项目系统的组装函数（projects/system.ts 经 layer.ts 的 createOpsLayer，像插件清单装 plugin.ts）；
// - 运营层用项目系统的其余部分也只经项目系统的入口 projects/api.ts：哪天真拆成插件（方案 B），它已经站在接缝上；
// - 它的登记走宿主现成的登记口（layer.ts 的 OpsLayerContext：卡片类型、运营手段 ctx.operationMeans、转发 ctx.apps，每次登记返回撤销函数），
//   不再由组装函数替它把"服务"插进内核的运营手段、把整张转发登记表交给它。
// 前两条 test/projects/boundary.test.ts 守着，第三条 test/project-ops/layer.test.ts 看着。只放常量和类型，不 import 运营层的服务实现。
import type { HttpErrorCode, Project, ServiceEventReply, StandardChecklistItem } from "@ergo/protocol";
import type { HostTool } from "../agent-manager/host-tools.ts";
import type { NewEvent } from "../events/event-store.ts";

// —— 工具名（系统提示的占位符：prompts/registry.ts 经项目系统的入口取）——
export { CHECK_OPS_TOOL, PROJECT_OPS_TOOL } from "./tool-names.ts";
export { OPEN_SERVICE_TOOL, RECENT_SERVICE_EVENTS_TOOL, SWITCH_SERVICES_TOOL } from "../project-services/tool-names.ts";

// —— 项目系统的其余部分要的小接口（组装函数装好运营层，照这些交过去）——

/** 转入使用那一套（268 号票）：项目服务（projects/projects.ts）、秘书和维护者提转入使用的工具（projects/go-live-tools.ts）要的 */
export interface OpsGoLive {
  /** 转运营检查清单里运营接口清单那一项：照 112 号票的自动验收（没验过的在后台开验，验完了刷新还在等的卡） */
  checklistItem(project: Project): StandardChecklistItem;
  /** 转入使用时登记（和转入使用同一事务）：档案里那份运营接口清单验收全过了才有 */
  goLiveEvents(project: Project): NewEvent[];
  /** 提转入使用之前：档案里那份重验一遍（维护者、秘书提转入使用时等它，卡上直接是结论） */
  prepareGoLive(projectId: string): Promise<void>;
}

/** 谁在报事件（357 号票）：凭证认出来的服务 */
export interface ServiceEventCaller {
  /** LSM 里的名字（<项目编号>-<服务名>） */
  app: string;
  projectId: string;
  /** 维护者写的服务名 */
  service: string;
  /** 运营方案里这一条的名字 */
  title: string;
}

/** 报事件被拒：code 定 HTTP 状态，message 回给服务 */
export interface ServiceEventRefusal {
  ok: false;
  code: HttpErrorCode;
  message: string;
}

/** 网关的 POST /api/service-events 要的（357 号票，只在本机端口开）：先认凭证，再读请求体，再报 */
export interface ServiceEventsApi {
  /** 请求体最多读多少字节（数据上限加上事件名、JSON 的壳）；超了的不留在内存里，算 oversized 报 */
  readonly maxBodyBytes: number;
  /** 认凭证：没带（undefined）、不对、已作废的回明确的错 */
  authenticate(credential: string | undefined): { ok: true; caller: ServiceEventCaller } | ServiceEventRefusal;
  /** 报一次：oversized 是请求体超了上限，没读完（事件名也不知道） */
  report(caller: ServiceEventCaller, input: { event?: string; data?: unknown; oversized?: boolean }): { ok: true; reply: ServiceEventReply } | ServiceEventRefusal;
}

/** 秘书的工具里运营层给的（projects/secretary-tools.ts 接进项目系统给秘书的那几样）。先后是秘书看到的工具顺序（测试比对它） */
export interface OpsSecretary {
  /** 查看板时多的一节"项目的服务"（133 号票）；没有要列的是 undefined */
  boardSection(): string | undefined;
  /** 给出服务入口（133：open_service）、启停项目的服务（257：switch_project_services）、调使用中的项目的操作（260、268：project_ops）：按这个先后 */
  tools(): HostTool[];
}
