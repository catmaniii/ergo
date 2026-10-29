// 项目页上的"规范"一块（258 号票）：项目用的哪一版规范（规范上线之前建的写明没有版本），必须有的几份文档写了、只有模板还是缺
// （开发类四份：规格、架构图、进展、决策记录；其他类三份）。数据是只读接口 GET /api/projects/<id>/standard，每次打开项目页现取、
// 项目有变化（状态、类型、规范改写）时再取一次；纯函数在 state/project-standard.ts。检查清单和更细的界面留给 issue 21。
// 261 号票：本项目的规范改写——不要的那份标"本项目不要"、换写法的标"（改写）"、多出来的接在后面；下面列和默认规范哪里不同；
// 模板出了新版提示"有新版"（不自动跟）；这个项目的"规范改写"卡列在最下面（等你确认的、处理过的）。
// 262 号票：规范上线之前建的项目，"补齐规范文档"卡也列在最下面（等你选的、选过的），和规范改写卡按出来的先后。
import { useEffect, useState } from "react";
import { useStore } from "../app/store.tsx";
import { type Project, type ProjectStandardView, projectStandardBlock, projectStandardCards, type StandardDocState, t } from "../state/index.ts";
import { CardPanel } from "../ui/cards/CardPanel.tsx";
import { Section } from "../ui/common.tsx";

/** 写了是绿的，只有模板是淡的，缺是红的，本项目不要的也是淡的 */
const CHIP_CLASS: Readonly<Record<StandardDocState, string>> = { written: "chip-ok", template: "chip-quiet", missing: "chip-no", dropped: "chip-quiet" };

export function ProjectStandardSection({ project }: { project: Project }) {
  const { http, ui } = useStore();
  const [view, setView] = useState<ProjectStandardView>();
  const [error, setError] = useState<string>();
  // eslint-disable-next-line react-hooks/exhaustive-deps, react/exhaustive-effect-dependencies -- updatedAt 只用来在项目变了（状态、类型、规范改写）时重取
  useEffect(() => {
    const abort = new AbortController();
    http
      .projectStandard(project.id, abort.signal)
      .then((v) => {
        setView(v);
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (!abort.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      });
    return () => abort.abort();
  }, [http, project.id, project.updatedAt]);
  const standardCards = projectStandardCards(ui, project.id);
  if (!view) {
    return error ? (
      <Section title={t("pages.projects.standard.title")}>
        <div className="muted">{t("pages.projects.standard.loadFailed", { message: error })}</div>
      </Section>
    ) : null;
  }
  const block = projectStandardBlock(view);
  return (
    <Section
      title={t("pages.projects.standard.title")}
      extra={<span className="muted">{block.version ? t("pages.projects.standard.version", { version: block.version }) : t("pages.projects.standard.legacy")}</span>}
    >
      {block.newer && (
        <div className="proj-standard-newer" data-newer={block.newer}>
          <span className="chip chip-op">{t("pages.projects.standard.newer", { latest: block.newer })}</span>
        </div>
      )}
      <div className="chips proj-standard">
        {block.docs.map((d) => (
          <span key={d.key} className={`chip ${CHIP_CLASS[d.state]}`} data-state={d.state} data-override={d.override} title={d.path}>
            {t("pages.projects.standard.doc", { label: d.override === "change" ? t("pages.projects.standard.changedMark", { label: d.label }) : d.label, state: d.stateLabel })}
          </span>
        ))}
      </div>
      {block.kindPending && <div className="muted">{t("pages.projects.standard.kindPending")}</div>}
      {block.overrides.length > 0 && (
        <div className="proj-standard-overrides">
          <div className="proj-standard-overrides-title">{t("pages.projects.standard.overrides")}</div>
          <ul className="plain-list">
            {block.overrides.map((o) => (
              <li key={o.key}>
                {o.summary} <span className="muted">{o.meta}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {standardCards.map((id) => (
        <CardPanel key={id} cardId={id} />
      ))}
    </Section>
  );
}
