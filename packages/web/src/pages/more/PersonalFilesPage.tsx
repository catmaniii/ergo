// 个人档案（281 号票）：用户本人和档案里的人各一份，内核的数据（停用记忆插件也在）。
// 285 号票起它在哪：记忆插件在用时是记忆页里的"档案"一栏（#/more/memory/files[/<编号>]，plugins/memory/MemoryPage.tsx）；记忆插件停用时
// 是"更多"里的个人档案（#/more/files[/<编号>]，pages/MorePage.tsx）。两处都画 PersonalFilesColumn（标题栏、"加一个人"、列表或一份档案）。
// 设置 · 身份（"我的名字"下面）一个链接，去这两处里在的那一处。
// - 列表（285 号票）：分四组——我（本人那份，一直在）、家人、重要的人、其他人（state/personal-files.ts 的 personalFileGroups），
//   组名后写几个人，空的组写"还没有"；标题栏上"加一个人"，就地填称呼、关系、分组（不选按关系猜）；
// - 一份档案三块：固定信息（每个字段一行：现在的值、出处——哪天起、怎么写进来的、原话；以前的值点开看；"改"就地改，改了就算确认；
//   改的时候能撤销最近一次写入、删这个字段）、记下的事（日期、原文、出处；记一件、删一件）、二狗了解到的；
//   号码类按组分开写（身份证号 6 · 8 · 4、手机号 3 · 4 · 4），等宽字；
// - 283 号票：生日、纪念日字段下面一个"每年提前几天提醒"的勾（勾上、改天数、取消都当场生效；农历、提醒插件没启用写明）；
// - 302 号票：内置字段"纪念日"能有几个、各带名字：一个都没有时列一个空的"纪念日"（"填写"就地填名字和日子），有了排在生日后面，
//   最后一个下面"再加一个纪念日"；
//   "二狗了解到的"经记忆插件现取（GET /api/personal-files/<编号>/learned）：统一记忆里和这个人有关的结论、事实、原话，只读；
//   记忆插件没启用、推理库还没建好时写一句原因，不报错；
// - 删：忘掉（档案里没有了，原话还在）或彻底删除（连同核对卡、读过它的记录一起抹掉，收不回），彻底删除时可以勾"出处的原话也一起删"
//   （照删素材的规矩问你）；本人那份删不掉，删一个人连他的整份档案；
// - 本人的姓名就是设置 · 身份里的"我的名字"：这里改了那里跟着变，反过来也是（没有历史）。
// - 285 号票：一份档案的头上（名字、关系旁边）一个"分组"的下拉，改了当场生效；没选过的写"按关系猜的，可以改"。
// 档案经 HTTP 现取（不走事件）；每次改完用接口回的那份。版式照现有设计体系（分节、行、按钮、Sheet 确认框都是现成的类），
// 入口位置和版式要用户定（票的 Comments）。
import { type FormEvent, Fragment, useCallback, useEffect, useState } from "react";
import { useStore } from "../../app/store.tsx";
import {
  ANNIVERSARY_FIELD,
  anniversaryFieldOf,
  anniversaryNameOf,
  ANNUAL_REMINDER_DEFAULT_DAYS,
  annualNote,
  annualPickable,
  ASSISTANT_NAME_MARK,
  customFieldOf,
  deletableSources,
  numberGroups,
  type PersonalFieldView,
  type PersonalFileDeleteMode,
  type PersonalFileLearnedView,
  type PersonalFileDeleteTarget,
  type PersonalFilesView,
  type PersonalFileView,
  personalDate,
  personalFileGroups,
  personalFileName,
  personalFileSub,
  learnedClaimMeta,
  PERSON_GROUP_LABEL,
  PERSON_GROUPS,
  type PersonGroup,
  isPersonGroup,
  sourceQuote,
  sourceVia,
  t,
  valueSourceLine,
} from "../../state/index.ts";
import { NamedText } from "../../ui/assistant-name.tsx";
import { AnnualRemindPick } from "../../ui/cards/AnnualRemindPick.tsx";
import { Section, Sheet, TopBar } from "../../ui/common.tsx";
import { useToast } from "../../ui/toast.tsx";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** 今天（这台设备的日子）：记一件事默认写它 */
const today = () => new Date().toLocaleDateString("en-CA");
/** 正在加的自定义字段（不是哪个已有的字段） */
const NEW_FIELD = "+new";
/** 302：正在再加一个纪念日（已经有了几个以后） */
const NEW_ANNIVERSARY = "+anniversary";

