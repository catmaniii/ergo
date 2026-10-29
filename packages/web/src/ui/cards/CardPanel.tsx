// 按卡片类型选组件。卡片状态只有一份（前端状态层里），聊天、待办、任务详情里显示的是同一张。
// 不认识的类型、或者负载版本比这个页面新的卡（state/cards.ts 的 cardDisplay 判断），显示服务端给的纯文本降级版本，
// 加上"去 Web 处理"的链接：刷新成最新的 Web 页面，在单独显示这张卡的页面里处理。
// 193 号票：网页插件的卡片（提醒卡、记忆删除卡）由插件登记画法（网页插件的卡片插槽）；插件停用时显示一行
// "（X插件没启用，这条内容暂时看不到）"，不降级成纯文本。
import type { ComponentType } from "react";
import { useStore } from "../../app/store.tsx";
import { type CardDisplay, cardDisplay, type CardState, type CardType, cardWebPath, t } from "../../state/index.ts";
import { usePlugins } from "../../plugins/api.ts";
import { NamedText } from "../assistant-name.tsx";
import { type CardProps, useCardActions } from "./CardShell.tsx";
import {
  ApprovalCard,
  BuildDoneCard,
  CharterCard,
  GoLiveCard,
  McpChangeCard,
  PairingCard,
  ParallelCard,
  ProgressCard,
  QuestionsCard,
  QuickActionCard,
  SuggestProjectCard,
  SuggestTaskCard,
  ToolkitChangeCard,
  WorkOrderCard,
} from "./cards.tsx";
import { ArchiveListCard } from "./ArchiveListCard.tsx";
import { CharterChangeCard } from "./CharterChangeCard.tsx";
import { StandardBackfillCard } from "./StandardBackfillCard.tsx";
import { StandardChangeCard } from "./StandardChangeCard.tsx";
import { OperationsChangeCard, ServiceEntryCard } from "./OperationsCards.tsx";
import { PersonalFileCard } from "./PersonalFileCard.tsx";
import { PersonalFileSuggestCard } from "./PersonalFileSuggestCard.tsx";
import { PlanCard } from "./PlanCard.tsx";
import { PlanChangeCard } from "./PlanChangeCard.tsx";
import { RuntimeQuestionCard } from "./RuntimeQuestionCard.tsx";
import { WorkflowPlanCard } from "./WorkflowPlanCard.tsx";

// 每种卡片的负载形状不同；CardProps<never> 能接住任何一种负载的组件。网页插件拥有的几种（reminder、memory_delete）不在这里，见上
const BY_TYPE: Partial<Record<CardType, ComponentType<CardProps<never>>>> = {
  plan: PlanCard,
  approval: ApprovalCard,
  questions: QuestionsCard,
  progress: ProgressCard,
  quick_action: QuickActionCard,
  suggest_task: SuggestTaskCard,
  suggest_project: SuggestProjectCard,
  charter: CharterCard,
  work_order: WorkOrderCard,
  plan_change: PlanChangeCard,
  parallel: ParallelCard,
  pairing: PairingCard,
  toolkit_change: ToolkitChangeCard,
  // MCP 登记变更（239 号票）：维护者提的加、改、删一条 MCP 登记
  mcp_change: McpChangeCard,
  archive_list: ArchiveListCard,
  workflow_plan: WorkflowPlanCard,
  build_done: BuildDoneCard,
  // "转入使用"确认卡（259 号票）：转运营不管谁发起都在这里确认
  go_live: GoLiveCard,
  charter_change: CharterChangeCard,
  // 规范改写（261 号票）：本项目的规范改写、跟新版规范
  standard_change: StandardChangeCard,
  // 补齐规范文档（262 号票）：规范上线之前建的项目缺哪几份，你选补齐才建任务
  standard_backfill: StandardBackfillCard,
  operations_change: OperationsChangeCard,
  service_entry: ServiceEntryCard,
  // 个人档案的核对卡（281 号票）：号码一位一位列出，确认了才写进档案
  personal_file: PersonalFileCard,
  // 候选核对卡（283 号票）：每晚整理攒的人物信息、直接写进档案的生日问一句每年提醒，逐条勾
  personal_file_suggest: PersonalFileSuggestCard,
  // 运行时的提问卡（288 号票）：Claude Code 自己要问你的选择题、退出计划模式的批准
  runtime_question: RuntimeQuestionCard,
  // 网页候选卡（browse_pick，147 号票）212 号票起是浏览插件登记的
};

/** 一张卡片：按 id 从前端状态层取，按类型选组件；不认识的显示纯文本降级版本 */
export function CardPanel({ cardId }: { cardId: string }) {
  const display = cardDisplay(useStore().ui, cardId);
  const plugins = usePlugins();
  if (!display) return <div className="card muted">{t("ui.cardPanel.notYet", { id: cardId })}</div>;
  // 停用的网页插件拥有的卡（193 号票）：占位
  const off = plugins.unavailable("cards", display.kind === "fallback" ? display.state.card.type : display.type);
  if (off !== undefined) return <div className="card muted card-unavailable">{t("ui.plugins.unavailable", { plugin: off })}</div>;
  if (display.kind === "fallback") return <FallbackCard display={display} />;
  const Comp = BY_TYPE[display.type] ?? plugins.get("cards", display.type)?.Card;
  if (!Comp) return <FallbackCard display={{ kind: "fallback", state: display.state, reason: "unknown_type", text: display.state.card.text, webPath: cardWebPath(cardId) }} />;
  return <TypedCard state={display.state} Comp={Comp} />;
}

function TypedCard({ state, Comp }: { state: CardState; Comp: ComponentType<CardProps<never>> }) {
  const { done, act } = useCardActions(state);
  // 负载由守护进程按卡片类型注册表里的 schema 校验过
  return <Comp state={state} payload={state.card.payload as never} done={done} act={act} />;
}

function FallbackCard({ display }: { display: Extract<CardDisplay, { kind: "fallback" }> }) {
  return (
    <div className="card xcard card-fallback">
      <div className="xcard-head">
        <span className="xcard-tag">{t("ui.cardPanel.tag")}</span>
        <span className="xcard-title">{display.reason === "unknown_type" ? t("ui.cardPanel.unknownType") : t("ui.cardPanel.newer")}</span>
      </div>
      <div className="xcard-body">
        {/* 守护进程写的纯文本：名字占位（和 43 号票之前的旧说法）按现在的名字显示 */}
        <div className="fallback-text">
          <NamedText text={display.text} />
        </div>
        <a
          className="link"
          href={display.webPath}
          onClick={(e) => {
            // 这个页面处理不了：换到这张卡的页面，并刷新成守护进程上最新的 Web
            e.preventDefault();
            window.location.hash = display.webPath;
            window.location.reload();
          }}
        >
          {t("ui.cardPanel.openInWeb")}
        </a>
      </div>
    </div>
  );
}
