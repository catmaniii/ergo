// 运行时的提问卡（288 号票，卡片类型 runtime_question）：维护者的运行时自己要问你的——
// - Claude Code 的 AskUserQuestion：一到四道选择题，每题一个小标签、两到四个带说明的选项（有的可以多选），都不合适就自己写；
//   "提交回答"每题都答了才能点（同协议包的 runtimeAnswerProblem），"不答"就告诉它你没答；
// - 退出计划模式：它做好的计划等你批准——"批准"接着干，"打回"让它接着想（附一句怎么改）。
// 答了的卡显示你选了什么、写了什么；这一轮结束了还没答的卡作废（卡上写着这一轮已经结束）。
import { useState } from "react";
import type { RuntimeQuestionPayload } from "../../model/cards.ts";
import { type RuntimeChoiceAnswer, type RuntimeChoiceQuestion, runtimeAnswerProblem, t } from "../../state/index.ts";
import { AutoGrowText } from "../auto-grow-text.tsx";
import { type CardProps, CardShell } from "./CardShell.tsx";
import { Btn } from "./cards.tsx";

export function RuntimeQuestionCard(props: CardProps<RuntimeQuestionPayload>) {
  return props.payload.question.kind === "plan" ? <PlanApproval {...props} /> : <Choices {...props} />;
}

/** 卡头：谁在问（子代理问的另写一句） */
function who(p: RuntimeQuestionPayload): string {
  return p.subAgent ? t("ui.cards.runtimeQuestion.subAgent", { runtime: p.runtimeTitle }) : p.runtimeTitle;
}

function Choices({ state, payload: p, done, act }: CardProps<RuntimeQuestionPayload>) {
  const questions = p.question.kind === "choices" ? p.question.questions : [];
  const [answers, setAnswers] = useState<RuntimeChoiceAnswer[]>(() => questions.map((q) => ({ question: q.question, selected: [] })));
  const given = p.reply?.kind === "choices" ? p.reply.answers : undefined;
  const shown = done ? (given ?? []) : answers;
  const ready = runtimeAnswerProblem(questions, answers) === undefined;
  const update = (index: number, next: RuntimeChoiceAnswer) => setAnswers(answers.map((a, i) => (i === index ? next : a)));
  return (
    <CardShell
      state={state}
      title={t("ui.cards.runtimeQuestion.choicesTitle", { who: who(p), count: questions.length })}
      actions={
        <>
          <Btn onClick={() => act("dismiss")}>{t("ui.cards.runtimeQuestion.decline")}</Btn>
          <Btn kind="primary" disabled={!ready} onClick={() => act("answer", undefined, { answers: answers.map((a) => ({ question: a.question, selected: a.selected, ...(a.other?.trim() ? { other: a.other.trim() } : {}) })) })}>
            {t("ui.cards.runtimeQuestion.submit")}
          </Btn>
        </>
      }
    >
      <div className="muted">{p.source}</div>
      {questions.map((q, qi) => (
        <ChoiceQuestion key={q.question} q={q} n={qi + 1} answer={shown[qi]} done={done} onChange={(next) => update(qi, next)} />
      ))}
      {done && p.reply?.kind === "declined" && <div className="muted">{t("ui.cards.runtimeQuestion.declined")}</div>}
    </CardShell>
  );
}

function ChoiceQuestion({ q, n, answer, done, onChange }: { q: RuntimeChoiceQuestion; n: number; answer: RuntimeChoiceAnswer | undefined; done: boolean; onChange(next: RuntimeChoiceAnswer): void }) {
  const selected = answer?.selected ?? [];
  const other = answer?.other ?? "";
  const pick = (label: string) => {
    if (q.multiSelect) onChange({ question: q.question, selected: selected.includes(label) ? selected.filter((l) => l !== label) : [...selected, label], other });
    // 单选：选了现成的就不再用自己写的
    else onChange({ question: q.question, selected: selected.includes(label) ? [] : [label] });
  };
  const preview = q.options.find((o) => selected.includes(o.label) && o.preview)?.preview;
  return (
    <fieldset className="qa rq" disabled={done}>
      <legend>
        {q.header && <span className="chip rq-header">{q.header}</span>}
        {n}. {q.question}
      </legend>
      {q.multiSelect && <div className="muted rq-hint">{t("ui.cards.runtimeQuestion.multiSelect")}</div>}
      <div className="rq-opts" role={q.multiSelect ? "group" : "radiogroup"} aria-label={q.question}>
        {q.options.map((o) => {
          const on = selected.includes(o.label);
          return (
            <button key={o.label} type="button" className={`rq-opt${on ? " on" : ""}${q.multiSelect ? " multi" : ""}`} role={q.multiSelect ? "checkbox" : "radio"} aria-checked={on} onClick={() => pick(o.label)}>
              <span className="rq-mark" aria-hidden="true" />
              <span className="rq-text">
                <span className="rq-label">{o.label}</span>
                {o.description && <span className="rq-desc">{o.description}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {preview && <pre className="rq-preview">{preview}</pre>}
      {done ? (
        other && <div className="muted">{t("ui.cards.runtimeQuestion.yourAnswer", { answer: other })}</div>
      ) : (
        <AutoGrowText
          className="input"
          value={other}
          onChange={(text) => onChange({ question: q.question, selected: q.multiSelect || text.trim() === "" ? selected : [], other: text })}
          placeholder={t("ui.cards.runtimeQuestion.otherPlaceholder")}
          aria-label={t("ui.cards.runtimeQuestion.otherLabel", { n })}
        />
      )}
    </fieldset>
  );
}

function PlanApproval({ state, payload: p, done, act }: CardProps<RuntimeQuestionPayload>) {
  const [note, setNote] = useState("");
  const said = note.trim() ? note.trim() : undefined;
  const plan = p.question.kind === "plan" ? p.question.plan : "";
  return (
    <CardShell
      state={state}
      title={t("ui.cards.runtimeQuestion.planTitle", { who: who(p) })}
      actions={
        <>
          <Btn onClick={() => act("reject", said)}>{t("ui.cards.runtimeQuestion.reject")}</Btn>
          <Btn kind="primary" onClick={() => act("approve", said)}>
            {t("ui.cards.runtimeQuestion.approve")}
          </Btn>
        </>
      }
    >
      <div className="muted">{p.source}</div>
      {plan ? <div className="rq-plan">{plan}</div> : <div className="muted">{t("ui.cards.runtimeQuestion.noPlanText")}</div>}
      {!done && (
        <AutoGrowText className="input" value={note} onChange={setNote} placeholder={t("ui.cards.runtimeQuestion.notePlaceholder")} aria-label={t("ui.cards.runtimeQuestion.noteLabel")} />
      )}
    </CardShell>
  );
}
