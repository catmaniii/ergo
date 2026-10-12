// 到点的提醒这类"马上告诉用户"的通知（前端状态层的 alerts，来自临时的 notify 事件）：
// - 在任意页面顶上给出页面内提示，可以去待我处理看那一项，或者关掉提示；105 号票起不再一条条叠着等用户关：
//   只露最新一条，其余的说"还有 N 条，在待办里"；露出来 8 秒自动收起（连同压在后面的），手指、鼠标停在上面时不收
//   （什么时候收由状态层 state/alerts.ts 算）。收起只是不在顶上显示，待办里那一项和红点照旧；
// - 用户允许浏览器通知时，另外弹一条浏览器通知（同一件事几个窗口里只弹一条：tag 用通知的 id）；
//   不允许或浏览器不支持时，只有页面内提示和待我处理里的置顶事项。
// 另外，被守护进程拒绝的请求（比如卡着任务的事项不能删）在页面底部的短提示里说明原因（FailureToasts）。
// 通知是守护进程写的：里面的名字占位（43 号票）在页面内提示里显示成名字标签，浏览器通知里换成名字本身。
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../app/store.tsx";
import { ALERT_AUTO_HIDE_MS, ALERT_TIMER_IDLE, alertBanner, alertCounting, alertMoreText, alertTimer, type NotifyEventPayload } from "../state/index.ts";
import { NamedText, useNamedPlain } from "./assistant-name.tsx";
import { useToast } from "./toast.tsx";

/** 已经弹过浏览器通知的（同一页面里重渲染不再弹） */
const notified = new Set<string>();

function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

function showBrowserNotification(alert: NotifyEventPayload, plain: (text: string) => string, onClick: () => void): void {
  if (!notificationsSupported() || Notification.permission !== "granted" || notified.has(alert.id)) return;
  notified.add(alert.id);
  try {
    const n = new Notification(plain(alert.title), { body: plain(alert.body ?? ""), tag: alert.id });
    n.addEventListener("click", () => {
      window.focus();
      onClick();
      n.close();
    });
  } catch {
    // 有的浏览器（比如手机上）只允许在 Service Worker 里发通知：那就只有页面内提示
  }
}

/**
 * 页面内提示（105 号票）：应用框顶上只露最新一条，压在后面的说一句"还有 N 条，在待办里"（点了去待办）；
 * 露出来过一会儿自动收起，手指、鼠标或键盘焦点停在上面时不收。"查看""关闭"、自动收起都是整个收起（压在后面的也在待办里）
 */
export function AlertsView({ onOpen, onInbox }: { onOpen(itemId: string): void; onInbox(): void }) {
  const { ui, seeAlert } = useStore();
  const plain = useNamedPlain();
  useEffect(() => {
    for (const alert of ui.alerts) {
      showBrowserNotification(alert, plain, () => {
        if (alert.itemId) onOpen(alert.itemId);
        seeAlert(alert.id);
      });
    }
  }, [ui.alerts, onOpen, seeAlert, plain]);

  const banner = alertBanner(ui.alerts);
  const shownId = banner?.latest.id;
  const [timer, setTimer] = useState(ALERT_TIMER_IDLE);
  // 露着的换了一条（新来的）：从头数
  if (timer.shownId !== shownId) setTimer(alertTimer(timer, { kind: "shown", id: shownId }));
  // 收起的是数到那一刻顶上的全部（压在后面的也收）
  const alertsRef = useRef(ui.alerts);
  useEffect(() => {
    alertsRef.current = ui.alerts;
  });
  const collapse = useCallback(() => {
    for (const alert of alertsRef.current) seeAlert(alert.id);
  }, [seeAlert]);
  // 在数的这一轮（不在数是 undefined）：轮次一变就从头数
  const countdown = alertCounting(timer) ? timer.round : undefined;
  useEffect(() => {
    if (countdown === undefined) return;
    const id = window.setTimeout(collapse, ALERT_AUTO_HIDE_MS);
    return () => window.clearTimeout(id);
  }, [countdown, collapse]);

  if (!banner) return null;
  const { latest: alert, more } = banner;
  const moreText = alertMoreText(more);
  const hold = () => setTimer((t) => alertTimer(t, { kind: "hold" }));
  const release = () => setTimer((t) => alertTimer(t, { kind: "release" }));
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
      <div key={alert.id} className="alert-banner">
        <span className="alert-icon" aria-hidden="true">
          🔔
        </span>
        <span className="alert-text">
          <b>
            <NamedText text={alert.title} />
          </b>
          {alert.body && (
            <span className="muted">
              {" "}
              <NamedText text={alert.body} />
            </span>
          )}
          {moreText && (
            <button
              type="button"
              className="link alert-more"
              onClick={() => {
                onInbox();
                collapse();
              }}
            >
              {moreText} ›
            </button>
          )}
        </span>
        {alert.itemId && (
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              onOpen(alert.itemId!);
              collapse();
            }}
          >
            查看
          </button>
        )}
        <button type="button" className="btn ghost" onClick={collapse}>
          关闭
        </button>
      </div>
    </div>
  );
}

/** 浏览器通知还没问过用户时，给一个开通知的按钮（要用户自己点，浏览器才肯弹授权框） */
export function NotificationPermission() {
  const [permission, setPermission] = useState(() => (notificationsSupported() ? Notification.permission : "unsupported"));
  if (permission !== "default") return null;
  return (
    <div className="hint notify-permission">
      到点的提醒要不要同时弹浏览器通知？
      <button
        type="button"
        className="link"
        onClick={() => {
          void Notification.requestPermission().then(setPermission);
        }}
      >
        允许浏览器通知
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
      toast(`没做成：${failure.error}`);
      seeFailure(failure.idempotencyKey);
    }
  }, [ui.failures, toast, seeFailure]);
  return null;
}