/**
 * 档案的一栏（285 号票）：标题栏（列表上有"加一个人"）和一整块滚动区，里面是列表或者点开的一个人。记忆 · 档案和"更多"里的个人档案都画它；
 * onBack 是标题栏的 ‹（宽屏的列表没有）
 */
export function PersonalFilesColumn({
  title,
  item,
  onBack,
  onOpen,
  onRemoved,
}: {
  title: string;
  item?: string | undefined;
  onBack: (() => void) | undefined;
  onOpen(personId: string): void;
  onRemoved(): void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="chat-col">
      <TopBar title={title} onBack={onBack}>
        {item === undefined && !adding && (
          <button type="button" className="btn small ghost" data-action="add-person" onClick={() => setAdding(true)}>
            {t("pages.personalFiles.addPerson")}
          </button>
        )}
      </TopBar>
      <div className="scroll page-pad">
        {item === undefined ? <FilesList onOpen={onOpen} adding={adding} onAdding={setAdding} /> : <FileDetail key={item} personId={item} onRemoved={onRemoved} />}
      </div>
    </div>
  );
}

/** 列表（285 号票）：我、家人、重要的人、其他人四组；正在加人时最上面是就地填的表 */
function FilesList({ onOpen, adding, onAdding }: { onOpen(personId: string): void; adding: boolean; onAdding(adding: boolean): void }) {
  const { http } = useStore();
  const [view, setView] = useState<PersonalFilesView>();
  const [failed, setFailed] = useState<string>();
  useEffect(() => {
    let live = true;
    http.personalFiles().then(
      (v) => live && setView(v),
      (err: unknown) => live && setFailed(errorText(err)),
    );
    return () => {
      live = false;
    };
  }, [http]);
  return (
    <div className="pf-page">
      <p className="muted pf-intro">
        <NamedText text={t("pages.personalFiles.intro", { name: ASSISTANT_NAME_MARK })} />
      </p>
      {adding && (
        <AddPersonForm
          onCancel={() => onAdding(false)}
          onAdded={(file) => {
            onAdding(false);
            onOpen(file.id);
          }}
        />
      )}
      {failed && <div className="hint">{t("pages.personalFiles.loadFailed", { reason: failed })}</div>}
      {!view && !failed && <div className="muted">{t("pages.personalFiles.loading")}</div>}
      {view &&
        personalFileGroups(view).map((group) => (
          <Section
            key={group.id}
            title={
              <span className="pf-group-title" data-group={group.id}>
                {group.title}
                {group.id !== "me" && <span className="pf-group-count">{group.files.length}</span>}
              </span>
            }
          >
            {group.files.length === 0 ? (
              <div className="muted">{t("pages.personalFiles.groupEmpty")}</div>
            ) : (
              <div className="prompt-rows">
                {group.files.map((f) => (
                  <FileRow key={f.id} name={personalFileName(f)} sub={personalFileSub(f)} onOpen={() => onOpen(f.id)} />
                ))}
              </div>
            )}
          </Section>
        ))}
    </div>
  );
}

/** 285：分组的下拉（第一项给了 none 时是"不选（按关系猜）"） */
function GroupSelect({ value, none, disabled, onChange }: { value: PersonGroup | ""; none?: boolean; disabled?: boolean; onChange(value: PersonGroup | ""): void }) {
  return (
    <select
      className="input pf-group-select"
      aria-label={t("pages.personalFiles.groupLabel")}
      value={value}
      disabled={disabled}
      onChange={(e) => {
        const next = e.currentTarget.value;
        onChange(isPersonGroup(next) ? next : "");
      }}
    >
      {none && <option value="">{t("pages.personalFiles.groupGuess")}</option>}
      {PERSON_GROUPS.map((g) => (
        <option key={g} value={g}>
          {PERSON_GROUP_LABEL[g]}
        </option>
      ))}
    </select>
  );
}

