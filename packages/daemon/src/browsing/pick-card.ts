// 网页候选卡（browse_pick，147 号票）：秘书在浏览侧边栏里替选中的上传框找文件、拿不准交哪个时（browse_attach_files 的 candidates），
// 候选放进秘书的会话成这张卡——缩略图一格一格，单张的框单选、多张的框能勾几张，秘书推荐的预先选上（照 145 号票的候选面板）。
// - "交"（confirm，带选中的取件码）：核对是这张卡上的、单张的框只选了一个、加起来不太大、取件码没过期，再经守护进程转给发消息的
//   那台设备（browser-links.ts），交进建卡时选中的那个框（设备核对还是那一页、框还在；网页弹出的选文件对话框核对它还等着）；
//   交进去了卡片处理完、记着选了哪几个、交进去几个；没交成（浏览器关了、换了网页、框没了）卡片还是待处理、能再点，原因记在卡上
//   （failed，149 号票：网页上的挑图片窗口和会话里的卡两边都显示）；
// - "都不要"（dismiss）：什么都不交，卡片关掉；
// - 取件码过期了（15 分钟）再点"交"：卡片作废，写明让二狗再找一次。
// 149 号票：同一张卡会话里（秘书页、浏览侧边栏）和网页上的挑图片窗口里都能点，只认第一次的选择——卡片按版本先到先得；
// 一次"交"还在路上（设备在取文件、交进框）时，同一张卡再点"交"、"都不要"直接回"正在交"，不会交两回。网页上的窗口里点的
// 设备先在本机交（候选一出来就预备好了文件），交完再带着结果（done）来记一笔，守护进程不再转给设备。
import { type BrowsePickCardPayload, BrowsePickCardPayload as BrowsePickSchema, BrowsePickConfirmInput, PAGE_FILES_TOTAL_MAX_BYTES, t } from "@ergo/protocol";
import { defineCardType } from "../cards/registry.ts";
import { RequestRejected } from "../errors.ts";
import type { BrowserLinks, LinkOutcome } from "./browser-links.ts";

/** 纯文本降级（生成时按当时的语言写，173 号票） */
export const browsePickText = (p: BrowsePickCardPayload): string =>
  t("browsing.pick.text", {
    page: p.page.title || p.page.url,
    field: p.field,
    how: t(p.multiple ? "browsing.pick.multiple" : "browsing.pick.single"),
    files: p.files.map((f) => f.name).join(t("pages.common.listSep")),
  });

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

export function browsePickCardType(deps: { links: Pick<BrowserLinks, "request">; now?: () => number }) {
  const now = deps.now ?? Date.now;
  /** 正在交的卡（编号）：交完、没交成都拿掉 */
  const delivering = new Set<string>();
  const busy = (cardId: string) => {
    if (delivering.has(cardId)) throw new RequestRejected("conflict", t("browsing.pick.busy"));
  };
  return defineCardType({
    type: "browse_pick",
    version: 1,
    payload: BrowsePickSchema,
    actions: {
      confirm: {
        input: BrowsePickConfirmInput,
        async run({ card, payload: p, input }) {
          busy(card.id);
          const tokens = [...new Set(input.tokens)];
          const chosen = tokens.flatMap((token) => p.files.filter((f) => f.token === token));
          if (chosen.length < tokens.length) throw new RequestRejected("bad_params", t("browsing.pick.notCandidate"));
          if (chosen.length > 1 && !p.multiple) throw new RequestRejected("bad_params", t("browsing.pick.onlyOne"));
          if (chosen.reduce((sum, f) => sum + f.size, 0) > PAGE_FILES_TOTAL_MAX_BYTES) throw new RequestRejected("bad_params", t("browsing.pick.tooBig", { limit: mb(PAGE_FILES_TOTAL_MAX_BYTES) }));
          const { failed: _old, ...rest } = p;
          // 网页上的挑图片窗口点的（149 号票）：设备已经在本机交过了，只记下结果
          if (input.done) {
            if ("failed" in input.done) return { status: "pending" as const, payload: { ...rest, failed: t("browsing.pick.failed", { reason: input.done.failed }).slice(0, 500) } };
            return {
              status: "handled" as const,
              payload: { ...rest, picked: chosen.map((f) => f.token), delivered: input.done.delivered },
              note: t("browsing.pick.doneOnPage", { picked: chosen.length, delivered: input.done.delivered }),
            };
          }
          if (Date.parse(p.expiresAt) <= now()) return { status: "expired" as const, note: t("browsing.pick.expired") };
          delivering.add(card.id);
          let outcome: LinkOutcome;
          try {
            // 184 号票：秘书按编号指的上传框按编号交（设备的页面桥核对还是那一页、编号认得、还是上传框）
            outcome = await deps.links.request(p.browser, p.ref ? { op: "attach", ref: p.ref, url: p.page.url, files: chosen } : { op: "attach", fieldId: p.fieldId, url: p.page.url, files: chosen });
          } finally {
            delivering.delete(card.id);
          }
          // 没交成：卡还能再点，原因记在卡上（两边都看得到）
          if (!outcome.ok) return { status: "pending" as const, payload: { ...rest, failed: t("browsing.pick.failed", { reason: outcome.userReason ?? outcome.reason }).slice(0, 500) } };
          const delivered = outcome.count ?? chosen.length;
          return {
            status: "handled" as const,
            payload: { ...rest, picked: chosen.map((f) => f.token), delivered },
            note: t("browsing.pick.done", { picked: chosen.length, delivered }),
          };
        },
      },
      dismiss: {
        input: undefined,
        run: ({ card }) => {
          busy(card.id);
          return { status: "dismissed" as const, note: t("browsing.pick.dismissed") };
        },
      },
    },
    toText: browsePickText,
  });
}
