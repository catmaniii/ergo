// 秘书的工具里项目系统给的那几样（入口 api.ts 的 SecretaryProjects）：建议立项、查看板时"项目的服务"那一节、
// 读项目档案、给出服务入口、启停项目的服务、调使用中的项目的操作、提转入使用。
// 秘书的工具清单（secretary/tool-list.ts）只经这个小接口拿，不再自己认项目服务、项目的服务、project_ops 和这几个工具的造法。
// 给出服务入口、启停项目的服务、project_ops 和查看板时那一节是运营层的，经运营层的入口（project-ops/api.ts 的 OpsSecretary）拿。
// 先后是秘书看到的工具顺序（测试比对它），别随手调。
import type { CardService } from "../cards/cards.ts";
import type { UserWordsDeps } from "../conversation/user-words.ts";
import type { OpsGoLive, OpsSecretary } from "../project-ops/api.ts";
import type { SecretaryProjects } from "./api.ts";
import { secretaryGoLiveTool } from "./go-live-tools.ts";
import type { ProjectService, ProjectWorkFolder } from "./projects.ts";
import { readProjectRecordsTool } from "./records-tool.ts";
import { suggestProjectTool } from "./tools.ts";

export interface SecretaryProjectsDeps {
  cards: CardService;
  projects: ProjectService;
  /** 运营层给秘书的：给出服务入口、启停项目的服务、调使用中的项目的操作，查看板时"项目的服务"那一节 */
  ops: OpsSecretary;
  /** 转入使用之前先把运营接口清单验一遍（prepareGoLive） */
  goLive: Pick<OpsGoLive, "prepareGoLive">;
  /** 建议立项卡上写的运行时现在能不能用：不能用的原因；不给就不查 */
  runtimeRefusal?: (runtime: string) => string | undefined;
  /** 建议立项卡上写的文件夹：已有的核对路径；不给就不查 */
  workFolder?: Pick<ProjectWorkFolder, "precheck">;
  /** 核实用户这句话：建议立项卡上原样带上；不给就只有秘书抄的 */
  userWords?: UserWordsDeps;
}

export function createSecretaryProjects(deps: SecretaryProjectsDeps): SecretaryProjects {
  const { cards, projects, ops, goLive } = deps;
  return {
    suggestTool: () => suggestProjectTool(cards, deps.runtimeRefusal, deps.workFolder, deps.userWords),
    boardSection: () => ops.boardSection(),
    tools: () => [
      readProjectRecordsTool(projects),
      // 给出服务入口、启停项目的服务、调使用中的项目的操作：运营层给的，按这个先后
      ...ops.tools(),
      // 建设中的项目转入使用——只出确认卡，用户说了也不算确认
      secretaryGoLiveTool(projects, (projectId) => goLive.prepareGoLive(projectId)),
    ],
  };
}
