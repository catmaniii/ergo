// 设置 · 浏览与填框里"agent 联网搜索、读网页"一节（154 号票；162 号票改成三种方式的队列，用户 2026-10-18 定）：
// - 三个标签排成一列：DeepSeek 付费搜索、二狗自带的浏览器搜索、agent-browser，每个写名字、一句话特点（161 号票报告）、排第几，最右边是启用开关
//   （单独的开关，点文字不会误切）；
// - 调顺序：每一项开关左边有上移、下移按钮（手机上拖不顺手）；电脑上（鼠标这类精确的指针）还能按住左边的把手拖到别的位置；
// - 不能全停：剩最后一个启用的，它的开关点不了，下面写明原因；没配 DeepSeek 的 key 时那一项写明、关着、点不了；
// - DeepSeek 回过余额不足时写明哪会儿、这期间按顺序换了后面的；下面一行现在实际的顺序、key 配没配、agent-browser 和 Tavily 的说明。
// 存在守护进程（所有设备一样）：打开时取一次（GET /api/web-settings），每改一处就整份存回去。说法和纯函数在状态层（state/web-settings.ts）。
// 182 号票：四张标签（多"鸿蒙 App 的内置浏览器"），每张名字下面一行写用的英文工具名（等宽；DeepSeek 和浏览器用同一对 web_search、
// web_fetch，engine 写成小一号的等宽字区分开），手机上一行放不下就折行。
import { type DragEvent, useEffect, useState } from "react";
import { useStore } from "../../app/store.tsx";
import {
  apiKeyText,
  webQueueIntro,
  webSettingsFileBrokenNote,
  webToolsHint,
  webBalanceText,
  webQueueRows,
  webQueueSummary,
  type WebSettingsBody,
  type WebSettingsView,
  type WebToolPart,
  t,
  withWebMethodEnabled,
  withWebMethodMoved,
} from "../../state/index.ts";
import { NamedText } from "../../ui/assistant-name.tsx";
import { Section } from "../../ui/common.tsx";
import { Icon } from "../../ui/icons.tsx";
import { useToast } from "../../ui/toast.tsx";

/** 能拖：鼠标这类精确、能悬停的指针（手机、平板上只用上移下移按钮，免得长按、滚动时误拖） */
const canDrag = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;

export function WebToolsSetting() {
  const { http } = useStore();
  const toast = useToast();
  const [view, setView] = useState<WebSettingsView>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  /** 正在拖的是第几项、拖到了第几项上面 */
  const [drag, setDrag] = useState<{ from: number; over: number }>();
  const [draggable] = useState(canDrag);

  useEffect(() => {
    let live = true;
    http.webSettings().then(
      (v) => {
        if (!live) return;
        setView(v);
        setError(undefined);
      },
      (err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      live = false;
    };
  }, [http]);

  const title = t("pages.webTools.title");
  if (!view) {
    return (
      <Section title={title}>
        <span className="muted">{error ? t("pages.webTools.loadFailed", { reason: error }) : t("pages.webTools.loading")}</span>
      </Section>
    );
  }

  const save = (body: WebSettingsBody) => {
    setSaving(true);
    http
      .saveWebSettings(body)
      .then(
        (v) => {
          setView(v);
          toast(t("pages.webTools.saved"));
        },
        (err: unknown) => toast(t("pages.webTools.saveFailed", { reason: err instanceof Error ? err.message : String(err) })),
      )
      .finally(() => setSaving(false));
  };
  const move = (from: number, to: number) => {
    if (from !== to) save(withWebMethodMoved(view, from, to));
  };
  const rows = webQueueRows(view);
  const balance = webBalanceText(view);
  const key = apiKeyText(view.deepseekKey);

  /** 拖动（电脑上）：拖起记下第几项，经过时标出放下的位置，放下时挪过去 */
  const dragProps = (i: number) =>
    draggable && !saving
      ? {
          draggable: true,
          onDragStart: (e: DragEvent) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", String(i));
            setDrag({ from: i, over: i });
          },
          onDragOver: (e: DragEvent) => {
            if (!drag) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (drag.over !== i) setDrag({ ...drag, over: i });
          },
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            if (drag) move(drag.from, i);
            setDrag(undefined);
          },
          onDragEnd: () => setDrag(undefined),
        }
      : {};

  return (
    <Section title={title}>
      <span className="muted">
        <NamedText text={webQueueIntro()} />
      </span>
      {view.settingsFileError && (
        <div className="model-file-broken" role="alert">
          <b>{webSettingsFileBrokenNote()}</b>
          <span className="muted">{view.settingsFileError}</span>
        </div>
      )}
      {balance && (
        <div className="web-tools-alert" role="alert">
          {balance}
        </div>
      )}
      <ol className="web-queue" aria-label={t("pages.webTools.order")}>
        {rows.map((row, i) => {
          const classes = ["web-queue-item", row.on ? "" : "off", drag && drag.over === i && drag.from !== i ? (drag.from < i ? "drop-after" : "drop-before") : "", drag?.from === i ? "dragging" : ""];
          return (
            <li key={row.method} className={classes.filter(Boolean).join(" ")} {...dragProps(i)}>
              {draggable && (
                <span className="web-queue-grip" title={t("pages.webTools.drag")}>
                  <Icon name="grip" />
                </span>
              )}
              <span className="web-queue-rank" aria-label={t("pages.webTools.rank", { rank: row.rank })}>
                {row.rank}
              </span>
              <span className="web-queue-text">
                <b>{row.label}</b>
                <WebToolsLine parts={row.tools} />
                <span className="web-queue-trait">{row.trait}</span>
                {row.note && <span className="web-queue-note">{row.note}</span>}
              </span>
              <span className="web-queue-moves">
                <button type="button" className="icon-btn" aria-label={t("pages.webTools.moveUpLabel", { method: row.label })} title={t("pages.webTools.moveUp")} disabled={!row.canUp || saving} onClick={() => move(i, i - 1)}>
                  <Icon name="up" />
                </button>
                <button type="button" className="icon-btn" aria-label={t("pages.webTools.moveDownLabel", { method: row.label })} title={t("pages.webTools.moveDown")} disabled={!row.canDown || saving} onClick={() => move(i, i + 1)}>
                  <Icon name="down" />
                </button>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="web-queue-switch"
                aria-label={t("pages.webTools.enableLabel", { method: row.label })}
                title={row.note ?? (row.on ? t("pages.webTools.onHint") : t("pages.webTools.offHint"))}
                checked={row.on}
                disabled={row.locked || saving}
                onChange={(e) => save(withWebMethodEnabled(view, row.method, e.currentTarget.checked))}
              />
            </li>
          );
        })}
      </ol>
      <div className="web-search-status">
        <b>{webQueueSummary(view)}</b>
      </div>
      <span className="muted">{view.deepseekKey.configured ? t("pages.webTools.keyConfigured") : t("pages.webTools.keyState", { label: key.label, detail: key.detail })}</span>
      <span className="muted">
        <NamedText text={webToolsHint()} />
      </span>
    </Section>
  );
}

/** 标签上用的英文工具名那一行（182 号票）：工具名等宽，engine 小一号的等宽，别的是字 */
function WebToolsLine({ parts }: { parts: readonly WebToolPart[] }) {
  return (
    <span className="web-queue-tools">
      {parts.map((p, i) =>
        p.kind === "text" ? (
          p.text
        ) : (
          <code key={i} className={p.kind === "engine" ? "web-queue-engine" : undefined}>
            {p.text}
          </code>
        ),
      )}
    </span>
  );
}
