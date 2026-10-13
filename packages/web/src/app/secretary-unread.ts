// 秘书来了新消息要让用户知道（109 号票）在页面上的那一半：页面在不在前台、播放器放过了哪些语音、什么时候报已读位置、
// 什么时候在顶上提醒——该不该、提醒什么、小栏里有哪几段都由状态层的纯函数算（state/secretary-unread.ts）。
// - useSecretaryAlerts（主框架里一份）：秘书说完的每一轮问 secretaryTurnAlert（语音还在合成的先等着）；打开、切回前台、重连上
//   （补发推完了、页面在前台）时问 secretaryUnreadAlert。出的提醒进 ui.alerts，和到点的提醒同一个框、同一个浏览器通知的出口
//   （ui/alerts.tsx）。另外盯着播放器：放过的 agent 语音记下（不在时念的语音小栏不再算它们）。
// - useSecretaryReading（秘书页上）：会话组件报"看到哪个序号了"，页面在前台、补发推完了才算看过——先在这台设备上记上
//   （红点马上消失），过一小会儿报给守护进程（几台设备同步）；每次打开（挂上、切回前台、补发推完了）先把没看过、没放过的语音
//   收进小栏，再报看到了哪（不然一打开停在最底部就全算看过了，小栏就没了）。
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  agentVoicePlayback,
  CHANNELS,
  missedVoiceBar,
  type MissedVoiceBar,
  missedVoicesAfterHeard,
  missedVoicesOnOpen,
  playbackSource,
  secretaryTurnAlert,
  secretaryUnreadAlert,
  type UiState,
} from "../state/index.ts";
import { agentVoiceUrls, pageVoicePlayer, toggleVoice, unlockVoicePlayback } from "./page-voice.ts";
import { useStore } from "./store.tsx";

const SECRETARY = CHANNELS.secretary;

/** 看到哪了先在这台设备上记上，过这么久（毫秒）再报给守护进程：一路往下滚时不用每一下都报 */
const MARK_READ_DELAY_MS = 800;

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

/** 页面在不在前台（浏览器标签页在前面、App 没切到后台），切走、切回来时跟着变 */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible");
}

/** 这台设备上放过的 agent 语音（点了气泡、点了小栏的播放、自动播了）；变了通知小栏 */
const heard = new Set<string>();
const heardListeners = new Set<() => void>();
let heardVersion = 0;

function noteHeard(ids: readonly string[]): void {
  const fresh = ids.filter((id) => !heard.has(id));
  if (fresh.length === 0) return;
  for (const id of fresh) heard.add(id);
  heardVersion += 1;
  for (const l of heardListeners) l();
}

function useHeardVersion(): number {
  return useSyncExternalStore(
    (l) => {
      heardListeners.add(l);
      return () => heardListeners.delete(l);
    },
    () => heardVersion,
  );
}

/** 秘书会话里的 agent 语音 */
const secretaryVoiceIds = (ui: UiState) => Object.values(ui.agentVoices).flatMap((v) => (v.conversation === SECRETARY ? [v.id] : []));

/** 主框架里一份：秘书说完一轮、打开时有没看过的，在顶上提醒；记下放过的语音。在秘书页、页面在前台算正在看秘书会话 */
export function useSecretaryAlerts(onSecretaryPage: boolean): void {
  const { ui, showAlert, seeSecretaryTurn } = useStore();
  const visible = usePageVisible();
  const viewing = onSecretaryPage && visible;
  const uiRef = useRef(ui);
  useEffect(() => {
    uiRef.current = ui;
  });

  // 秘书说完的每一轮：提醒一条、先等着（语音还在合成），或者不提醒；决定过了去掉
  useEffect(() => {
    for (const since of ui.secretaryTurns) {
      const decision = secretaryTurnAlert(ui, since, { viewing });
      if (decision === "wait") continue;
      if (decision) showAlert(decision);
      seeSecretaryTurn(since);
    }
  }, [ui, viewing, showAlert, seeSecretaryTurn]);

  // 打开、切回前台、重连上：补发推完了、页面在前台的那一刻看一眼有没有没看过的
  const opened = ui.caughtUp && visible;
  const wasOpened = useRef(false);
  useEffect(() => {
    if (opened && !wasOpened.current) {
      const alert = secretaryUnreadAlert(uiRef.current, { viewing });
      if (alert) showAlert(alert);
    }
    wasOpened.current = opened;
  }, [opened, viewing, showAlert]);

  // 放过的语音：播放器一变就看秘书会话里哪条在播
  useEffect(() => {
    const player = pageVoicePlayer();
    return player.subscribe(() => noteHeard(secretaryVoiceIds(uiRef.current).filter((id) => player.isPlaying(id))));
  }, []);
}

