// 到点的提醒这类"马上告诉用户"的通知（前端状态层的 alerts，来自临时的 notify 事件；109 号票起还有界面自己出的秘书新消息，
// "查看"去秘书会话里那一条，见 state/secretary-unread.ts）：
// - 在任意页面顶上给出页面内提示，可以去待我处理看那一项，或者关掉提示；105 号票起不再一条条叠着等用户关，
//   106 号票起只有一个大小固定的框（标题、正文各一行，放不下省略），几条在框里轮播、标"第几条 / 共几条"；
//   每条都露过、总共露够 8 秒后自动收起（连同框里的全部），手指、鼠标停在上面时不换不收
//   （什么时候换、什么时候收由状态层 state/alerts.ts 算）。收起只是不在顶上显示，待办里那一项和红点照旧；
// - 另外发一条系统通知（110 号票起统一从 app/page-notify.ts 的 pageNotifier() 出去：鸿蒙 App 里发到系统通知栏，
//   浏览器里用户允许了才弹浏览器通知；同一件事只发一条）。点了通知去待办里那一项（秘书新消息去秘书会话里那一条，109 号票），
//   顶上的框把这一条收起；
//   不允许或浏览器不支持时，只有页面内提示和待我处理里的置顶事项。
// 另外，被守护进程拒绝的请求（比如卡着任务的事项不能删）在页面底部的短提示里说明原因（FailureToasts）。
// 通知是守护进程写的：里面的名字占位（43 号票）在页面内提示里显示成名字标签，系统通知里换成名字本身。
import { useCallback, useEffect, useRef, useState } from "react";
import { appNotifies, pageNotifier } from "../app/page-notify.ts";
import { useStore } from "../app/store.tsx";
import { alertNotice } from "../app/system-notify.ts";
import { ALERT_CAROUSEL_IDLE, alertCarousel, alertCountText, alertNotifiesSystem, alertShown, alertsChanged, alertWait, t } from "../state/index.ts";
import { NamedText, useNamedPlain } from "./assistant-name.tsx";
import { Icon } from "./icons.tsx";
import { useToast } from "./toast.tsx";

/** 轮播的钟（毫秒） */
const now = () => performance.now();

function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/**
 * 页面内提示（105、106 号票）：应用框顶上只有一个框，几条在框里轮播（换的时候往上滚过去，系统设了减少动效时直接换），
 * 框上标"2/3"；手指、鼠标或键盘焦点停在上面时不换不收。"查看"去框里此刻这一条的待办（没有对应的事项去待办列表）；
 * 秘书新消息（109 号票）去秘书会话里那一条（onSecretary，定位并闪一下）。
 * "查看""关闭"、自动收起都是整个收起（框里的几条都在待办里；秘书的在秘书会话里，"秘书"页签亮着红点）
 */
