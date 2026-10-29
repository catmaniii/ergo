// 设置 · 关注类别（26 号票）：设置来自关注类别频道（守护进程从数据目录配置区的文件画出来），改动经 update_watch_categories 请求，
// 下一次工具调用就按新设置判定，不用重启。
// - 内置类别：对话、任务两套处置，下拉只给不比默认更松的档（"计划外工单"的对话一栏是"—"）；
// - 两条底线只显示、不能改；
// - 自己加的类别：确定的规则（匹配工具、路径、收件人、金额），两套处置可以是六档里的任何一档，随时改规则、改处置、删除；
//   规则里还没登记的工具提示"登记后生效"；删除或调松后，还有进行中的任务按确认时的设置检查它时说一声；
// - 设置文件坏了（用户手改坏的）：守卫一律拦下工具调用（判定出错），这里提示问题并给出修复（待我处理里也有一条事项带到这里）。
// 315 号票：最上面两个开关（SafetySwitches.tsx）——有风险的事先问我（guard.conversationApprovals）、任务超预算就停下
// （tasks.thresholds.budgetControl），新装时都开着，嫌烦能自己关；不受下面设置文件坏没坏影响。
import { useState } from "react";
import { useStore } from "../../app/store.tsx";
import {
  builtinChoices,
  type CategoryForm,
  categoryDraftOf,
  categoryFormOf,
  categoryMatchText,
  type CustomWatchCategoryView,
  DISPOSITION_LABEL,
  type Disposition,
  DISPOSITIONS,
  emptyCategoryForm,
  heldByTasksNotice,
  t,
  unregisteredTools,
  unregisteredToolsText,
  WATCH_CATEGORIES_BROKEN_COPY,
  WATCH_CATEGORY_REPAIR_LABEL,
  watchCategorySettings,
  type WatchScene,
  type WatchToolChoice,
} from "../../state/index.ts";
import { CategoryRuleFields, DispositionSelect } from "../../ui/category-rule.tsx";
import { Section, Sheet } from "../../ui/common.tsx";
import { T } from "../../ui/i18n.tsx";
import { SafetySwitches } from "./SafetySwitches.tsx";

/** 自定义类别的下拉给全部六档（由松到严） */
const ALL: readonly Disposition[] = DISPOSITIONS;

