// 秘书给出项目的服务的入口（133 号票）：用户对秘书说"打开简报站""简报站的页面在哪"时，秘书用 open_service 按名字（服务的名字、
// 项目的名字或编号）找到这个服务，把入口作为一张"服务入口卡"（service_entry）放进聊天——卡出来就是已处理（没有要用户选的），
// 卡上写"打开「X」"和在不在线（前端按手里的服务状态现画），点了在内置浏览器里打开。只产生卡片，不落入任何关注类别。
// 秘书查看板时也多一节"项目的服务"（serviceBoardSection，board/tool.ts 接上）。
// 257 号票：用户说"把简报站关了""把简报站开起来"时，秘书用 switch_project_services 按名字找到项目，交给和项目卡片、项目页上的
// "关闭""启动"同一个入口（ProjectServices.power）——用户说了就是确认，不另出卡；等一小会儿把做完的样子写进工具结果。
import { type ProjectServiceView, PURGED_TEXT, ServiceEntryCardPayload, serviceLine, serviceShown, t, Type } from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import type { CardService } from "../cards/cards.ts";
import { defineCardType } from "../cards/registry.ts";
import { RequestRejected } from "../errors.ts";
import type { ProjectServices } from "./project-services.ts";
import { boardText, openServiceText, switchServicesText } from "./texts.ts";
import { OPEN_SERVICE_TOOL, SWITCH_SERVICES_TOOL } from "./tool-names.ts";

export { OPEN_SERVICE_TOOL, SWITCH_SERVICES_TOOL };

/** 秘书启停之后最多等多久（毫秒）再交回结果：关闭、启动通常几秒；启动要等就绪，等不到的写"还没做完" */
export const SWITCH_SERVICES_SETTLE_MS = 20_000;

/** 一次最多给几个入口（名字对得上好几个时） */
const MAX_ENTRIES = 3;

/** 比的时候不看大小写和空白 */
const norm = (text: string) => text.toLowerCase().replace(/\s+/g, "");

/** 按名字找：完全对得上的优先，其次是互相包含的 */
export function findServices(views: readonly ProjectServiceView[], query: string, projectName: (projectId: string) => string | undefined): ProjectServiceView[] {
  const q = norm(query);
  if (!q) return [];
  const names = (v: ProjectServiceView) => [v.title, v.name, v.app, v.projectId, projectName(v.projectId) ?? ""].map(norm).filter(Boolean);
  const exact = views.filter((v) => names(v).includes(q));
  if (exact.length > 0) return exact;
  return views.filter((v) => names(v).some((n) => n.includes(q) || q.includes(n)));
}

/** 服务入口卡的纯文本降级 */
export const serviceEntryText = (p: ServiceEntryCardPayload): string =>
  p.url ? t("projectServices.entry.url", { project: p.projectName, title: p.title, url: p.url }) : t("projectServices.entry.noWeb", { project: p.projectName, title: p.title });

/** 服务入口卡：出来就是已处理，没有动作 */
export function serviceEntryCardType() {
  return defineCardType({
    type: "service_entry",
    version: 1,
    payload: ServiceEntryCardPayload,
    actions: {},
    toText: serviceEntryText,
    purge: (p) => ({ ...p, title: PURGED_TEXT }),
  });
}

/** 秘书的"给出服务的入口" */
export function openServiceTool(deps: { services: Pick<ProjectServices, "view">; cards: CardService; projectName: (projectId: string) => string | undefined }): HostTool {
  return defineHostTool({
    name: OPEN_SERVICE_TOOL,
    title: t("projectServices.tool.open"),
    description: openServiceText.description,
    parameters: Type.Object({ service: Type.String({ minLength: 1, maxLength: 80, description: openServiceText.param }) }, { additionalProperties: false }),
    // 每调一次多一张卡
    readOnlyOrIdempotent: false,
    run: ({ service }) => {
      const shown = deps.services.view().filter((v) => serviceShown(v) && v.rollout !== "withdrawing");
      const found = findServices(shown, service, deps.projectName).slice(0, MAX_ENTRIES);
      if (found.length === 0) return { text: openServiceText.none(service, shown) };
      const cardIds = found.map(
        (v) =>
          deps.cards.create({
            type: "service_entry",
            status: "handled",
            payload: {
              projectId: v.projectId,
              projectName: deps.projectName(v.projectId) ?? v.projectId,
              key: v.key,
              title: v.title,
              app: v.app,
              ...(v.url === undefined ? {} : { url: v.url }),
            } satisfies ServiceEntryCardPayload,
          }).id,
      );
      return { text: openServiceText.given(found), cardIds };
    },
  });
}

/** 秘书的"启动、关闭项目的服务"（257）：和项目卡片、项目页上的按钮同一个入口，用户说了就是确认 */
export function switchServicesTool(deps: {
  services: Pick<ProjectServices, "view" | "power" | "settled">;
  projectName: (projectId: string) => string | undefined;
  /** 做完最多等多久（测试改短） */
  settleMs?: number;
}): HostTool {
  return defineHostTool({
    name: SWITCH_SERVICES_TOOL,
    title: t("projectServices.tool.switch"),
    description: switchServicesText.description,
    parameters: Type.Object(
      {
        project: Type.String({ minLength: 1, maxLength: 80, description: switchServicesText.projectParam }),
        action: Type.Union([Type.Literal("stop"), Type.Literal("start")], { description: switchServicesText.actionParam }),
      },
      { additionalProperties: false },
    ),
    // 再关一次、再启动一次没有额外效果
    readOnlyOrIdempotent: true,
    run: async ({ project, action }, call) => {
      const shown = deps.services.view().filter((v) => serviceShown(v) && v.rollout !== "withdrawing");
      const projectIds = [...new Set(findServices(shown, project, deps.projectName).map((v) => v.projectId))];
      if (projectIds.length === 0) return { text: switchServicesText.none(project, shown), isError: true };
      const name = (id: string) => deps.projectName(id) ?? id;
      if (projectIds.length > 1) return { text: switchServicesText.ambiguous(project, projectIds.map(name)), isError: true };
      const projectId = projectIds[0]!;
      try {
        deps.services.power(projectId, action, "secretary", `secretary:${call.toolCallId}`);
      } catch (err) {
        if (err instanceof RequestRejected) return { text: switchServicesText.rejected(name(projectId), action, err.message), isError: true };
        throw err;
      }
      const done = await deps.services.settled(projectId, deps.settleMs ?? SWITCH_SERVICES_SETTLE_MS);
      const now = deps.services.view().filter((v) => v.projectId === projectId && serviceShown(v));
      return { text: switchServicesText.result(name(projectId), action, done, now) };
    },
  });
}

/** 秘书查看板时多列的一节"项目的服务"（没有就不列） */
export function serviceBoardSection(services: Pick<ProjectServices, "view">): string | undefined {
  const shown = services.view().filter(serviceShown);
  return shown.length > 0 ? [boardText.title, ...shown.map((v) => `- ${serviceLine(v)}`)].join("\n") : undefined;
}
