// 项目维护者的 check_ops（268 号票）：验收它维护的项目的运营接口清单（档案里的 ops.json），不管这份内容验没验过都重验一遍，
// 结果逐条交回（格式哪里不对、每个操作的测试过没过、回的能念的那句、只读的写没写东西、只提醒的几条）。使用中的项目全过了登记成新的一版
// （版本号加一，秘书马上用新的）；建设中的项目转运营检查清单看的也是这次的结论（转入使用时登记）。改了 ops.json 就用它看过没过。
import { type Project, Type } from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import type { OpsRegistry } from "./registry.ts";
import * as text from "./texts.ts";
import { CHECK_OPS_TOOL } from "./tool-names.ts";

export function checkOpsTool(deps: { registry: OpsRegistry; projects: { list(): Project[] }; scope: { projectId: string; maintainerId: string } }): HostTool {
  const { registry, scope } = deps;
  return defineHostTool({
    name: CHECK_OPS_TOOL,
    title: text.checkToolTitle(),
    description: text.CHECK_OPS_DESCRIPTION,
    parameters: Type.Object({}, { additionalProperties: false }),
    // 会跑测试（带测试标记）、全过了会登记新的一版：不算只读
    readOnlyOrIdempotent: false,
    run: async () => {
      const project = deps.projects.list().find((p) => p.id === scope.projectId);
      if (!project) return { text: `项目 ${scope.projectId} 不在了。`, isError: true }; // @i18n-ignore model
      const state = registry.fileState(project);
      if (state.kind === "missing") return { text: text.checkReport({ project, check: undefined, missing: true, registeredNow: false }), isError: true };
      if (state.kind === "unreadable") return { text: text.checkReport({ project, check: undefined, unreadable: state.problem, registeredNow: false }), isError: true };
      const before = registry.registered(project.id);
      const check = await registry.check(project, { by: "maintainer", force: true });
      const after = registry.registered(project.id);
      const registeredNow = after !== undefined && after.version !== before?.version;
      return {
        text: text.checkReport({ project, check, ...(after ? { registered: after.version } : {}), registeredNow }),
        ...(check?.outcome === "failed" ? { isError: true } : {}),
      };
    },
  });
}
