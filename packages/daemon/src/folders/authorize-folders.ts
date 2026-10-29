// 快速动作"授权文件夹"（138 号票，用户 2026-10-18：秘书能看到的文件范围和"浏览"里的二狗不要有区别；在聊天里授权了某些目录，
// 设置里不用再设一次）：用户对秘书说"把图片和下载文件夹授权给你""别让二狗看下载了"，秘书用"提议快速动作"提出 authorize_folders，
// 参数是方向（加进来、拿掉）和文件夹的完整路径（可以几个；"刚才翻过的那几个"由秘书换成具体路径）。
// - 只有一份"授权的文件夹"：设置 · 浏览与填框里那一份（local-folders.ts），执行就是改它；"浏览"里替上传框找文件（find_files）、
//   秘书替用户找照片和文件都先在这里找。设置页每次重新显示时重新取，所以聊天里授权的回到设置页就能看到；
// - 规范化：加进来的只认完整路径、存在的文件夹，加上以后最多 LOCAL_FOLDERS_MAX 个；拿掉的要在授权的文件夹里（找不到了的也能拿掉）；
//   都已经是这样的（全都授权过了、全都不在里面）不出卡，原因回给秘书；
// - 一律要用户点按钮（2026-10-18 用户定：任何 agent 自己都不能改授权的文件夹）：confirm: "always"，不管用户原话点没点名，
//   都出一张待确认的卡（卡上写清加、拿掉哪几个完整路径），用户点"执行"才改；设置页里用户自己的加、叉照旧马上存；
// - 不落入任何内置类别（用户的自定义类别照样能按 quick_action:authorize_folders 匹配它）。
// 授权在守卫里的完整含义（对话审批开着时，授权的文件夹里读文件不用再批准）不在本票：按"新安全设计只记录不实现"只记下来。
import { AUTHORIZE_FOLDERS_ACTION, LOCAL_FOLDERS_MAX, type LocalFoldersView, t, tTable, Type } from "@ergo/protocol";
import { RequestRejected } from "../errors.ts";
import { defineQuickAction, PROPOSE_QUICK_ACTION, type QuickActionExecutor } from "../quick-actions/index.ts";
import type { LocalFolders } from "./local-folders.ts";

/** 方向：加进授权的文件夹、拿掉 */
export type FolderChange = "add" | "remove";

/** 设置里在哪看、在哪改（秘书的上下文、工具说明里说这一句，给模型的照旧中文；卡上给用户看的走 t()） */
export const AUTHORIZED_FOLDERS_SETTING = "设置 · 浏览与填框"; // @i18n-ignore model：秘书的上下文和工具说明里用

/** 秘书的上下文块"授权的文件夹"的 id（138 号票；内核给的，不带插件名的前缀，不会和插件的重） */
export const AUTHORIZED_FOLDERS_BLOCK_ID = "authorized-folders";

const Params = Type.Object(
  {
    // @i18n-ignore-start model：参数说明
    change: Type.Enum(["add", "remove"] as const, { description: "add 授权（加进授权的文件夹）；remove 取消授权（从授权的文件夹里拿掉）" }),
    folders: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
      minItems: 1,
      maxItems: LOCAL_FOLDERS_MAX,
      description: "文件夹在二狗这台电脑上的完整路径（比如 C:\\Users\\me\\Pictures），可以几个；用户说“刚才翻过的那几个”时换成具体路径",
    }),
    // @i18n-ignore-end
  },
  { additionalProperties: false },
);

/** 规范化后的参数 */
interface AuthorizeFoldersParams {
  change: FolderChange;
  folders: string[];
}

/** 卡片标题里的名字：文件夹名（盘的根写完整路径） */
const nameOf = (dir: string) => dir.split(/[\\/]/u).findLast((s) => s !== "" && !s.endsWith(":")) ?? dir;

const VERB: Readonly<Record<FolderChange, string>> = tTable({ add: "folders.folders.verb.add", remove: "folders.folders.verb.remove" });

