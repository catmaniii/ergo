// Google · 联系人这个数据源（301 号票，ADR-0027 的"数据源"贡献点）：写在 Google 插件的数据契约里（插件停用也认得：设置 · 数据源照样
// 列出、写"Google插件没启用"，删除已导入的照样删得掉）。
// - 只有导入文件夹这一种用法（People API 要 OAuth，先不走——调研 37、39）：用户在 Google 联系人网页版"导出"成 vCard，放进共用的
//   导入文件夹；认 .vcf / .vcard、开头是 BEGIN:VCARD 的文件；没有连接这回事（手动导入）；
// - 导入的东西去哪：进个人档案的候选核对卡（逐条确认才写进档案），不进素材（destination 写明）；
// - 记录是 Google 插件自己的两类事件（contacts-events.ts）："共几条"是交过几个人（count，同一个人导几次算一个）；
// - 断开（删除已导入的）：记录换成"已删除"标记由内核做，档案候选里从它来的、还没写进档案的由个人档案登记的删除参与方删（299 号票那一段）；
//   确认框里说的就是这个（disconnectNote，306 号票：没有密钥、不进素材，不说通用的那几句）。
// 不用敏感类别：通讯录不进素材、不拿来推断。
import { t } from "@ergo/protocol";
import type { DataSource } from "../data-sources/api.ts";
import { GOOGLE_CONTACT, GOOGLE_CONTACTS_OFFERED } from "./contacts-events.ts";
import { GOOGLE_CONTACTS_SOURCE, type GoogleContactsService } from "./contacts.ts";
import { GOOGLE_CHANNEL } from "./events.ts";
import { looksLikeVcard } from "./vcard.ts";

export function googleContactsSource(active: () => GoogleContactsService): DataSource {
  return {
    id: GOOGLE_CONTACTS_SOURCE,
    get title() {
      return t("google.contacts.title");
    },
    get summary() {
      return t("google.contacts.summary");
    },
    usages: {
      import: {
        default: true,
        get destination() {
          return t("google.contacts.destination");
        },
      },
    },
    records: [
      { channel: GOOGLE_CHANNEL, type: GOOGLE_CONTACT },
      { channel: GOOGLE_CHANNEL, type: GOOGLE_CONTACTS_OFFERED },
    ],
    files: [
      {
        get title() {
          return t("google.contacts.file");
        },
        extensions: [".vcf", ".vcard"],
        sniff: (head) => looksLikeVcard(head),
        import: (file, ctx) => active().importFile(file, ctx),
      },
    ],
    count: () => active().count(),
    get disconnectNote() {
      return t("google.contacts.disconnectNote");
    },
  };
}
