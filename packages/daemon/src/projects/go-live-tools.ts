// 转入使用的两个代为执行的工具（259 号票；issue 19 第 8 条：转运营不管谁发起都必须用户确认）：
// - 项目维护者的 propose_go_live：建设中、它觉得可以转入使用（转运营）时提，绑定在它维护的项目上；
// - 秘书的 propose_go_live：用户对秘书说"简报站可以上线了""把记账本转运营"时代办，写明哪个项目。
// 268 号票：出卡之前先把运营接口清单重验一遍（prepare），卡上的清单直接是验收的结论。
// 两个都只交给项目模块的 requestGoLive：出一张"转入使用"确认卡（"首版做完了"卡、"转入使用"卡还在等的就用那一张，卡上的检查清单刷新），
// 用户在卡上确认才转——工具本身不改项目状态，秘书、维护者都没有能对卡片做动作的工具，没有绕过的路。工具结果里写检查清单缺什么，
// 维护者能补的先补齐（补完再调一次刷新卡上的清单），秘书照实转告用户。
// @i18n-ignore-file model：工具说明、参数说明、结果给模型看；工具的名字走 t()
import { checklistMissing, type GoLiveChecklistItem, PROJECT_STATE_LABEL, type Project, Type, forModel, t } from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import { RequestRejected } from "../errors.ts";
import type { GoLiveRequested, ProjectService } from "./projects.ts";
import { PROPOSE_GO_LIVE_TOOL } from "./tool-names.ts";

export { PROPOSE_GO_LIVE_TOOL };

/** 检查清单写给模型看：每项一行，✓ / ✗，差什么 */
export function checklistLines(items: readonly GoLiveChecklistItem[]): string {
  const missing = checklistMissing(items);
  return [
    `检查清单（建设中 → 使用中，${items.length} 项，缺 ${missing.length} 项）：`,
    ...items.map((i) => `- ${i.done ? "✓" : "✗"} ${i.label}${i.detail ? `：${i.detail}` : ""}`),
  ].join("\n");
}

/** 出了卡 / 用了还在等的那张：给维护者看的那句 */
function cardSentence(r: GoLiveRequested): string {
  if (r.created) return `已出“转入使用”确认卡（${r.cardId}），放进了用户的待我处理。`;
  return r.cardType === "build_done"
    ? `“首版做完了”卡（${r.cardId}）已经在等用户选了，它的“转入使用”就是这道确认，没有另出卡；卡上的检查清单照现在的刷新了。`
    : `“转入使用”确认卡（${r.cardId}）已经在等用户确认了，没有另出卡；卡上的检查清单照现在的刷新了。`;
}

const MaintainerParams = Type.Object(
  {
    why: Type.String({ minLength: 1, maxLength: 2000, description: "为什么现在能转入使用：做成了什么、怎么用（用户在卡上看得到）" }),
  },
  { additionalProperties: false },
);

/** 转入使用的请求之前要等的（268 号票：运营接口清单重验一遍，卡上直接是结论）；不给就不等 */
export type GoLivePrepare = (projectId: string) => Promise<void>;

/** 项目维护者的"提转入使用"：绑定在它维护的项目上 */
export function maintainerGoLiveTool(projects: Pick<ProjectService, "requestGoLive">, scope: { projectId: string; maintainerId: string }, prepare?: GoLivePrepare): HostTool {
  return defineHostTool({
    name: PROPOSE_GO_LIVE_TOOL,
    title: t("projects.tools.proposeGoLive"),
    description:
      "项目在建设中、你觉得可以转入使用（转运营）了时用，或者用户在会话里说“可以上线了”“转运营吧”时用。运行时出一张“转入使用”确认卡放进用户的待我处理，卡上列出转运营检查清单" +
      "（架构图写清服务和对外接口、ops.json 交了、服务写进运营方案按模板在 LSM 登记、要外网的有带网页的服务开 /apps/<项目编号>-<服务名>/、进展写回）。" +
      "用户在卡上确认才转入使用，你不能自己转，也不要说已经转了；“首版做完了”卡还在等的就用那一张。清单缺的不挡确认（用户可以照样确认，卡上写明缺什么），" +
      "但能补的先补齐：写项目档案、交运营方案，补完再调一次，卡上的清单跟着刷新。告诉用户“卡在这里，点确认就转”。",
    parameters: MaintainerParams,
    readOnlyOrIdempotent: false,
    run: async ({ why }, call) => {
      try {
        await prepare?.(scope.projectId);
        const r = projects.requestGoLive(scope.projectId, { by: "maintainer", why, key: `go-live:${call.toolCallId}` });
        const missing = checklistMissing(r.checklist);
        return {
          text: [
            cardSentence(r),
            "用户在卡上确认才转入使用：你不能自己转，也不要说已经转了。",
            checklistLines(r.checklist),
            missing.length > 0 ? "缺的不挡确认（用户可以照样确认，卡上写明缺什么）；能补的先补齐，补完再调一次刷新卡上的清单。" : "清单都做到了。",
          ].join("\n"),
          ...(r.created ? { cardIds: [r.cardId] } : {}),
        };
      } catch (err) {
        if (err instanceof RequestRejected) return { text: err.message, isError: true };
        throw err;
      }
    },
  });
}

