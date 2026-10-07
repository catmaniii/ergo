// 设置 · 关注类别（26 号票）：设置来自关注类别频道（守护进程从数据目录配置区的文件画出来），改动经 update_watch_categories 请求，
// 下一次工具调用就按新设置判定，不用重启。
// - 内置类别：对话、任务两套处置，下拉只给不比默认更松的档（"计划外工单"的对话一栏是"—"）；
// - 两条底线只显示、不能改；
// - 自己加的类别：确定的规则（匹配工具、路径、收件人、金额），两套处置可以是六档里的任何一档，随时改规则、改处置、删除；
// - 设置文件坏了（用户手改坏的）：守卫一律拦下工具调用（判定出错），这里提示问题并给出修复。
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
  WATCH_CATEGORIES_BROKEN_COPY,
  WATCH_CATEGORY_REPAIR_LABEL,
  watchCategorySettings,
  type WatchScene,
  type WatchToolChoice,
} from "../../state/index.ts";
import { CategoryRuleFields, DispositionSelect } from "../../ui/category-rule.tsx";
import { Section, Sheet } from "../../ui/common.tsx";

/** 自定义类别的下拉给全部六档（由松到严） */
const ALL: readonly Disposition[] = DISPOSITIONS;

export function WatchCategoriesPage() {
  const { ui, updateWatchCategories } = useStore();
  const settings = watchCategorySettings(ui);
  const [editing, setEditing] = useState<CustomWatchCategoryView | "new">();
  const [deleting, setDeleting] = useState<CustomWatchCategoryView>();

  if (!settings) return <div className="muted">正在读取关注类别设置……</div>;
  const broken = settings.problems.length > 0;
  const setBuiltin = (categoryId: string, scene: WatchScene, disposition: Disposition) => updateWatchCategories({ op: "set_builtin", categoryId, scene, disposition });

  return (
    <>
      <div className="muted">守卫在每次工具调用之前判断它落在哪些类别里，按处置决定怎么做。"先问我"是执行时一定当场问；"计划里列了才做"才是靠计划一次授权。改了马上生效。</div>

      {broken && (
        <div className="error" role="alert">
          <b>关注类别的设置文件坏了</b>：守卫现在一律拦下工具调用（判定出错）。下面是上一次有效的设置。
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
              恢复默认
            </button>
            <button type="button" className="btn ghost small" onClick={() => updateWatchCategories({ op: "reload" })}>
              我手改好了，重新读取
            </button>
          </div>
          <div className="hint">修复时坏掉的文件另存为配置区里的 {WATCH_CATEGORIES_BROKEN_COPY}。</div>
        </div>
      )}

      <fieldset disabled={broken}>
        <Section title="内置类别" extra={<span className="muted">只能往严里调</span>}>
          <div className="cat-table">
            <div className="cat-h">
              <span>类别</span>
              <span>对话里</span>
              <span>任务里</span>
            </div>
            {settings.builtin.map((c) => (
              <div key={c.id} className="cat-row">
                <span className="cat-name">
                  {c.title}
                  {(c.chat !== c.defaults.chat || c.task !== c.defaults.task) && <span className="chip">调严了</span>}
                </span>
                {c.chat === null ? (
                  <span className="muted" title="对话里不适用">
                    —
                  </span>
                ) : (
                  <DispositionSelect label={`${c.title}：对话里`} value={c.chat} options={builtinChoices(c, "chat")} onChange={(d) => setBuiltin(c.id, "chat", d)} />
                )}
                <DispositionSelect label={`${c.title}：任务里`} value={c.task} options={builtinChoices(c, "task")} onChange={(d) => setBuiltin(c.id, "task", d)} />
              </div>
            ))}
          </div>
          <div className="hint">不落在任何类别里的调用直接做只记录；带"做完告诉我"标记的工具（比如 git 提交）做完告诉你。对话里没有计划，"计划里列了才做"等同"先问我"。</div>
        </Section>

        <Section title="两条底线" extra={<span className="muted">不能改</span>}>
          {settings.bottomLines.map((b) => (
            <div key={b.id} className="cat-row cat-locked">
              <span className="cat-name">🔒 {b.title}</span>
              <span className="chip chip-high">{DISPOSITION_LABEL[b.disposition]}</span>
            </div>
          ))}
        </Section>

        <Section
          title="你自己加的类别"
          extra={
            <button type="button" className="btn primary small" onClick={() => setEditing("new")}>
              ＋ 新建类别
            </button>
          }
        >
          {settings.custom.length === 0 && <div className="muted">还没有</div>}
          {settings.custom.map((c) => {
            const save = (patch: Partial<CustomWatchCategoryView>) => {
              const next = { ...c, ...patch };
              updateWatchCategories({ op: "update_custom", categoryId: c.id, category: { title: next.title, match: next.match, chat: next.chat, task: next.task } });
            };
            return (
              <div key={c.id} className="cat-row cat-custom">
                <span className="cat-name">
                  {c.title}
                  <span className="muted"> · {categoryMatchText(c.match)}</span>
                </span>
                <DispositionSelect label={`${c.title}：对话里`} value={c.chat} options={ALL} onChange={(d) => save({ chat: d })} />
                <DispositionSelect label={`${c.title}：任务里`} value={c.task} options={ALL} onChange={(d) => save({ task: d })} />
                <span className="cat-ops">
                  <button type="button" className="link" onClick={() => setEditing(c)}>
                    改规则
                  </button>
                  <button type="button" className="link danger-text" onClick={() => setDeleting(c)}>
                    删除
                  </button>
                </span>
              </div>
            );
          })}
          <div className="hint">自定义类别只能写确定的规则（匹配工具、路径、收件人、金额）；处置随你定，但一次调用命中好几个类别时取最严的，所以放宽不了内置类别和两条底线。用模型判断的类别以后再加。</div>
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
        <Sheet title={`删除类别「${deleting.title}」？`} onClose={() => setDeleting(undefined)} center>
          <div className="muted">删掉之后不再命中；正在执行的任务下一次判定也按新设置走（任务里只为它加的类别不受影响）。</div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={() => setDeleting(undefined)}>
              算了
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                updateWatchCategories({ op: "delete_custom", categoryId: deleting.id });
                setDeleting(undefined);
              }}
            >
              删除
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
    <Sheet title={initial ? `改类别：${initial.title}` : "新建关注类别"} onClose={onClose} center>
      <CategoryRuleFields form={form} onChange={(next) => setForm(next)} tools={tools} />
      <label className="field">
        <span>对话里</span>
        <DispositionSelect label="对话里" value={form.chat} options={ALL} onChange={(chat) => setForm({ ...form, chat })} />
      </label>
      <label className="field">
        <span>任务里</span>
        <DispositionSelect label="任务里" value={form.task} options={ALL} onChange={(task) => setForm({ ...form, task })} />
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
          取消
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
          保存
        </button>
      </div>
    </Sheet>
  );
}
