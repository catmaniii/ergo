// 到点的提醒这类"马上告诉用户"的通知（前端状态层的 alerts，来自临时的 notify 事件）：
// - 在任意页面顶上给出页面内提示，可以去待我处理看那一项，或者关掉提示；
// - 用户允许浏览器通知时，另外弹一条浏览器通知（同一件事几个窗口里只弹一条：tag 用通知的 id）；
//   不允许或浏览器不支持时，只有页面内提示和待我处理里的置顶事项。
// 另外，被守护进程拒绝的请求（比如卡着任务的事项不能删）在页面底部的短提示里说明原因（FailureToasts）。
// 通知是守护进程写的：里面的名字占位（43 号票）在页面内提示里显示成名字标签，浏览器通知里换成名字本身。
import { useEffect, useState } from "react";
import { useStore } from "../app/store.tsx";
import type { NotifyEventPayload } from "../state/index.ts";
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

/** 页面内提示：一条一条叠在应用框顶上，直到用户看或者关掉 */
export function AlertsView({ onOpen }: { onOpen(itemId: string): void }) {
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
  if (ui.alerts.length === 0) return null;
  return (
    <div className="alert-stack" role="alert">
      {ui.alerts.map((alert) => (
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
          </span>
          {alert.itemId && (
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                onOpen(alert.itemId!);
                seeAlert(alert.id);
              }}
            >
              查看
            </button>
          )}
          <button type="button" className="btn ghost" onClick={() => seeAlert(alert.id)}>
            关闭
          </button>
        </div>
      ))}
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