/** 比名字时不看大小写、空白 */
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");

/** 按编号或名字找项目：编号、名字完全对得上的优先，其次是互相包含的 */
export function findProjects(projects: readonly Project[], query: string): Project[] {
  const q = norm(query);
  if (!q) return [];
  const exact = projects.filter((p) => norm(p.id) === q || norm(p.name) === q);
  if (exact.length > 0) return exact;
  return projects.filter((p) => norm(p.name).includes(q) || q.includes(norm(p.name)));
}

const SecretaryParams = Type.Object(
  {
    project: Type.String({ minLength: 1, maxLength: 80, description: "哪个项目：项目编号（p-3）或项目名" }),
    why: Type.String({ minLength: 1, maxLength: 2000, description: "用户怎么说的、为什么要转（用户在卡上看得到）" }),
  },
  { additionalProperties: false },
);

/** 建设中的项目列成一句（找不到时告诉秘书有哪些） */
const buildingList = (projects: readonly Project[]) => {
  const building = projects.filter((p) => p.state === "building");
  return building.length > 0 ? `现在在建设中的项目：${building.map((p) => `${p.id}「${p.name}」`).join("、")}。` : "现在没有在建设中的项目。";
};

/** 秘书的"提转入使用"：照用户说的代办，卡放进聊天和待我处理 */
export function secretaryGoLiveTool(projects: Pick<ProjectService, "requestGoLive" | "list">, prepare?: GoLivePrepare): HostTool {
  return defineHostTool({
    name: PROPOSE_GO_LIVE_TOOL,
    title: t("projects.tools.proposeGoLive"),
    description:
      "用户要把建设中的项目转入使用（转运营）时用（“简报站可以上线了”“把记账本转运营”）：运行时出一张“转入使用”确认卡放进聊天和待我处理（“首版做完了”卡还在等的就用那一张），" +
      "卡上列着转运营检查清单。用户在卡上确认才转——这一件用户说了也不算确认，你不能替他确认，也不要说已经转了。清单缺的照实告诉用户（他可以照样确认，或者先让项目的维护者补齐）。" +
      "说不清是哪个项目时先问用户。",
    parameters: SecretaryParams,
    readOnlyOrIdempotent: false,
    run: async ({ project, why }, call) => {
      const all = projects.list();
      const found = findProjects(all, project);
      if (found.length === 0) return { text: `没有叫“${project}”的项目。${buildingList(all)}`, isError: true };
      if (found.length > 1) return { text: `“${project}”对得上好几个项目：${found.map((p) => `${p.id}「${p.name}」`).join("、")}。先问用户是哪一个。`, isError: true };
      const target = found[0]!;
      if (target.state !== "building") {
        return { text: `项目 ${target.id}「${target.name}」现在是${forModel(() => PROJECT_STATE_LABEL[target.state])}，只有建设中的项目能转入使用。${buildingList(all)}`, isError: true };
      }
      try {
        await prepare?.(target.id);
        const r = projects.requestGoLive(target.id, { by: "secretary", why, key: `go-live:${call.toolCallId}` });
        return {
          text: [
            r.created
              ? `已把项目 ${target.id}「${target.name}」的“转入使用”确认卡放进聊天和待我处理。`
              : `项目 ${target.id}「${target.name}」已经有一张转入使用的确认卡在等用户（${r.cardType === "build_done" ? "“首版做完了”卡" : "“转入使用”卡"}），放进了聊天；卡上的检查清单照现在的刷新了。`,
            "用户在卡上点确认才转入使用：这一件用户说了也不算确认，你不能替他确认，也不要说已经转了。",
            checklistLines(r.checklist),
            checklistMissing(r.checklist).length > 0 ? "缺的照实告诉用户：他可以照样确认，或者先让项目的维护者补齐。" : "",
          ]
            .filter(Boolean)
            .join("\n"),
          cardIds: [r.cardId],
        };
      } catch (err) {
        if (err instanceof RequestRejected) return { text: err.message, isError: true };
        throw err;
      }
    },
  });
}