function FileRow({ name, sub, onOpen }: { name: string; sub: string; onOpen(): void }) {
  return (
    <button type="button" className="prompt-row pf-row" onClick={onOpen}>
      <span className="prompt-row-text">
        <span>{name}</span>
        <small className="muted">{sub}</small>
      </span>
      <span className="muted">›</span>
    </button>
  );
}

/** 就地加一个人：称呼（必填）、关系、分组（285：不选按关系猜） */
function AddPersonForm({ onCancel, onAdded }: { onCancel(): void; onAdded(file: PersonalFileView): void }) {
  const { http } = useStore();
  const [name, setName] = useState("");
  const [relation, setRelation] = useState("");
  const [group, setGroup] = useState<PersonGroup | "">("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    http
      .addPerson({ name, ...(relation.trim() === "" ? {} : { relation }), ...(group === "" ? {} : { group }) })
      .then(onAdded, (err: unknown) => setFailed(errorText(err)))
      .finally(() => setBusy(false));
  };
  return (
    <form className="pf-form" onSubmit={submit}>
      <label className="field">
        <span>{t("pages.personalFiles.nameLabel")}</span>
        <input className="input" value={name} autoFocus placeholder={t("pages.personalFiles.namePlaceholder")} onChange={(e) => setName(e.currentTarget.value)} />
      </label>
      <label className="field">
        <span>{t("pages.personalFiles.relationLabel")}</span>
        <input className="input" value={relation} placeholder={t("pages.personalFiles.relationPlaceholder")} onChange={(e) => setRelation(e.currentTarget.value)} />
      </label>
      <label className="field">
        <span>{t("pages.personalFiles.groupLabel")}</span>
        <GroupSelect value={group} none onChange={setGroup} />
      </label>
      {failed && (
        <div className="field-error" role="alert">
          {failed}
        </div>
      )}
      <div className="pf-form-actions">
        <button type="button" className="btn ghost small" onClick={onCancel}>
          {t("pages.personalFiles.cancel")}
        </button>
        <button type="submit" className="btn primary small" disabled={busy || name.trim() === ""}>
          {t("pages.personalFiles.add")}
        </button>
      </div>
    </form>
  );
}

