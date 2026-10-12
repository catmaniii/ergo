// 工具包（ADR-0003，规格第 3、11、20、21 节，27 号票）的名字和纯函数，守护进程和 Web 共用，不引用 TypeBox：
// - 工具包有五样：skill 名单、MCP 名单、bash 开关、联网开关、给秘书发消息开关（102 号票，形状同计划的 PlanToolkit / projects.ts 的
//   ToolkitShape；给秘书发消息默认开着，不写是开，关掉了写 false：canTellSecretary、tellSecretaryField）；
// - 改动的说法（toolkitChangeText）：加上哪些、去掉哪些，卡片、时间线、交给维护者的"工具包已变更"都用它；
// - 哪些改动要用户批准（toolkitExpansions）：开 bash、加 MCP、开联网、打开给秘书发消息（102 号票评审后定：用户关掉的
//   维护者不能自己打开）。skill 只是说明书，不增加权限，维护者自己增减；减少能力随时可以；
// - MCP 工具在会话里的名字（mcpToolName）：mcp__<登记的 MCP 名>__<工具名>。
import { ASSISTANT_NAME_MARK } from "./assistant-name.ts";
import type { ToolkitShape } from "./projects.ts";

/** 一样能力：skill、MCP（带名字），bash、联网、给秘书发消息（开关） */
export type ToolkitCapability = { kind: "skill"; name: string } | { kind: "mcp"; name: string } | { kind: "bash" } | { kind: "network" } | { kind: "tell_secretary" };

/**
 * 给秘书发消息这一样的说法（工具包设置里那个开关的名字也是它）：写名字占位（43 号票），界面上显示用户起的名字，
 * 交给 agent 的话里守护进程换成"秘书"
 */
export const TELL_SECRETARY_CAPABILITY = `给${ASSISTANT_NAME_MARK}发消息`;

/** 工具包里给秘书发消息开着没有（102 号票）：不写是开着（默认开，之前存下的工具包都没有这一项） */
export function canTellSecretary(t: { readonly tellSecretary?: boolean | undefined }): boolean {
  return t.tellSecretary !== false;
}

/** 给秘书发消息这一项在工具包里的写法：开着不写（和之前存下的一样），关着写 false */
export function tellSecretaryField(on: boolean): { tellSecretary?: false } {
  return on ? {} : { tellSecretary: false };
}

/** 一样能力的说法："skill notes-style"、"MCP exif"、"bash"、"联网"、"给秘书发消息" */
export function capabilityText(c: ToolkitCapability): string {
  switch (c.kind) {
    case "skill":
      return `skill ${c.name}`;
    case "mcp":
      return `MCP ${c.name}`;
    case "bash":
      return "bash";
    case "network":
      return "联网";
    case "tell_secretary":
      return TELL_SECRETARY_CAPABILITY;
  }
}

/** after 比 before 多出来的能力（打开的开关、多出的 skill 和 MCP） */
export function toolkitAdded(before: ToolkitShape, after: ToolkitShape): ToolkitCapability[] {
  return [
    ...after.skills.filter((s) => !before.skills.includes(s)).map((name): ToolkitCapability => ({ kind: "skill", name })),
    ...after.mcp.filter((m) => !before.mcp.includes(m)).map((name): ToolkitCapability => ({ kind: "mcp", name })),
    ...(after.bash && !before.bash ? [{ kind: "bash" } as const] : []),
    ...(after.network && !before.network ? [{ kind: "network" } as const] : []),
    ...(canTellSecretary(after) && !canTellSecretary(before) ? [{ kind: "tell_secretary" } as const] : []),
  ];
}

/** after 比 before 少了的能力 */
export function toolkitRemoved(before: ToolkitShape, after: ToolkitShape): ToolkitCapability[] {
  return toolkitAdded(after, before);
}

/**
 * 要用户批准的那几样：开 bash、加 MCP、开联网、打开给秘书发消息（102 号票评审后定：和 bash、联网一样是能力开关，
 * 用户关掉的维护者不能自己打开，要走计划变更等用户确认）。skill 不算：只是说明书，不增加权限
 */
