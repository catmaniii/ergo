// 废弃分支（151 号票，AbandonedStub、SwapOverlay、measureCol，样子在 zoom.css）：
// - ⑂ 小方块点开，按主线同一套 DOM、同一宽度原尺寸画出整条分支（稍淡，字号定回主线的），上方"⑂ 另一条分支 · N 段 ▾"（点了收起）
//   和"切换到这条分支"；同一分叉点几条横着排（.zd-fork 是一行）。点分支打开它的详情（DetailPane 的 BranchDetail）；
// - 切换的双向动画：先量好当前这一段（从分叉处起）和预览条，切换之后量到真实布局再倒着放——主干那段让到分支原来的位置
//   （背景、下方弧线、末尾淡出），分支那段进主干（前景、上方弧线），约 0.9 秒。量和放在 ZoomHistory（switchBranch、等新布局的 effect）。
// 数据（这条分支自己那一段的条目、N 段、手里不全时去取）在状态层的 abandoned-branch.ts；分支要经 HTTP 取，不是整个会话都在内存里。
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useStore } from "../../app/store.tsx";
import { abandonedBranch, type ChatItem, type ConversationId, t, type ZoomFork } from "../../state/index.ts";

/** 屏幕上的一个位置 */
export interface Rect {
  left: number;
  top: number;
  width: number;
}

interface SwapBar {
  id: string;
  kind: string;
  /** 相对这一段顶部的偏移与高度，都是量出来的真实值 */
  y: number;
  h: number;
}

export interface SwapCol {
  /** 相对 .zh 的位置（屏幕像素） */
  box: { left: number; top: number; width: number; height: number };
  bars: SwapBar[];
}

export interface SwapState {
  /** 当前分支收起去的小节点位置 */
  node: Rect;
  /** 待转正分支此刻在屏幕上的预览位置 */
  from: Rect;
  cur: SwapCol;
  /** 切换完成、量到真实布局之后才有 */
  next?: SwapCol | undefined;
}

/** 一块在主干上的身份：条用它的 id，阶段框用 s:<框> */
export const blockKey = (el: HTMLElement) => el.dataset.chatId ?? `s:${el.dataset.stage}`;

/** 量出某一段历史在屏幕上的真实几何：动画两端都用它，保证和最终画面严丝合缝 */
export function measureCol(items: HTMLElement[], root: DOMRect, prefix: string): SwapCol | undefined {
  if (!items.length) return undefined;
  const first = items[0]!.getBoundingClientRect();
  // 连块间距也一并量下来：整段作为一个整体搬运，不用任何估算的间距
  const bars = items.map((el, i) => {
    const r = el.getBoundingClientRect();
    // 二狗的条除了 k-<内容类型> 还有 ck-<条目种类>：只认 k- 开头的那个类
    return { id: `${prefix}${i}`, kind: el.className.match(/(?:^|\s)k-([a-z]+)/)?.[1] ?? "tool", y: r.top - first.top, h: r.height };
  });
  const last = bars[bars.length - 1]!;
  return {
    box: { left: first.left - root.left, top: first.top - root.top, width: first.width, height: last.y + last.h },
    bars,
  };
}

/** 一段从自己的位置挪到 r、缩放到 r 的宽度要走多少 */
const delta = (c: SwapCol, r: Rect) => ({ x: r.left - c.box.left, y: r.top - c.box.top, k: r.width / Math.max(1, c.box.width) });

/**
 * 转正动画：分叉之后的那一段与右边的分支互换位置。
 * 两条都走完整路程——主干让到分支原来的位置，分支进主干——各走一条弧线：
 * 进来的那条从前景上方绕、略放大，让位的那条从背景下方绕、略缩小并淡出，
 * 这样中途不会叠在一起。
 */
export function SwapOverlay({ swap, on }: { swap: SwapState; on: boolean }) {
  /** 主干那段的终点 = 分支原来占的位置；分支那段的起点也是它，两条正好对穿 */
  const out = delta(swap.cur, swap.from);
  const into = swap.next ? delta(swap.next, swap.from) : undefined;
  // 弧度按横向位移取，位移越大绕得越开；纵向错开保证两条不重叠
  const span = Math.max(Math.abs(out.x), into ? Math.abs(into.x) : 0);
  const bow = Math.max(8, span * 0.06);
  const lift = Math.max(12, span * 0.1);

  const col = (key: string, c: SwapCol, from: { x: number; y: number; k: number }, to: { x: number; y: number; k: number }, kind: "front" | "back") => {
    const dir = kind === "front" ? -1 : 1;
    const style = {
      left: c.box.left,
      top: c.box.top,
      width: c.box.width,
      height: c.box.height,
      "--x0": `${from.x}px`,
      "--y0": `${from.y}px`,
      "--k0": from.k,
      "--x1": `${to.x}px`,
      "--y1": `${to.y}px`,
      "--k1": to.k,
      "--bow": `${dir * bow}px`,
      "--lift": `${dir * lift}px`,
      // 起始帧必须和动画的 0% 完全一致，否则起手会闪一下
      transform: on ? undefined : `translate(${from.x}px, ${from.y}px) scale(${from.k})`,
    } as CSSProperties;
    return (
      <div key={key} className={`zswap-col zs-${kind}${on ? " zs-run" : ""}`} style={style}>
        {c.bars.map((b) => (
          <i key={b.id} className={`bg-${b.kind}`} style={{ top: `${b.y}px`, height: `${b.h}px` }} />
        ))}
      </div>
    );
  };

  return (
    <div className="zswap">
      {col("cur", swap.cur, { x: 0, y: 0, k: 1 }, out, "back")}
      {swap.next && into && col("next", swap.next, into, { x: 0, y: 0, k: 1 }, "front")}
    </div>
  );
}

