// agent 的活动状态（规格术语"活动状态"）：agent 此刻在做什么——休眠、干活中、等你、排队（子进程满了，等名额）。
// 和任务状态、项目状态分开。agent 管家报变化，守护进程在活动状态频道上记 activity 事件（12 号票）；
// "等你"和看板、项目列表上的小圆点在 25 号票。
import { type Static, Type } from "typebox";

export const ACTIVITY_STATES = ["sleeping", "working", "waiting_for_user", "queued"] as const;
export type ActivityState = (typeof ACTIVITY_STATES)[number];

export const ACTIVITY_STATE_LABEL: Readonly<Record<ActivityState, string>> = { sleeping: "休眠", working: "干活中", waiting_for_user: "等你", queued: "排队" };

/** `activity` 事件（活动状态频道）：某个 agent 的活动状态变了 */
export const ActivityEventPayload = Type.Object({ agentId: Type.String(), state: Type.Enum(ACTIVITY_STATES), since: Type.String() });
export type ActivityEventPayload = Static<typeof ActivityEventPayload>;
