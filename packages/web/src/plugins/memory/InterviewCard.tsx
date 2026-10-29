// 约访卡（284 号票，卡片类型 interview，记忆插件登记的画法）：记忆管理员每周在待办里约一次了解你访谈（五个主题都聊过以后每月一次
// "最近有什么变化"），不卡事。三个按钮：
// - 开始：开一次访谈（守护进程同一事务里记开始、往管理员的会话里放开场的系统消息），顺手跳到记忆管理员的整页对话，管理员在那里问第一个问题；
// - 下次再说：这张卡算处理了，下周照常约；
// - 不想做了：以后不再约（设置 · 记忆里的"约访"跟着关，能重新打开）。
// 开始了的卡上留一个"去和记忆管理员聊"，点了回到那页接着聊。记忆插件停用时这张卡显示占位（守护进程那边的动作回"记忆插件没启用"）。
import { useRoute } from "../../app/route.ts";
import { INTERVIEW_TOPIC_LABEL, type InterviewCardPayload, t, tTable } from "../../state/index.ts";
import { Btn } from "../../ui/cards/cards.tsx";
import { type CardProps, CardShell } from "../../ui/cards/CardShell.tsx";
import { MEMORY_PAGE } from "./route.ts";

/** 点过以后卡上写的结局 */
const RESULT_LABEL: Readonly<Record<NonNullable<InterviewCardPayload["result"]>, string>> = tTable({
  started: "ui.cards.interview.started",
  later: "ui.cards.interview.later",
  declined: "ui.cards.interview.declined",
});

export function InterviewCard({ state, payload: p, act }: CardProps<InterviewCardPayload>) {
  const [, navigate] = useRoute();
  const toCurator = () => navigate({ tab: "more", page: MEMORY_PAGE, item: "curator" });
  const title = p.kind === "monthly" ? t("ui.cards.interview.monthlyTitle") : t("ui.cards.interview.weeklyTitle", { topic: INTERVIEW_TOPIC_LABEL[p.topic] });
  return (
    <CardShell
      state={state}
      title={title}
      doneLabel={p.result === undefined ? undefined : RESULT_LABEL[p.result]}
      doneActions={
        p.result === "started" ? (
          <Btn kind="primary" onClick={toCurator}>
            {t("ui.cards.interview.go")}
          </Btn>
        ) : undefined
      }
      actions={
        <>
          <Btn onClick={() => act("decline")}>{t("ui.cards.interview.decline")}</Btn>
          <Btn onClick={() => act("later")}>{t("ui.cards.interview.laterButton")}</Btn>
          <Btn
            kind="primary"
            onClick={() => {
              act("start");
              toCurator();
            }}
          >
            {t("ui.cards.interview.start")}
          </Btn>
        </>
      }
    >
      <div>{t("ui.cards.interview.body")}</div>
      <div className="muted">{t("ui.cards.interview.hint")}</div>
    </CardShell>
  );
}