/** 一份档案：固定信息、记下的事、二狗了解到的；重要的人最下面能删整份 */
function FileDetail({ personId, onRemoved }: { personId: string; onRemoved(): void }) {
  const { http } = useStore();
  const toast = useToast();
  const [file, setFile] = useState<PersonalFileView>();
  const [failed, setFailed] = useState<string>();
  /** 正在改的字段（NEW_FIELD 是在加自定义字段，NEW_ANNIVERSARY 是在再加一个纪念日） */
  const [editing, setEditing] = useState<string>();
  const [addingNote, setAddingNote] = useState(false);
  const [deleting, setDeleting] = useState<PersonalFileDeleteTarget>();
  useEffect(() => {
    let live = true;
    http.personalFile(personId).then(
      (f) => live && setFile(f),
      (err: unknown) => live && setFailed(errorText(err)),
    );
    return () => {
      live = false;
    };
  }, [http, personId]);
  /** 改完用接口回的那份；不让改的原因原样提示 */
  const apply = useCallback(
    (request: Promise<PersonalFileView>) =>
      request.then(
        (f) => {
          setFile(f);
          return true;
        },
        (err: unknown) => {
          toast(t("pages.personalFiles.failed", { reason: errorText(err) }));
          return false;
        },
      ),
    [toast],
  );
  if (failed) return <div className="hint">{t("pages.personalFiles.loadFailed", { reason: failed })}</div>;
  if (!file) return <div className="muted">{t("pages.personalFiles.loading")}</div>;
  const relation = file.fields.find((f) => f.field === "relation")?.current?.value;
  return (
    <div className="pf-page">
      <div className="pf-head">
        <h2 className="pf-name">{personalFileName(file)}</h2>
        {file.kind === "self" ? <span className="chip chip-quiet">{t("pages.personalFiles.selfChip")}</span> : relation !== undefined && <span className="chip chip-quiet">{relation}</span>}
      </div>
      {/* 285：分组（家人、重要的人、其他人）；没选过的写按关系猜的 */}
      {file.kind === "person" && file.group !== undefined && (
        <label className="pf-group-pick">
          <span className="pf-label">{t("pages.personalFiles.groupLabel")}</span>
          <GroupSelect value={file.group} onChange={(group) => group !== "" && void apply(http.changePersonalFile(file.id, { kind: "set_group", group }))} />
          {file.groupGuessed === true && <small className="muted">{t("pages.personalFiles.groupGuessed")}</small>}
        </label>
      )}
      <Section
        title={t("pages.personalFiles.fieldsTitle")}
        extra={
          editing !== NEW_FIELD && (
            <button type="button" className="btn small ghost" onClick={() => setEditing(NEW_FIELD)}>
              {t("pages.personalFiles.addField")}
            </button>
          )
        }
      >
        <div className="pf-fields">
          {file.fields.map((field, i) => {
            // 302：最后一个纪念日下面"再加一个纪念日"；空的"纪念日"点"填写"就地填名字和日子
            const lastAnniversary = anniversaryNameOf(field.field) !== undefined && anniversaryNameOf(file.fields[i + 1]?.field ?? "") === undefined;
            return (
              <Fragment key={field.field}>
                {field.field === ANNIVERSARY_FIELD && editing === field.field ? (
                  <NewFieldRow file={file} apply={apply} onDone={() => setEditing(undefined)} anniversary />
                ) : (
                  <FieldRow
                    file={file}
                    field={field}
                    editing={editing === field.field}
                    onEdit={() => setEditing(field.field)}
                    onDone={() => setEditing(undefined)}
                    apply={apply}
                    onDelete={() => setDeleting({ kind: "field", field: field.field })}
                  />
                )}
                {lastAnniversary &&
                  (editing === NEW_ANNIVERSARY ? (
                    <NewFieldRow file={file} apply={apply} onDone={() => setEditing(undefined)} anniversary />
                  ) : (
                    <div className="pf-field-more">
                      <button type="button" className="btn small ghost" onClick={() => setEditing(NEW_ANNIVERSARY)}>
                        {t("pages.personalFiles.addAnniversary")}
                      </button>
                    </div>
                  ))}
              </Fragment>
            );
          })}
          {editing === NEW_FIELD && <NewFieldRow file={file} apply={apply} onDone={() => setEditing(undefined)} />}
        </div>
      </Section>
      <Section
        title={t("pages.personalFiles.notesTitle")}
        extra={
          !addingNote && (
            <button type="button" className="btn small ghost" onClick={() => setAddingNote(true)}>
              {t("pages.personalFiles.addNote")}
            </button>
          )
        }
      >
        {addingNote && <NoteForm file={file} apply={apply} onDone={() => setAddingNote(false)} />}
        {file.notes.length === 0 && !addingNote && <div className="muted">{t("pages.personalFiles.noNotes")}</div>}
        {file.notes.length > 0 && (
          <div className="pf-notes">
            {file.notes.map((note) => {
              const quote = sourceQuote(note.source);
              return (
                <div key={note.id} className="pf-note">
                  <div className="pf-note-head">
                    <span className="pf-note-date">{note.date}</span>
                    <button type="button" className="btn small ghost" onClick={() => setDeleting({ kind: "note", noteId: note.id })}>
                      {t("pages.personalFiles.delete")}
                    </button>
                  </div>
                  <div className="pf-note-text">{note.text}</div>
                  <small className="muted pf-source">
                    {t("pages.personalFiles.noteSource", { date: personalDate(note.source.at), via: sourceVia(note.source) })}
                    {quote !== undefined && <span className="pf-quote">{quote}</span>}
                  </small>
                </div>
              );
            })}
          </div>
        )}
      </Section>
      <Section title={<NamedText text={t("pages.personalFiles.learnedTitle", { name: ASSISTANT_NAME_MARK })} />}>
        <LearnedBlock personId={file.id} />
      </Section>
      {file.kind === "person" && (
        <div className="pf-danger">
          <button type="button" className="btn ghost danger-text" onClick={() => setDeleting({ kind: "person" })}>
            {t("pages.personalFiles.deletePerson", { name: personalFileName(file) })}
          </button>
        </div>
      )}
      {deleting && (
        <DeleteSheet
          file={file}
          target={deleting}
          onClose={() => setDeleting(undefined)}
          onDone={(next) => {
            setDeleting(undefined);
            setEditing(undefined);
            if (next) setFile(next);
            else onRemoved();
          }}
        />
      )}
    </div>
  );
}

