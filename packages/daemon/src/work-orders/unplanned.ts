// 计划外工单的处置（规格第 9 节"计划外工单"、第 12 节，17 号票）：涉及多个项目的任务的维护者执行中派出计划里没有的工单
// （这个阶段没有这个项目的一行）时，这次派单作为一个伪工具调用交给守卫的判定函数，不另写一套类别规则（和快速动作同一种做法，
// quick-actions/judge.ts）：
// - 伪工具 work_order:unplanned 登记在"计划外工单"类别里（任务里默认先问我），参数 project 是收件项目的名字；
//   用户只能往严里调（全局设置、本任务的计划），用户的自定义类别按工具名也能匹配它；
// - 先问我（及更严的交给我做）：工单"待你确认"，待我处理出现工单卡，用户确认后才派出（不是审批卡：工单卡就是这次的确认）；
//   永不、硬拒绝：不派，原因交回维护者。"先问我"的类别列进授权项也照样问，所以计划里的授权项放不开它。
// - 101 号票：对话审批关着（配置 guard.conversationApprovals 默认 off）时任务的 agent 超出授权先不管——"先问我"按直接做，
//   计划外的工单直接派出（时间线上照常记一笔，回给维护者的话里写明）；用户往严里调成交给我做、永不的照旧。
import {
  type ConversationApprovals,
  type Disposition,
  type GuardAgent,
  type GuardPlaces,
  type GuardTask,
  judgementExecutes,
  judgeToolCall,
  type ToolDescriptor,
  type WatchCategorySettings,
} from "../guard/index.ts";
import { categoryTitle } from "../guard-runtime/describe.ts";

/** 伪工具的登记：形状同工具注册表（自定义类别的 match.tools 写它的名字） */
export const UNPLANNED_WORK_ORDER_TOOL: ToolDescriptor = {
  name: "work_order:unplanned",
  title: "派计划外的工单",
  source: "host",
  categories: ["unplanned_work_order"],
  args: { project: { kind: "other", description: "收件项目" } },
  readOnlyOrIdempotent: false,
};

export interface UnplannedJudgeInput {
  /** 派单的任务维护者（守卫眼里的样子） */
  agent: GuardAgent;
  places: GuardPlaces;
  /** 任务（计划、当前阶段换成工单所属的阶段） */
  task: GuardTask;
  /** 现取的全局关注类别设置 */
  settings: WatchCategorySettings;
  /** 收件项目的名字 */
  project: string;
  now: number;
  /** 对话审批的开关（配置 guard.conversationApprovals）：off 时超出授权先不管，计划外的工单直接派出（101 号票）；不给按 on */
  conversationApprovals?: ConversationApprovals;
}

export type UnplannedJudgement =
  /** 不派：永不或硬拒绝，原因给维护者 */
  | { refused: string }
  /** 要用户确认（处置是先问我或更严的交给我做），命中的类别（显示用的名字） */
  | { refused?: undefined; direct?: undefined; disposition: Disposition; categories: string[] }
  /** 对话审批关着，任务的 agent 超出授权先不管（101 号票）：直接派出，命中的类别照常标出 */
  | { refused?: undefined; direct: true; categories: string[] };

export function judgeUnplannedWorkOrder(input: UnplannedJudgeInput): UnplannedJudgement {
  const descriptor = UNPLANNED_WORK_ORDER_TOOL;
  const agent: GuardAgent = { ...input.agent, toolkit: { ...input.agent.toolkit, tools: [descriptor.name] } };
  const judgement = judgeToolCall({
    call: { toolName: descriptor.name, args: { project: input.project } },
    agent,
    places: input.places,
    task: input.task,
    effectLog: [],
    settings: input.settings,
    facts: {},
    tools: { [descriptor.name]: descriptor },
    now: input.now,
    ...(input.conversationApprovals === undefined ? {} : { conversationApprovals: input.conversationApprovals }),
  });
  if (judgement.hardRefusal !== null || judgement.disposition === "never") return { refused: judgement.explanation };
  const categories = judgement.categories.map((id) => categoryTitle(id, [input.settings]));
  if (judgementExecutes(judgement)) return { direct: true, categories };
  // 计划外的工单总要用户确认：先问我以下的不会出现（内置类别只能往严里调），万一出现也按先问我
  const disposition = judgement.disposition === "hand_over" ? "hand_over" : "ask_first";
  return { disposition, categories };
}