/** 秘书页上的已读位置和不在时念的语音小栏 */
export interface SecretaryReading {
  /** 会话组件报的：对话层看到了哪个序号（停在最底部是最后一个） */
  onSeen(seq: number): void;
  /** 不在时念的语音小栏；没有是 undefined */
  bar: MissedVoiceBar | undefined;
  /** 点"▶ 播放"：从第一段开始放，几段接着放；小栏随之收起 */
  play(): void;
}

export function useSecretaryReading(): SecretaryReading {
  const { ui, http, seeRead, markRead } = useStore();
  const visible = usePageVisible();
  const active = visible && ui.caughtUp;
  const [missed, setMissed] = useState<readonly string[]>([]);
  const uiRef = useRef(ui);
  const missedRef = useRef(missed);
  const activeRef = useRef(false);
  /** 刚打开（挂上、切回前台、补发推完了）：报看到哪之前先把不在时念的语音收进小栏 */
  const opening = useRef(false);
  // 布局阶段就记下：会话组件报看到哪（在这之后）时已经知道是不是刚打开
  useLayoutEffect(() => {
    uiRef.current = ui;
    missedRef.current = missed;
    if (active && !activeRef.current) opening.current = true;
    activeRef.current = active;
  });

  // 报给守护进程：看到哪了先在这台设备上记上，过一小会儿再报（离开、切到后台时马上报掉）
  const seen = useRef<number | undefined>(undefined);
  const sent = useRef(-1);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const send = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
    const seq = seen.current;
    if (seq === undefined || seq <= sent.current) return;
    sent.current = seq;
    markRead(SECRETARY, seq);
  }, [markRead]);
  const flush = useCallback(() => {
    if (!activeRef.current) return;
    if (opening.current) {
      opening.current = false;
      const next = missedVoicesOnOpen(uiRef.current, missedRef.current, heard);
      if (next !== missedRef.current) {
        missedRef.current = next;
        setMissed(next);
      }
    }
    const seq = seen.current;
    if (seq === undefined || seq <= (uiRef.current.readMarks[SECRETARY] ?? -1)) return;
    seeRead(SECRETARY, seq);
    if (timer.current === undefined) timer.current = setTimeout(send, MARK_READ_DELAY_MS);
  }, [seeRead, send]);
  const onSeen = useCallback(
    (seq: number) => {
      seen.current = Math.max(seen.current ?? 0, seq);
      flush();
    },
    [flush],
  );
  useEffect(() => {
    if (active) flush();
    else send();
  }, [active, flush, send]);
  // 离开秘书页：没报的马上报掉
  useEffect(() => send, [send]);

  // 放过了的（点了气泡、自动播了）不再算：放过的一变就重画
  useHeardVersion();
  const unheard = missedVoicesAfterHeard(missed, heard);
  const bar = unheard.length > 0 ? missedVoiceBar(ui, unheard) : undefined;
  const play = useCallback(() => {
    const voices = (bar?.voiceIds ?? []).flatMap((id) => {
      const voice = uiRef.current.agentVoices[id];
      const source = voice && playbackSource(agentVoicePlayback(voice, agentVoiceUrls(http)));
      return source === undefined ? [] : [{ id, source }];
    });
    setMissed([]);
    const [first, ...rest] = voices;
    if (!first) return;
    // 用户点的：先让播放器出一次声（手机浏览器要手势），第一段马上放，后面的排在它后面接着放
    unlockVoicePlayback();
    toggleVoice(first.id, first.source);
    for (const v of rest) pageVoicePlayer().autoplay(v.id, v.source);
  }, [bar, http]);
  return { onSeen, bar, play };
}