export function toolkitExpansions(before: ToolkitShape, after: ToolkitShape): ToolkitCapability[] {
  return toolkitAdded(before, after).filter((c) => c.kind !== "skill");
}

/**
 * 工具包写成一句话："bash 开、联网关；skill：无；MCP：demo-exif"（计划卡、计划变更卡、工具包变更卡、交给维护者的话共用）。
 * 给秘书发消息默认开着，只在关掉时写一句（"bash 开、联网关、给秘书发消息关；…"）
 */
export function toolkitText(t: ToolkitShape): string {
  const letters = canTellSecretary(t) ? "" : `、${TELL_SECRETARY_CAPABILITY}关`;
  return `bash ${t.bash ? "开" : "关"}、联网${t.network ? "开" : "关"}${letters}；skill：${t.skills.join("、") || "无"}；MCP：${t.mcp.join("、") || "无"}`;
}

/** 改动写成一句话："加上 skill notes-style、联网；去掉 MCP exif"；没有改动是"没有改动" */
export function toolkitChangeText(before: ToolkitShape, after: ToolkitShape): string {
  const added = toolkitAdded(before, after).map(capabilityText);
  const removed = toolkitRemoved(before, after).map(capabilityText);
  const parts = [...(added.length > 0 ? [`加上 ${added.join("、")}`] : []), ...(removed.length > 0 ? [`去掉 ${removed.join("、")}`] : [])];
  return parts.length > 0 ? parts.join("；") : "没有改动";
}

/** 往工具包里加上这些能力（已有的不重复） */
export function withCapabilities(t: ToolkitShape, add: readonly ToolkitCapability[]): ToolkitShape {
  const names = (kind: "skill" | "mcp") => add.flatMap((c) => (c.kind === kind ? [c.name] : []));
  return {
    skills: [...t.skills, ...names("skill").filter((s) => !t.skills.includes(s))],
    mcp: [...t.mcp, ...names("mcp").filter((m) => !t.mcp.includes(m))],
    bash: t.bash || add.some((c) => c.kind === "bash"),
    network: t.network || add.some((c) => c.kind === "network"),
    ...tellSecretaryField(canTellSecretary(t) || add.some((c) => c.kind === "tell_secretary")),
  };
}

/** 从工具包里去掉这些能力 */
export function withoutCapabilities(t: ToolkitShape, remove: readonly ToolkitCapability[]): ToolkitShape {
  const names = (kind: "skill" | "mcp") => remove.flatMap((c) => (c.kind === kind ? [c.name] : []));
  return {
    skills: t.skills.filter((s) => !names("skill").includes(s)),
    mcp: t.mcp.filter((m) => !names("mcp").includes(m)),
    bash: t.bash && !remove.some((c) => c.kind === "bash"),
    network: t.network && !remove.some((c) => c.kind === "network"),
    ...tellSecretaryField(canTellSecretary(t) && !remove.some((c) => c.kind === "tell_secretary")),
  };
}

/** 交给维护者的"工具包已变更"（重新装配之后接着干的那一句；固定上下文里的工具包说明随之更新） */
export function toolkitChangedNotice(before: ToolkitShape, after: ToolkitShape, why: string): string {
  return `工具包已变更（${why}）：${toolkitChangeText(before, after)}。现在的工具包：${toolkitText(after)}。按新的工具包接着干。`;
}

/** MCP 名、MCP 工具名的写法：字母、数字、短横线和下划线，不能有连着的两个下划线（会话里的工具名用它们分隔） */
export const MCP_NAME_PATTERN = "^[A-Za-z0-9](?:[A-Za-z0-9-]|_(?!_))*$";

const MCP_TOOL_PREFIX = "mcp__";

/** MCP 工具在会话里的名字：mcp__<登记的 MCP 名>__<工具名> */
export function mcpToolName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${server}__${tool}`;
}

/** 会话里的这个工具是不是这几个 MCP 之外的 MCP 工具（MCP 名里没有连着的两个下划线，按前缀认不会认错） */
export function isMcpToolOutside(name: string, servers: readonly string[]): boolean {
  return name.startsWith(MCP_TOOL_PREFIX) && !servers.some((server) => name.startsWith(mcpToolName(server, "")));
}