export function WatchCategoriesPage() {
  const { ui, updateWatchCategories } = useStore();
  const settings = watchCategorySettings(ui);
  const [editing, setEditing] = useState<CustomWatchCategoryView | "new">();
  const [deleting, setDeleting] = useState<CustomWatchCategoryView>();

  if (!settings)
    return (
      <>
        <SafetySwitches />
        <div className="muted">{t("pages.watch.loading")}</div>
      </>
    );
  const broken = settings.problems.length > 0;
  const held = heldByTasksNotice(ui);
  const setBuiltin = (categoryId: string, scene: WatchScene, disposition: Disposition) => updateWatchCategories({ op: "set_builtin", categoryId, scene, disposition });

  return (
    <>
      <SafetySwitches />
      <div className="muted">{t("pages.watch.intro", { askFirst: DISPOSITION_LABEL.ask_first, plannedOnly: DISPOSITION_LABEL.planned_only })}</div>

      {broken && (
        <div className="error" role="alert">
          <T k="pages.watch.broken" params={{ title: <b>{t("pages.watch.brokenTitle")}</b> }} />
          <ul className="plain-list">
            {settings.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <div className="auth-actions">
            <button type="button" className="btn primary small" onClick={() => updateWatchCategories({ op: "repair", to: "last_valid" })}>
              {WATCH_CATEGORY_REPAIR_LABEL.last_valid}
            </button>
            <button type="button" className="btn ghost small" onClick={() => updateWatchCategories({ op: "repair", to: "defaults" })}>
              {t("pages.watch.restoreDefaults")}
            </button>
            <button type="button" className="btn ghost small" onClick={() => updateWatchCategories({ op: "reload" })}>
              {t("pages.watch.reload")}
            </button>
          </div>
          <div className="hint">{t("pages.watch.brokenCopy", { file: WATCH_CATEGORIES_BROKEN_COPY })}</div>
        </div>
      )}

      <fieldset disabled={broken}>
        <Section title={t("pages.watch.builtin")} extra={<span className="muted">{t("pages.watch.builtinStricterOnly")}</span>}>
          <div className="cat-table">
            <div className="cat-h">
              <span>{t("pages.watch.category")}</span>
              <span>{t("pages.watch.inChat")}</span>
              <span>{t("pages.watch.inTask")}</span>
            </div>
            {settings.builtin.map((c) => (
              <div key={c.id} className="cat-row">
                <span className="cat-name">
                  {c.title}
                  {(c.chat !== c.defaults.chat || c.task !== c.defaults.task) && <span className="chip">{t("pages.watch.tightened")}</span>}
                </span>
                {c.chat === null ? (
                  <span className="muted" title={t("pages.watch.notInChat")}>
                    —
                  </span>
                ) : (
                  <DispositionSelect label={t("pages.watch.chatLabel", { title: c.title })} value={c.chat} options={builtinChoices(c, "chat")} onChange={(d) => setBuiltin(c.id, "chat", d)} />
                )}
                <DispositionSelect label={t("pages.watch.taskLabel", { title: c.title })} value={c.task} options={builtinChoices(c, "task")} onChange={(d) => setBuiltin(c.id, "task", d)} />
              </div>
            ))}
          </div>
          <div className="hint">{t("pages.watch.builtinHint", { doThenTell: DISPOSITION_LABEL.do_then_tell, plannedOnly: DISPOSITION_LABEL.planned_only, askFirst: DISPOSITION_LABEL.ask_first })}</div>
        </Section>

        <Section title={t("pages.watch.bottomLines")} extra={<span className="muted">{t("pages.watch.locked")}</span>}>
          {settings.bottomLines.map((b) => (
            <div key={b.id} className="cat-row cat-locked">
              <span className="cat-name">🔒 {b.title}</span>
              <span className="chip chip-high">{DISPOSITION_LABEL[b.disposition]}</span>
            </div>
          ))}
        </Section>

        <Section
          title={t("pages.watch.custom")}
          extra={
            <button type="button" className="btn primary small" onClick={() => setEditing("new")}>
              {t("pages.watch.newButton")}
            </button>
          }
        >
          {held && (
            <div className="hint" role="status">
              {held}
            </div>
          )}
          {settings.custom.length === 0 && <div className="muted">{t("pages.watch.noneYet")}</div>}
          {settings.custom.map((c) => {
            const save = (patch: Partial<CustomWatchCategoryView>) => {
              const next = { ...c, ...patch };
              updateWatchCategories({ op: "update_custom", categoryId: c.id, category: { title: next.title, match: next.match, chat: next.chat, task: next.task } });
            };
            const unregistered = unregisteredTools(c.match, settings.tools);
            return (
              <div key={c.id} className="cat-row cat-custom">
                <span className="cat-name">
                  {c.title}
                  <span className="muted"> · {categoryMatchText(c.match)}</span>
                  {unregistered.length > 0 && <span className="hint"> · {unregisteredToolsText(unregistered)}</span>}
                </span>
                <DispositionSelect label={t("pages.watch.chatLabel", { title: c.title })} value={c.chat} options={ALL} onChange={(d) => save({ chat: d })} />
                <DispositionSelect label={t("pages.watch.taskLabel", { title: c.title })} value={c.task} options={ALL} onChange={(d) => save({ task: d })} />
                <span className="cat-ops">
                  <button type="button" className="link" onClick={() => setEditing(c)}>
                    {t("pages.watch.editRule")}
                  </button>
                  <button type="button" className="link danger-text" onClick={() => setDeleting(c)}>
                    {t("pages.watch.delete")}
                  </button>
                </span>
              </div>
            );
          })}
          <div className="hint">{t("pages.watch.customHint")}</div>
        </Section>
      </fieldset>

      {editing && (
        <CategoryEditor
          initial={editing === "new" ? undefined : editing}
          tools={settings.tools}
          onClose={() => setEditing(undefined)}
          onSave={(draft) => {
            updateWatchCategories(editing === "new" ? { op: "create_custom", category: draft } : { op: "update_custom", categoryId: editing.id, category: draft });
            setEditing(undefined);
          }}
        />
      )}
      {deleting && (
        <Sheet title={t("pages.watch.deleteTitle", { title: deleting.title })} onClose={() => setDeleting(undefined)} center>
          <div className="muted">{t("pages.watch.deleteHint")}</div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={() => setDeleting(undefined)}>
              {t("pages.watch.dontDelete")}
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                updateWatchCategories({ op: "delete_custom", categoryId: deleting.id });
                setDeleting(undefined);
              }}
            >
              {t("pages.watch.delete")}
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}

function CategoryEditor({
  initial,
  tools,
  onClose,
  onSave,
}: {
  initial?: CustomWatchCategoryView;
  tools: readonly WatchToolChoice[];
  onClose(): void;
  onSave(draft: Extract<ReturnType<typeof categoryDraftOf>, { draft: unknown }>["draft"]): void;
}) {
  const [form, setForm] = useState<CategoryForm>(initial ? categoryFormOf(initial) : emptyCategoryForm());
  const [problems, setProblems] = useState<string[]>([]);
  return (
    <Sheet title={initial ? t("pages.watch.editTitle", { title: initial.title }) : t("pages.watch.newTitle")} onClose={onClose} center>
      <CategoryRuleFields form={form} onChange={(next) => setForm(next)} tools={tools} />
      <label className="field">
        <span>{t("pages.watch.inChat")}</span>
        <DispositionSelect label={t("pages.watch.inChat")} value={form.chat} options={ALL} onChange={(chat) => setForm({ ...form, chat })} />
      </label>
      <label className="field">
        <span>{t("pages.watch.inTask")}</span>
        <DispositionSelect label={t("pages.watch.inTask")} value={form.task} options={ALL} onChange={(task) => setForm({ ...form, task })} />
      </label>
      {problems.length > 0 && (
        <ul className="plain-list error">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          {t("pages.watch.cancel")}
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            const result = categoryDraftOf(form);
            if ("problems" in result) setProblems(result.problems);
            else onSave(result.draft);
          }}
        >
          {t("pages.watch.save")}
        </button>
      </div>
    </Sheet>
  );
}