/** 生日、纪念日的每年提醒（283 号票）：勾上、改天数、取消当场生效；认不出日子、提醒插件没启用时写明 */
function AnnualRow({
  file,
  field,
  annual,
  apply,
}: {
  file: PersonalFileView;
  field: PersonalFieldView;
  annual: NonNullable<PersonalFieldView["annual"]>;
  apply(request: Promise<PersonalFileView>): Promise<boolean>;
}) {
  const { http } = useStore();
  const [busy, setBusy] = useState(false);
  const note = annualNote(annual);
  const pickable = annualPickable(annual);
  return (
    <div className="pf-annual">
      {pickable && (
        <AnnualRemindPick
          label={field.label}
          on={annual.daysBefore !== undefined}
          days={annual.daysBefore ?? ANNUAL_REMINDER_DEFAULT_DAYS}
          disabled={busy}
          onChange={(next) => {
            setBusy(true);
            void apply(http.changePersonalFile(file.id, { kind: "set_reminder", field: field.field, daysBefore: next.on ? next.days : null })).finally(() => setBusy(false));
          }}
        />
      )}
      {note !== undefined && <small className="muted">{note}</small>}
    </div>
  );
}

/** 二狗了解到的（283 号票）：经记忆插件现取，只读；没启用、没建好写原因 */
function LearnedBlock({ personId }: { personId: string }) {
  const { http } = useStore();
  const [view, setView] = useState<PersonalFileLearnedView>();
  const [failed, setFailed] = useState<string>();
  useEffect(() => {
    let live = true;
    http.personalFileLearned(personId).then(
      (v) => live && setView(v),
      (err: unknown) => live && setFailed(errorText(err)),
    );
    return () => {
      live = false;
    };
  }, [http, personId]);
  if (failed) return <div className="muted">{t("pages.personalFiles.learned.failed", { reason: failed })}</div>;
  if (!view) return <div className="muted">{t("pages.personalFiles.loading")}</div>;
  if (!view.ready) return <div className="muted">{t("pages.personalFiles.learned.unavailable", { reason: view.reason ?? "" })}</div>;
  if (view.claims.length === 0 && view.facts.length === 0 && view.quotes.length === 0)
    return (
      <div className="muted">
        <NamedText text={t("pages.personalFiles.learned.empty", { name: ASSISTANT_NAME_MARK })} />
      </div>
    );
  return (
    <div className="pf-learned">
      <small className="muted">
        <NamedText text={t("pages.personalFiles.learned.hint", { name: ASSISTANT_NAME_MARK })} />
        {view.entities.length > 0 && t("pages.personalFiles.learned.names", { names: view.entities.join(t("pages.personalFiles.learned.sep")) })}
      </small>
      {view.claims.length > 0 && (
        <>
          <h4 className="pf-learned-sub">{t("pages.personalFiles.learned.claims")}</h4>
          <ul className="pf-learned-list">
            {view.claims.map((c) => (
              <li key={c.id}>
                <span>{c.statement}</span>
                <small className="muted pf-learned-meta">{learnedClaimMeta(c)}</small>
              </li>
            ))}
          </ul>
        </>
      )}
      {view.facts.length > 0 && (
        <>
          <h4 className="pf-learned-sub">{t("pages.personalFiles.learned.facts")}</h4>
          <ul className="pf-learned-list">
            {view.facts.map((f) => (
              <li key={f.id}>
                <span>{f.statement}</span>
                <small className="muted pf-learned-meta">{personalDate(f.observedAt)}</small>
              </li>
            ))}
          </ul>
        </>
      )}
      {view.quotes.length > 0 && (
        <>
          <h4 className="pf-learned-sub">{t("pages.personalFiles.learned.quotes")}</h4>
          <ul className="pf-learned-list">
            {view.quotes.map((q) => (
              <li key={q.id}>
                <span>{t("pages.personalFiles.learned.quote", { text: q.text })}</span>
                <small className="muted pf-learned-meta">{personalDate(q.at)}</small>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** 号码按组分开写（等宽字），读得出一位一位 */
function NumberValue({ value }: { value: string }) {
  return (
    <span className="pf-number" aria-label={value}>
      {numberGroups(value).map((group, i) => (
        <span key={i} className="pf-number-group">
          {group.join("")}
        </span>
      ))}
    </span>
  );
}

/** 一个字段：值、出处、以前的值；"改"就地改（改的时候能撤销最近一次、删这个字段） */
function FieldRow({
  file,
  field,
  editing,
  onEdit,
  onDone,
  apply,
  onDelete,
}: {
  file: PersonalFileView;
  field: PersonalFieldView;
  editing: boolean;
  onEdit(): void;
  onDone(): void;
  apply(request: Promise<PersonalFileView>): Promise<boolean>;
  onDelete(): void;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const current = field.current;
  const quote = sourceQuote(current?.source);
  if (editing) return <FieldEditor file={file} field={field} onDone={onDone} apply={apply} onDelete={onDelete} />;
  return (
    <div className="pf-field" data-field={field.field}>
      <div className="pf-label">{field.label}</div>
      <div className="pf-value">
        {current ? field.number ? <NumberValue value={current.value} /> : <span className="pf-text">{current.value}</span> : <span className="muted">{t("pages.personalFiles.empty")}</span>}
        {!current && field.field === ANNIVERSARY_FIELD && <small className="muted">{t("pages.personalFiles.anniversaryHint")}</small>}
        {current && (
          <small className="muted pf-source">
            {valueSourceLine(current)}
            {quote !== undefined && <span className="pf-quote">{quote}</span>}
          </small>
        )}
        {current && field.annual && <AnnualRow file={file} field={field} annual={field.annual} apply={apply} />}
        {field.history.length > 0 && (
          <button type="button" className="pf-history-toggle" aria-expanded={showHistory} onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? "▾ " : "▸ "}
            {t("pages.personalFiles.history", { count: field.history.length })}
          </button>
        )}
        {showHistory && (
          <ul className="pf-history">
            {field.history.map((old, i) => (
              <li key={i}>
                <span className="pf-text">{old.value}</span>
                <small className="muted">{valueSourceLine(old)}</small>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="pf-actions">
        <button type="button" className="btn small ghost" onClick={onEdit}>
          {current ? t("pages.personalFiles.edit") : t("pages.personalFiles.fill")}
        </button>
      </div>
    </div>
  );
}

/** 就地改一个字段（每次打开从现在的值起）：保存、取消，有值时还能撤销最近一次、删掉 */
function FieldEditor({
  file,
  field,
  onDone,
  apply,
  onDelete,
}: {
  file: PersonalFileView;
  field: PersonalFieldView;
  onDone(): void;
  apply(request: Promise<PersonalFileView>): Promise<boolean>;
  onDelete(): void;
}) {
  const { http } = useStore();
  const [draft, setDraft] = useState(field.current?.value ?? "");
  const [busy, setBusy] = useState(false);
  const run = (request: () => Promise<PersonalFileView>) => {
    setBusy(true);
    void apply(request())
      .then((ok) => ok && onDone())
      .finally(() => setBusy(false));
  };
  const current = field.current;
  // 称呼不能删（删整个人）；本人的姓名删了就是清除"我的名字"；本人的姓名没有可撤销的历史
  const canDelete = current !== undefined && !(file.kind === "person" && field.field === "name");
  const canUndo = current !== undefined && field.linked === undefined && !(file.kind === "person" && field.field === "name" && field.history.length === 0);
  return (
    <form
      className="pf-field pf-field-editing"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => http.changePersonalFile(file.id, { kind: "set_field", field: field.field, value: draft }));
      }}
    >
      <div className="pf-label">{field.label}</div>
      <div className="pf-value">
        <input className="input" value={draft} autoFocus aria-label={field.label} onChange={(e) => setDraft(e.currentTarget.value)} />
        {field.linked === "user_name" && <small className="muted">{t("pages.personalFiles.linkedHint")}</small>}
        <div className="pf-form-actions">
          {canUndo && (
            <button type="button" className="btn ghost small" disabled={busy} onClick={() => run(() => http.changePersonalFile(file.id, { kind: "undo_field", field: field.field }))}>
              {t("pages.personalFiles.undo")}
            </button>
          )}
          {canDelete && (
            <button type="button" className="btn ghost small danger-text" disabled={busy} onClick={onDelete}>
              {t("pages.personalFiles.delete")}
            </button>
          )}
          <span className="pf-spacer" />
          <button type="button" className="btn ghost small" onClick={onDone}>
            {t("pages.personalFiles.cancel")}
          </button>
          <button type="submit" className="btn primary small" disabled={busy || draft.trim() === "" || draft === current?.value}>
            {t("pages.personalFiles.save")}
          </button>
        </div>
      </div>
    </form>
  );
}

/**
 * 加一个自定义字段：名字和值。302：anniversary 是加一个纪念日——名字（"结婚纪念日"，不填就叫"纪念日"）和日子，
 * 写进内置的"纪念日"（"anniversary:<名字>"），认得出公历日子的保存后能开每年提醒
 */
function NewFieldRow({ file, apply, onDone, anniversary = false }: { file: PersonalFileView; apply(request: Promise<PersonalFileView>): Promise<boolean>; onDone(): void; anniversary?: boolean }) {
  const { http } = useStore();
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const field = anniversary ? (label.trim() === "" ? ANNIVERSARY_FIELD : anniversaryFieldOf(label)) : customFieldOf(label);
  return (
    <form
      className="pf-field pf-field-editing"
      data-field={anniversary ? NEW_ANNIVERSARY : NEW_FIELD}
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void apply(http.changePersonalFile(file.id, { kind: "set_field", field, value }))
          .then((ok) => ok && onDone())
          .finally(() => setBusy(false));
      }}
    >
      <div className="pf-label">
        <input
          className="input"
          value={label}
          autoFocus
          placeholder={t(anniversary ? "pages.personalFiles.anniversaryNamePlaceholder" : "pages.personalFiles.customLabelPlaceholder")}
          aria-label={t(anniversary ? "pages.personalFiles.anniversaryName" : "pages.personalFiles.customLabel")}
          onChange={(e) => setLabel(e.currentTarget.value)}
        />
      </div>
      <div className="pf-value">
        <input
          className="input"
          value={value}
          placeholder={t(anniversary ? "pages.personalFiles.anniversaryDatePlaceholder" : "pages.personalFiles.customValuePlaceholder")}
          aria-label={t(anniversary ? "pages.personalFiles.anniversaryDate" : "pages.personalFiles.customValue")}
          onChange={(e) => setValue(e.currentTarget.value)}
        />
        <div className="pf-form-actions">
          <span className="pf-spacer" />
          <button type="button" className="btn ghost small" onClick={onDone}>
            {t("pages.personalFiles.cancel")}
          </button>
          <button type="submit" className="btn primary small" disabled={busy || (!anniversary && label.trim() === "") || value.trim() === ""}>
            {t("pages.personalFiles.save")}
          </button>
        </div>
      </div>
    </form>
  );
}

/** 记一件事：原文和日期（默认今天） */
function NoteForm({ file, apply, onDone }: { file: PersonalFileView; apply(request: Promise<PersonalFileView>): Promise<boolean>; onDone(): void }) {
  const { http } = useStore();
  const [text, setText] = useState("");
  const [date, setDate] = useState(today);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="pf-form"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void apply(http.changePersonalFile(file.id, { kind: "add_note", text, ...(date === "" ? {} : { date }) }))
          .then((ok) => ok && onDone())
          .finally(() => setBusy(false));
      }}
    >
      <label className="field">
        <span>{t("pages.personalFiles.noteLabel")}</span>
        <textarea className="input" rows={3} value={text} autoFocus placeholder={t("pages.personalFiles.notePlaceholder")} onChange={(e) => setText(e.currentTarget.value)} />
      </label>
      <label className="field">
        <span>{t("pages.personalFiles.noteDate")}</span>
        <input className="input" type="date" value={date} onChange={(e) => setDate(e.currentTarget.value)} />
      </label>
      <div className="pf-form-actions">
        <span className="pf-spacer" />
        <button type="button" className="btn ghost small" onClick={onDone}>
          {t("pages.personalFiles.cancel")}
        </button>
        <button type="submit" className="btn primary small" disabled={busy || text.trim() === ""}>
          {t("pages.personalFiles.save")}
        </button>
      </div>
    </form>
  );
}

/** 删一样东西：忘掉（默认）或彻底删除；彻底删除时可以连出处的原话一起（有几句写几句） */
function DeleteSheet({ file, target, onClose, onDone }: { file: PersonalFileView; target: PersonalFileDeleteTarget; onClose(): void; onDone(next: PersonalFileView | undefined): void }) {
  const { http } = useStore();
  const toast = useToast();
  const [mode, setMode] = useState<PersonalFileDeleteMode>("forget");
  const [withSources, setWithSources] = useState(false);
  const [busy, setBusy] = useState(false);
  const sources = deletableSources(file, target);
  const title =
    target.kind === "person"
      ? t("pages.personalFiles.deletePersonTitle", { name: personalFileName(file) })
      : target.kind === "field"
        ? t("pages.personalFiles.deleteFieldTitle", { label: file.fields.find((f) => f.field === target.field)?.label ?? target.field })
        : t("pages.personalFiles.deleteNoteTitle");
  const run = () => {
    setBusy(true);
    http
      .deletePersonalFile(file.id, { target, mode, ...(mode === "purge" && withSources ? { withSources: true } : {}) })
      .then(
        (result) => onDone(result.file),
        (err: unknown) => toast(t("pages.personalFiles.failed", { reason: errorText(err) })),
      )
      .finally(() => setBusy(false));
  };
  return (
    <Sheet title={title} onClose={onClose} center>
      <div className="modal-body pf-delete">
        {(["forget", "purge"] as const).map((m) => (
          <label key={m} className="check-row radio-row">
            <input type="radio" name="pf-delete-mode" checked={mode === m} onChange={() => setMode(m)} />
            <span>
              <b>{t(`pages.personalFiles.mode.${m}`)}</b>
              {m === "forget" && <span className="muted">{t("pages.personalFiles.modeDefault")}</span>}
              <div className="muted">
                <NamedText text={t(`pages.personalFiles.modeNote.${m}`, { name: ASSISTANT_NAME_MARK })} />
              </div>
            </span>
          </label>
        ))}
        {mode === "purge" && sources > 0 && (
          <label className="check-row">
            <input type="checkbox" checked={withSources} onChange={(e) => setWithSources(e.currentTarget.checked)} />
            <span>
              {t("pages.personalFiles.withSources", { count: sources })}
              <div className="muted">{t("pages.personalFiles.withSourcesNote")}</div>
            </span>
          </label>
        )}
      </div>
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          {t("pages.personalFiles.cancel")}
        </button>
        <button type="button" className={`btn ${mode === "purge" ? "danger" : "primary"}`} disabled={busy} onClick={run}>
          {t(`pages.personalFiles.confirm.${mode}`)}
        </button>
      </div>
    </Sheet>
  );
}
