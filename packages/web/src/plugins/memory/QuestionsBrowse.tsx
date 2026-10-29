// 记忆 · 问题箱（233 号票，#/more/memory/questions）：整理时还拿不准的地方变成的问题。
// 一条写清楚：问什么、为什么问、能区分哪几条（带它们现在的状态）、哪种问题、优先级、现在什么状态、问过几次。
// 264 号票起秘书在对话里顺口问（设置 · 记忆里能关）：另写跳过几次、你的回答（原话和读成什么）、判的结果、经过（几点放进来、
// 几点顺口问了、跳过、你答了……）。
// 空的时候、推理库读不到的时候各写一句。说法和推导都在状态层（state/memory-graph.ts），这里只管画。
import { useEffect, useState } from "react";
import { useStore } from "../../app/store.tsx";
import { retryLoad } from "../../app/retry-load.ts";
import { type MemoryQuestionsView, memoryQuestionRow, memoryQuestionsLine, t } from "../../state/index.ts";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 记忆 · 问题箱 */
export function QuestionsBrowse() {
  const { http } = useStore();
  const [view, setView] = useState<MemoryQuestionsView>();
  const [failed, setFailed] = useState<string>();

  useEffect(() => {
    let live = true;
    retryLoad(() => http.memoryQuestions())
      .then((next) => {
        if (!live) return;
        setView(next);
        setFailed(undefined);
      })
      .catch((err: unknown) => live && setFailed(errorText(err)));
    return () => {
      live = false;
    };
  }, [http]);

  return (
    <div className="mem-page">
      {view !== undefined && view.ready && <div className="mem-note mem-head">{memoryQuestionsLine({ ready: view.ready, open: view.open, total: view.total })}</div>}
      {failed !== undefined && <div className="hint">{t("pages.memoryGraph.loadFailed", { reason: failed })}</div>}
      {view !== undefined && !view.ready && <div className="hint">{view.reason ?? t("pages.memoryGraph.notReady")}</div>}
      {view !== undefined &&
        view.ready &&
        view.items.map((item) => {
          const row = memoryQuestionRow(item);
          return (
            <article key={row.id} className="mem-question" aria-label={row.text}>
              <div className="mem-row-text">{row.text}</div>
              <div className="mem-note">{t("pages.memoryGraph.why", { why: row.why })}</div>
              <div className="mem-note">{t("pages.memoryGraph.discriminates", { targets: row.targets.join(t("state.memoryGraph.listSep")) })}</div>
              <div className="mem-note">{row.meta}</div>
              {row.answer !== undefined && <div className="mem-note">{row.answer}</div>}
              {row.outcome !== undefined && <div className="mem-note">{row.outcome}</div>}
              {row.history.length > 0 && <div className="mem-note">{row.history.join(t("state.memoryGraph.historySep"))}</div>}
            </article>
          );
        })}
    </div>
  );
}
