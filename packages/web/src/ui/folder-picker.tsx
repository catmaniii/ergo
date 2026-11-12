// 选本机文件夹的框（463 号票从授权的文件夹里拆出来）：四处用的是同一个——设置 · 目录授权最上面"添加文件夹"（马上授权）、
// 设置 · 备份"选一个文件夹…"（校验、问要不要新建、写配置）、各 agent 的 ⚙ 里登记目录的"选文件夹…"（填进表单，不马上存）、
// 新建任务 / 项目"用一个已有的文件夹"的"选文件夹…"（填进路径）。选的是二狗那台电脑上的文件夹。
// - FolderPickerSheet：外面那层框加里面，调用方给标题、按钮上的字、要标出来的文件夹（带什么标签）、选中后做什么；挂上就开、拿掉就关。
//   框挂到 body 上：⚙ 在手机上是底部弹层、新建任务也是弹层，套在里面的弹层会被它们的滚动区裁掉；
// - FolderPickerBody：框里面——最上面一排常用位置和各个盘，下面当前文件夹里的子文件夹（点了进去）和"上一级"，
//   底部当前路径和"用这个文件夹"，再下面贴完整路径按"用这个路径"；调用方要标出来的带小标签，标成 done 的（已授权）底部按钮灰掉。
// 状态和动作在 app/folder-picker.ts，说法在 state/folder-picker.ts。
import { type ReactNode, useEffect, useMemo, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { FolderPicker, type FolderPickerState } from "../app/folder-picker.ts";
import { useStore } from "../app/store.tsx";
import { type FolderMark, folderListNote, folderMarksAt, t } from "../state/index.ts";
import { Sheet } from "./common.tsx";

/** 按钮上的字：当前文件夹的、选中后在做时的、贴的路径的 */
export interface FolderPickerLabels {
  here: string;
  busy: string;
  paste: string;
}

const defaultLabels = (): FolderPickerLabels => ({ here: t("ui.folderPicker.here"), busy: t("ui.folderPicker.busy"), paste: t("ui.folderPicker.paste") });

/** 一个文件夹的小标签（done 的不在这里画，按钮上写） */
function Tags({ marks }: { marks: readonly FolderMark[] }) {
  return (
    <>
      {marks.map((m) => (
        <span key={m.label} className="af-tag">
          {m.label}
        </span>
      ))}
    </>
  );
}

export interface FolderPickerBodyProps {
  picker: FolderPickerState;
  /** 要标出来的文件夹 */
  marks?: readonly FolderMark[] | undefined;
  /** 不给的用"用这个文件夹""用这个路径" */
  labels?: Partial<FolderPickerLabels> | undefined;
  onBrowse(path: string): void;
  onUp(): void;
  onChoose(path: string): void;
  onDraft(text: string): void;
  onChooseDraft(): void;
}

/** 选文件夹的框里面：常用位置和各个盘、子文件夹、当前路径和"用这个文件夹"、贴完整路径 */
export function FolderPickerBody({ picker, marks, labels, onBrowse, onUp, onChoose, onDraft, onChooseDraft }: FolderPickerBodyProps) {
  const { roots, current, loading, busy } = picker;
  const words = { ...defaultLabels(), ...labels };
  const marksAt = (path: string) => folderMarksAt(marks, path);
  const here = current?.kind === "folder" ? current.path : undefined;
  const hereMarks = here === undefined ? [] : marksAt(here);
  const hereDone = hereMarks.find((m) => m.done);
  const note = current?.kind === "folder" ? folderListNote(current) : undefined;
  return (
    <div className="af-picker">
      <div className="af-places" role="group" aria-label={t("ui.folderPicker.places")}>
        {roots === undefined && <span className="muted">{loading ? t("ui.folderPicker.listing") : t("ui.folderPicker.placesFailed")}</span>}
        {roots?.places.map((p) => (
          <button key={p.path} type="button" className={current?.path === p.path ? "af-place on" : "af-place"} title={p.path} onClick={() => onBrowse(p.path)}>
            {p.name}
            <Tags marks={marksAt(p.path)} />
          </button>
        ))}
        {roots?.drives.map((d) => (
          <button key={d.path} type="button" className={current?.path === d.path ? "af-place af-drive on" : "af-place af-drive"} onClick={() => onBrowse(d.path)}>
            {d.name}
            <Tags marks={marksAt(d.path)} />
          </button>
        ))}
      </div>
      <div className="af-nav">
        <button type="button" className="btn af-up" disabled={current === undefined || loading} onClick={onUp}>
          {t("ui.folderPicker.up")}
        </button>
        {loading && <span className="muted">{t("ui.folderPicker.listing")}</span>}
      </div>
      {current === undefined && <div className="muted af-empty">{t("ui.folderPicker.start")}</div>}
      {current?.kind === "unreadable" && <div className="sys-note">{t("ui.folderPicker.unreadable", { path: current.path, reason: current.reason })}</div>}
      {current?.kind === "folder" && current.folders.length > 0 && (
        <ul className="af-entries">
          {current.folders.map((f) => (
            <li key={f.path}>
              <button type="button" className="af-entry" onClick={() => onBrowse(f.path)}>
                <span className="af-entry-name">{f.name}</span>
                <Tags marks={marksAt(f.path)} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {note && <div className="hint">{note}</div>}
      {here !== undefined && (
        <div className="af-here">
          <span className="af-path">
            <span className="muted">{t("ui.folderPicker.current")}</span>
            {here}
            {hereMarks.some((m) => !m.done) && (
              <span className="fp-here-tags">
                <Tags marks={hereMarks.filter((m) => !m.done)} />
              </span>
            )}
          </span>
          <button type="button" className="btn primary" disabled={busy || hereDone !== undefined} onClick={() => onChoose(here)}>
            {hereDone ? hereDone.label : busy ? words.busy : words.here}
          </button>
        </div>
      )}
      <div className="af-paste">
        <input
          className="input"
          value={picker.draft}
          spellCheck={false}
          placeholder={t("ui.folderPicker.pastePlaceholder")}
          aria-label={t("ui.folderPicker.pathLabel")}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onChooseDraft();
          }}
        />
        <button type="button" className="btn" disabled={busy || picker.draft.trim() === ""} onClick={onChooseDraft}>
          {words.paste}
        </button>
      </div>
      {picker.error && <div className="sys-note">{picker.error}</div>}
    </div>
  );
}

export interface FolderPickerSheetProps {
  /** 框的标题 */
  title: string;
  /** 框最上面的一句说明（可不给） */
  intro?: ReactNode;
  /** 按钮上的字，不给的用"用这个文件夹""用这个路径" */
  labels?: Partial<FolderPickerLabels> | undefined;
  /** 要标出来的文件夹 */
  marks?: readonly FolderMark[] | undefined;
  /** 选中一个文件夹以后做什么：做完了框关掉（再调 onClose）；抛错的框不关，message 写在框里 */
  onChoose(path: string): Promise<void> | void;
  /** 关掉框（点叉、点外面、选好了） */
  onClose(): void;
}

/** 选文件夹的框：挂上就开（先列常用位置和各个盘），拿掉就关（之后才回来的结果不再打开它） */
export function FolderPickerSheet({ title, intro, labels, marks, onChoose, onClose }: FolderPickerSheetProps) {
  const { http } = useStore();
  const picker = useMemo(() => new FolderPicker(http), [http]);
  const state = useSyncExternalStore(picker.subscribe, picker.state, picker.state);
  useEffect(() => {
    void picker.open();
    return () => picker.close();
  }, [picker]);
  if (!state) return null;
  // 选中的交给调用方，做完了再让调用方把框拿掉
  const deliver = async (path: string) => {
    await onChoose(path);
    onClose();
  };
  return createPortal(
    <Sheet title={title} onClose={onClose} center>
      {intro !== undefined && <div className="muted fp-intro">{intro}</div>}
      <FolderPickerBody
        picker={state}
        marks={marks}
        labels={labels}
        onBrowse={(path) => void picker.browse(path)}
        onUp={() => void picker.up()}
        onChoose={(path) => void picker.choose(path, deliver)}
        onDraft={(text) => picker.setDraft(text)}
        onChooseDraft={() => void picker.chooseDraft(deliver)}
      />
    </Sheet>,
    document.body,
  );
}

/** 输入框旁边的"选文件夹…"：点了开选文件夹的框 */
export function FolderPickButton({ disabled, onClick }: { disabled?: boolean | undefined; onClick(): void }) {
  return (
    <button type="button" className="btn fp-open" disabled={disabled} onClick={onClick}>
      {t("ui.folderPicker.open")}
    </button>
  );
}
