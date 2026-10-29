// 我的名字（249 号票）：用户**自己**的名字，存在守护进程（打开的页面时经 GET /api/user-name 现取，设置里改用 PUT；不走事件），
// 和"个人助理的名字"（43 号票，state/assistant-name.ts）是两回事：那个是用户给秘书起的、界面上处处用它；这个是用户自己的，
// agent 的系统提示里知道该称呼用户什么，界面上能用则用（秘书页的副标题、待办页的副标题、设置 · 身份那一项）。
// **没设就完全保持现状**：这几个地方一个字都不多，还是原来的样子。
import { t } from "./protocol.ts";
import type { UiState } from "./ui-state.ts";

/** 现在的名字（用户自己的）；没设（或者只有空白）是 undefined */
export function userNameOf(state: UiState): string | undefined {
  const name = state.userName;
  return name === undefined || name.trim() === "" ? undefined : name;
}

/**
 * 秘书页标题栏的副标题：设了名字是"<名字>的主线会话"（宽窄屏一样）；没设照旧——宽屏写"主线会话"，窄屏没有副标题
 */
export function secretaryPageSub(state: UiState, wide: boolean): string | undefined {
  const name = userNameOf(state);
  if (name === undefined) return wide ? t("pages.secretary.mainSession") : undefined;
  return t("pages.secretary.mainSessionOf", { name });
}

/** 待办页的副标题：设了名字是"<名字>的待办"；没设没有副标题（照旧） */
export function inboxPageSub(state: UiState): string | undefined {
  const name = userNameOf(state);
  return name === undefined ? undefined : t("pages.inbox.mine", { name });
}