/** 一条废弃分支挂在分叉处要的：哪个会话、画条目的、打开详情、切过去（只读的会话不给）、展开收起之后重新排两侧标注 */
export interface StubHost {
  conversation: ConversationId;
  /** 按主线一模一样的方式画这一串条目（ZoomHistory 的 ZItem，不带条外的装饰） */
  renderItems(items: readonly ChatItem[]): ReactNode;
  /** 点分支：打开它的详情 */
  onOpen?: ((branchId: string) => void) | undefined;
  /** 点"切换到这条分支"：node 是收起后那个小方块的位置，from 是预览条的位置，item 是挂着它的那一条（主干上的） */
  onSwitch?: ((branchId: string, node: Rect, from: Rect, item: HTMLElement) => void) | undefined;
  onLayout(): void;
}

/** 废弃分支：默认只是一个小点，点开才按真实比例展开 */
export function AbandonedStub({ fork, host }: { fork: ZoomFork; host: StubHost }) {
  const [open, setOpen] = useState(false);
  const { onLayout } = host;
  useLayoutEffect(onLayout, [open, onLayout]);
  if (!open) {
    return (
      <button
        type="button"
        className="zd-ab-dot"
        // 不写"已废弃分支（N 段）"：收着时不推它的条目（分支可能要经 HTTP 取），段数在展开后的标签上
        aria-label={t("ui.branches.abandoned")}
        title={t("ui.branches.abandoned")}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        ⑂
      </button>
    );
  }
  return <AbandonedPanel fork={fork} host={host} onClose={() => setOpen(false)} />;
}

function AbandonedPanel({ fork, host, onClose }: { fork: ZoomFork; host: StubHost; onClose(): void }) {
  const { ui, loadBranch } = useStore();
  const { conversation, onLayout } = host;
  const view = useMemo(() => abandonedBranch(ui, conversation, fork.branchId), [ui, conversation, fork.branchId]);
  // 守护进程那份（和现在的当前分支比的）还没取回：去取（手里的消息可能不全）；取不到就照手里的画，标一句
  const [failed, setFailed] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (view.loaded) return;
    let live = true;
    loadBranch(conversation, fork.branchId).then(
      () => live && setFailed(undefined),
      (err: unknown) => live && setFailed(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      live = false;
    };
  }, [view.loaded, loadBranch, conversation, fork.branchId]);
  // 条目到齐了（取回来了）：底下的条变高了，两侧标注重新避让
  useLayoutEffect(onLayout, [view.items.length, onLayout]);
  return (
    <div className="zd-abandoned" data-branch={fork.branchId}>
      <div className="zd-ab-head">
        <button
          type="button"
          className="zd-ab-label"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          ⑂ {t("ui.branches.otherBranch", { count: view.segments })} ▾
        </button>
        {host.onSwitch && (
          <button
            type="button"
            className="zd-ab-switch"
            // 清空、换模型之前分出去的（用户定的第 5 条：只在当前这段里回退）切不过去：按钮照样在，点不了，说清楚为什么
            disabled={!fork.switchable}
            title={fork.switchable ? undefined : t("ui.branches.cantSwitch")}
            onClick={(e) => {
              const el = e.currentTarget;
              e.stopPropagation();
              // 收起后那个小方块的位置（面板此刻是展开的，不能拿它的尺寸）
              const fr = el.closest<HTMLElement>(".zd-fork")!.getBoundingClientRect();
              const pv = el.closest<HTMLElement>(".zd-abandoned")!.querySelector<HTMLElement>(".zd-ab-strip")!.getBoundingClientRect();
              host.onSwitch?.(fork.branchId, { left: fr.left, top: fr.top, width: 18 }, { left: pv.left, top: pv.top, width: pv.width }, el.closest<HTMLElement>(".zi")!);
            }}
          >
            {t("ui.branches.switch")}
          </button>
        )}
      </div>
      {/* 预览就是把这条分支按主线一模一样的方式渲染一遍：同一套 DOM、同一宽度，
          所以预览、切换动画、切换之后三者的每一块高度都严丝合缝 */}
      <div
        className="zd-ab-strip"
        onClick={(e) => {
          e.stopPropagation();
          host.onOpen?.(fork.branchId);
        }}
      >
        {host.renderItems(view.items)}
        {view.items.length === 0 && <div className="zd-ab-empty">{failed ? t("ui.branches.loadFailed", { error: failed }) : t("ui.branches.loading")}</div>}
      </div>
    </div>
  );
}