/** 快速动作"授权文件夹"（在 daemon.ts 里登记） */
export function authorizeFoldersAction(localFolders: LocalFolders): QuickActionExecutor {
  return defineQuickAction({
    type: AUTHORIZE_FOLDERS_ACTION,
    get title() {
      return t("folders.folders.title");
    },
    usage: `用户在聊天里授权你找文件的文件夹（change 写 add），或者取消授权（change 写 remove，“别让二狗看下载了”）：改授权的文件夹（你在聊天里、在“浏览”里找文件都用这一份，${AUTHORIZED_FOLDERS_SETTING}里能看能改）。总要用户在卡上点“执行”才改`, // @i18n-ignore model：给秘书的用法
    params: Params,
    // 改的是二狗自己的一份设置，不落入任何内置类别；任何 agent 自己都不能改它，总要用户在卡上点"执行"
    watch: { categories: [] },
    confirm: "always",
    normalize({ change, folders }) {
      const prepared = localFolders.prepare(change === "add" ? { add: folders } : { remove: folders });
      const touched = change === "add" ? prepared.added : prepared.removed;
      if (touched.length === 0) {
        // @i18n-ignore-start model：交给秘书的出错说明
        if (change === "add") throw new RequestRejected("not_allowed", `这些文件夹已经授权了：${prepared.requested.join("、")}`);
        const now = localFolders.list();
        throw new RequestRejected("not_allowed", `这些文件夹不在授权的文件夹里：${prepared.requested.join("、")}（现在授权的有：${now.length > 0 ? now.join("、") : "还没有"}）`);
        // @i18n-ignore-end
      }
      const params: AuthorizeFoldersParams = { change, folders: prepared.requested };
      return {
        params: { ...params },
        title: t("folders.folders.cardTitle", { verb: VERB[change], names: prepared.requested.map(nameOf).join(t("folders.listSep")) }),
        // 卡上写清加、拿掉哪几个完整路径，用户点之前看得清
        target: prepared.requested.join(t("folders.listSep")),
        content: change === "add" ? t("folders.folders.addNote") : t("folders.folders.removeNote"),
      };
    },
    execute(params) {
      const { change, folders } = params as AuthorizeFoldersParams;
      // 执行时再核对一遍（确认之前文件夹可能没了、列表可能在设置里改过）：不让做的抛 RequestRejected，卡片保持待处理
      const done = localFolders.change(change === "add" ? { add: folders } : { remove: folders });
      const touched = change === "add" ? done.added : done.removed;
      const sep = t("folders.listSep");
      const already =
        done.unchanged.length === 0 ? "" : t(change === "add" ? "folders.folders.alreadyAdded" : "folders.folders.alreadyRemoved", { folders: done.unchanged.join(sep) });
      const what =
        touched.length > 0
          ? t(change === "add" ? "folders.folders.doneAdd" : "folders.folders.doneRemove", { count: touched.length, n: touched.length, folders: touched.join(sep), already })
          : t("folders.folders.unchanged", { already });
      return { events: [], summary: t("folders.folders.summary", { what }) };
    },
  });
}

/**
 * 秘书的上下文块（138 号票，agent 贡献的上下文块，被唤起时注入、每次现取）：现在授权了哪几个文件夹（没有写"还没有"），
 * 聊天里授权、取消授权用快速动作（要用户在卡上点"执行"），替用户找照片、找文件先在这里找
 */
// @i18n-ignore-next model：秘书的上下文块
export function secretaryFoldersBlock(view: LocalFoldersView): string {
  // @i18n-ignore-start model：秘书的上下文块
  const list = view.folders.length === 0 ? ["还没有。"] : view.folders.map((f) => `- ${f.path}${f.exists ? "" : "（现在找不到了）"}`);
  return [
    `授权的文件夹（你在聊天里、在“浏览”里找文件都用这一份，${AUTHORIZED_FOLDERS_SETTING}里能看、能改）：`,
    ...list,
    `用户在聊天里授权、取消授权文件夹时，用 ${PROPOSE_QUICK_ACTION} 的 ${AUTHORIZE_FOLDERS_ACTION}（params.folders 写完整路径）：会出一张卡，用户点了“执行”才改，之前不要说已经改了。替用户找照片、找文件时，先在这些文件夹里找。`,
  ].join("\n");
  // @i18n-ignore-end
}