export function AlertsView({ onOpen, onInbox, onSecretary }: { onOpen(itemId: string): void; onInbox(): void; onSecretary(at: string): void }) {
  const { ui, seeAlert } = useStore();
  const plain = useNamedPlain();
  // 系统通知（110 号票）：每条发一次；点了通知（浏览器通知、App 通知栏里的）出口去那一项的地址，这里把这一条从顶上收起
  useEffect(() => {
    // "<名字>有 N 条新消息"（109 号票）只在顶上框里出：切回、刷新页面时才生成，那几轮在后台时已经各发过一条
    for (const alert of ui.alerts) if (alertNotifiesSystem(alert)) pageNotifier().show(alertNotice(alert, plain));
  }, [ui.alerts, plain]);
  useEffect(() => pageNotifier().onOpen(seeAlert), [seeAlert]);

  const [carousel, setCarousel] = useState(ALERT_CAROUSEL_IDLE);
  // 顶上的几条变了（新来的排进去、拿掉的换下一条）
  if (alertsChanged(carousel, ui.alerts)) setCarousel(alertCarousel(carousel, { kind: "alerts", ids: ui.alerts.map((a) => a.id), at: now() }));
  // 收起的是那一刻顶上的全部
  const alertsRef = useRef(ui.alerts);
  useEffect(() => {
    alertsRef.current = ui.alerts;
  });
  const collapse = useCallback(() => {
    for (const alert of alertsRef.current) seeAlert(alert.id);
  }, [seeAlert]);
  // 到点换下一条或收起：轮播每变一次（送了 due 也是新的一份）就重新定时，到点却没动时也会再定一次、不会卡在一条上
  useEffect(() => {
    const wait = alertWait(carousel);
    if (wait === undefined) return;
    const dueAt = carousel.since! + wait;
    // 定时器可能比 dueAt 早零点几毫秒到：按到点那一刻算
    const id = window.setTimeout(() => setCarousel((c) => alertCarousel(c, { kind: "due", at: Math.max(now(), dueAt) })), Math.ceil(dueAt - now()));
    return () => window.clearTimeout(id);
  }, [carousel]);
  useEffect(() => {
    if (carousel.hidden) collapse();
  }, [carousel.hidden, collapse]);

  const shown = alertShown(carousel, ui.alerts);
  if (!shown) return null;
  const { alert, index, total } = shown;
  const count = alertCountText(index, total);
  const hold = () => setCarousel((c) => alertCarousel(c, { kind: "hold", at: now() }));
  const release = () => setCarousel((c) => alertCarousel(c, { kind: "release", at: now() }));
  return (
    <div
      className="alert-stack"
      role="alert"
      onPointerEnter={hold}
      onPointerLeave={release}
      onFocus={hold}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) release();
      }}
    >
      <div className="alert-banner">
        <span className="alert-mark">
          <span className="alert-icon">
            <Icon name="bell" />
          </span>
          {count && <span className="alert-count">{count}</span>}
        </span>
        {/* 轮播的窗口：换一条时这一条从下面滚上来（key 跟着这一条） */}
        <span className="alert-text" title={plain(alert.body ? `${alert.title} ${alert.body}` : alert.title)}>
          <span key={alert.id} className="alert-slide">
            <b className="alert-title">
              <NamedText text={alert.title} />
            </b>
            {alert.body && (
              <span className="alert-body muted">
                <NamedText text={alert.body} />
              </span>
            )}
          </span>
        </span>
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            if (alert.secretary) onSecretary(alert.secretary.at);
            else if (alert.itemId) onOpen(alert.itemId);
            else onInbox();
            collapse();
          }}
        >
          {t("ui.alerts.view")}
        </button>
        <button type="button" className="btn ghost" onClick={collapse}>
          {t("common.close")}
        </button>
      </div>
    </div>
  );
}

/**
 * 浏览器通知还没问过用户时，给一个开通知的按钮（要用户自己点，浏览器才肯弹授权框）。
 * 在鸿蒙 App 里（新版 App）提醒走 App 的通知栏，授权由 App 问（110 号票），不出这个按钮
 */
export function NotificationPermission() {
  const [permission, setPermission] = useState(() => (notificationsSupported() ? Notification.permission : "unsupported"));
  if (permission !== "default" || appNotifies()) return null;
  return (
    <div className="hint notify-permission">
      {t("ui.alerts.askNotify")}
      <button
        type="button"
        className="link"
        onClick={() => {
          void Notification.requestPermission().then(setPermission);
        }}
      >
        {t("ui.alerts.allowNotify")}
      </button>
    </div>
  );
}

/** 被拒的请求：在页面底部的短提示里说明原因 */
export function FailureToasts() {
  const { ui, seeFailure } = useStore();
  const toast = useToast();
  useEffect(() => {
    for (const failure of ui.failures) {
      toast(t("ui.alerts.failed", { error: failure.error }));
      seeFailure(failure.idempotencyKey);
    }
  }, [ui.failures, toast, seeFailure]);
  return null;
}
