// 测试用的 vCard（301 号票，只在测试里）：照 Google 联系人导出的样子（vCard 3.0、CRLF）编的一份通讯录——名字、号码、地址都是编的。
// - 陈晓：用户自己（测试把"我的名字"设成陈晓）：生日、纪念日、手机、家里的住址，相关的人写了张丽（母亲）、王大伟（配偶）；
// - 张丽：没有年份的生日、家里的电话和手机；
// - 周建国：昵称"老周"（档案里已经有"老周"），一个电话；
// - 李芳：两张卡片（Google 里重复的联系人），生日、相识纪念日、手机，另一张是家里的电话；
// - 赵六：只有电话（不进候选）。
// 另有造一份"几百人"的：前几个有生日，别的只有电话。

const crlf = (lines: readonly string[]) => `${lines.join("\r\n")}\r\n`;

export const SELF_NAME = "陈晓";

export const GOOGLE_CONTACTS_VCF = crlf([
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:陈晓",
  "N:陈;晓;;;",
  "EMAIL;TYPE=INTERNET;TYPE=HOME:chenxiao@example.com",
  "TEL;TYPE=CELL:138 0000 0001",
  "ADR;TYPE=HOME:;;某某路 9 号;杭州市;浙江省;310000;中国",
  "BDAY:1992-05-20",
  "item1.X-ABRELATEDNAMES:张丽",
  "item1.X-ABLabel:_$!<Mother>!$_",
  "item2.X-ABRELATEDNAMES:王大伟",
  "item2.X-ABLabel:_$!<Spouse>!$_",
  "item3.X-ABDATE:2018-10-01",
  "item3.X-ABLabel:_$!<Anniversary>!$_",
  "CATEGORIES:myContacts",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:张丽",
  "N:张;丽;;;",
  "TEL;TYPE=HOME:0571-8800 0002",
  "TEL;TYPE=CELL:139 0000 0002",
  "BDAY:--03-02",
  "CATEGORIES:myContacts",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:周建国",
  "N:周;建国;;;",
  "NICKNAME:老周",
  "TEL;TYPE=CELL:137-0000-0003",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:李芳",
  "N:李;芳;;;",
  "BDAY:19900815",
  "TEL;TYPE=CELL:136 0000 0004",
  "item1.X-ABDATE:2012-05-20",
  "item1.X-ABLabel:相识纪念日",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:李芳",
  "TEL;TYPE=HOME:021-1234 5678",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:赵六",
  "TEL;TYPE=CELL:137 0000 0006",
  "NOTE:只有电话",
  "END:VCARD",
]);

/** 同一份通讯录、张丽换了手机号（再导一次只该交这一个新号码） */
export const GOOGLE_CONTACTS_VCF_NEW_PHONE = GOOGLE_CONTACTS_VCF.replace("TEL;TYPE=CELL:139 0000 0002", "TEL;TYPE=CELL:139 0000 0012");

/** 几百人的通讯录：前 dated 个有生日（"联系人01"……，生日 1 月 1 日起），后面的只有电话 */
export function bigAddressBook(dated: number, phoneOnly: number): string {
  const lines: string[] = [];
  for (let i = 1; i <= dated + phoneOnly; i++) {
    const n = String(i).padStart(3, "0");
    lines.push("BEGIN:VCARD", "VERSION:3.0", `FN:联系人${n}`, `TEL;TYPE=CELL:135 0000 0${n}`);
    if (i <= dated) lines.push(`BDAY:--${String(((i - 1) % 12) + 1).padStart(2, "0")}-${String(((i - 1) % 28) + 1).padStart(2, "0")}`);
    lines.push("END:VCARD");
  }
  return crlf(lines);
}
