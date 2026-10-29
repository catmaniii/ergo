// vCard 解析（301 号票，google/vcard.ts）：Google 联系人导出的 3.0、手机导出的 2.1（QUOTED-PRINTABLE）、4.0 的写法，示例联系人都是编的
// （名字、号码、地址不是真的）：
// - 称呼（FN，没有就用 N 拼：中文连着写、西文"名 姓"）、昵称、中文名；
// - 续行（包括把一个汉字的几个字节折到两行的）、BOM 和 CRLF、UTF-16、GB18030（老手机）、QUOTED-PRINTABLE 和它的软换行；
// - 生日：有年份的、没年份的 --MM-DD / --MMDD、苹果的 X-APPLE-OMIT-YEAR、带时间的、文字写的、日历上没有的那天不要；没有生日的；
// - 纪念日：ANNIVERSARY（4.0）、X-ANNIVERSARY、Google / 苹果的 X-ABDATE + X-ABLabel；
// - 关系：X-ABRELATEDNAMES + X-ABLabel、RELATED（文字、urn:uuid）、X-SPOUSE；
// - 几个电话（类型、首选、tel: 网址）、住址（中文从大到小、西文、整段填在街道里的）；照片、邮箱这些不读；没有称呼的卡片、嵌在里面的卡片不算。
import { describe, expect, it } from "vitest";
import { decodeVcardText, formatVcardDate, labelOf, looksLikeVcard, parseVcardDate, parseVcards } from "../../src/google/vcard.ts";

const crlf = (lines: string[]) => `${lines.join("\r\n")}\r\n`;

/** Google 联系人导出的样子（vCard 3.0） */
const GOOGLE_EXPORT = crlf([
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:陈晓",
  "N:陈;晓;;;",
  "NICKNAME:晓晓",
  "EMAIL;TYPE=INTERNET;TYPE=HOME:chenxiao@example.com",
  "TEL;TYPE=CELL:138 0000 0001",
  "TEL;TYPE=WORK:010-6000 0001",
  "ADR;TYPE=HOME:;;某某路 9 号;杭州市;浙江省;310000;中国",
  "BDAY:1992-05-20",
  "item1.X-ABRELATEDNAMES:张丽",
  "item1.X-ABLabel:_$!<Mother>!$_",
  "item2.X-ABRELATEDNAMES:王大伟",
  "item2.X-ABLabel:_$!<Spouse>!$_",
  "item3.X-ABDATE:2018-10-01",
  "item3.X-ABLabel:_$!<Anniversary>!$_",
  "item4.X-ABDATE:2015-06-30",
  "item4.X-ABLabel:相识纪念日",
  "PHOTO:https://lh3.googleusercontent.com/contacts/fake-photo",
  "CATEGORIES:myContacts,starred",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:张丽",
  "N:张;丽;;;",
  "TEL;TYPE=HOME:0571-8800 0002",
  "TEL;TYPE=CELL:139 0000 0002",
  "BDAY:--03-02",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:赵六",
  "TEL;TYPE=CELL:137 0000 0006",
  "NOTE:只有电话的人",
  "END:VCARD",
]);

describe("vCard：Google 联系人导出的 3.0", () => {
  it("称呼、昵称、生日、几个电话、住址、关系、纪念日；照片、邮箱、分组不读；没有生日的就没有", () => {
    const [chen, zhang, zhao] = parseVcards(Buffer.from(GOOGLE_EXPORT, "utf8"));
    expect(chen).toEqual({
      name: "陈晓",
      nicknames: ["晓晓"],
      birthday: { year: 1992, month: 5, day: 20 },
      anniversaries: [
        { date: { year: 2018, month: 10, day: 1 }, label: "anniversary" },
        { date: { year: 2015, month: 6, day: 30 }, label: "相识纪念日" },
      ],
      phones: [
        { value: "138 0000 0001", types: ["cell"], pref: false },
        { value: "010-6000 0001", types: ["work"], pref: false },
      ],
      addresses: [{ value: "浙江省杭州市某某路 9 号", types: ["home"], pref: false }],
      related: [
        { name: "张丽", types: [], label: "mother" },
        { name: "王大伟", types: [], label: "spouse" },
      ],
    });
    expect(zhang).toMatchObject({ name: "张丽", birthday: { month: 3, day: 2 }, phones: [{ types: ["home"] }, { types: ["cell"] }] });
    expect(zhang!.birthday).not.toHaveProperty("year");
    expect(zhao).toMatchObject({ name: "赵六", anniversaries: [], related: [] });
    expect(zhao).not.toHaveProperty("birthday");
  });

  it("认文件：开头是 BEGIN:VCARD（带 BOM、前面有空行也认），别的不认", () => {
    expect(looksLikeVcard(Buffer.from(GOOGLE_EXPORT))).toBe(true);
    expect(looksLikeVcard(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`\r\n${GOOGLE_EXPORT}`)]))).toBe(true);
    expect(looksLikeVcard(Buffer.from("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"))).toBe(false);
    expect(looksLikeVcard(Buffer.from("name,phone\n王小明,13800000000\n"))).toBe(false);
  });
});

describe("vCard：编码、续行、QUOTED-PRINTABLE", () => {
  it("续行接上一行；一个汉字的几个字节被折到两行也接得回来", () => {
    const name = Buffer.from("欧阳小明", "utf8");
    // 在"阳"字的第二个字节后面折行
    const bytes = Buffer.concat([
      Buffer.from("BEGIN:VCARD\r\nVERSION:3.0\r\nFN:"),
      name.subarray(0, 5),
      Buffer.from("\r\n "),
      name.subarray(5),
      Buffer.from("\r\nNOTE:很长的一行\r\n\t接着写\r\nEND:VCARD\r\n"),
    ]);
    expect(parseVcards(bytes).map((c) => c.name)).toEqual(["欧阳小明"]);
  });

  it("手机导出的 2.1：QUOTED-PRINTABLE + CHARSET、软换行、光秃秃的 CELL;PREF", () => {
    const text = crlf([
      "BEGIN:VCARD",
      "VERSION:2.1",
      "N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=E7=8E=8B;=E5=B0=8F=E6=98=8E;;;",
      "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=E7=8E=8B=E5=B0=8F=",
      "=E6=98=8E",
      "TEL;CELL;PREF:13800001111",
      "TEL;HOME:010-12345678",
      "ADR;HOME;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:;;=E6=9F=90=E6=9F=90=E8=B7=AF 1 =E5=8F=B7;=E5=8C=97=E4=BA=AC=E5=B8=82;;;",
      "END:VCARD",
    ]);
    const [c] = parseVcards(Buffer.from(text));
    expect(c).toMatchObject({
      name: "王小明",
      phones: [
        { value: "13800001111", types: ["cell", "pref"], pref: true },
        { value: "010-12345678", types: ["home"], pref: false },
      ],
      addresses: [{ value: "北京市某某路 1 号", types: ["home"] }],
    });
  });

  it("没有 FN 的用 N 拼：中文姓名连着写，西文\"名 姓\"；只有昵称的用昵称；什么都没有的卡片不算", () => {
    const text = crlf([
      "BEGIN:VCARD",
      "VERSION:3.0",
      "N:李;芳;;;",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:3.0",
      "N:Smith;Anna;;Dr.;",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:3.0",
      "NICKNAME:老周",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:3.0",
      "TEL:13800000000",
      "END:VCARD",
    ]);
    expect(parseVcards(text).map((c) => c.name)).toEqual(["李芳", "Dr. Anna Smith", "老周"]);
  });

  it("UTF-16（带 BOM）、GB18030（老手机导出的中文，不是合法 UTF-8）都读得出", () => {
    const text = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:王小明\r\nEND:VCARD\r\n";
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    expect(parseVcards(utf16).map((c) => c.name)).toEqual(["王小明"]);
    // "王小明"的 GBK 编码
    const gbk = Buffer.concat([Buffer.from("BEGIN:VCARD\r\nVERSION:2.1\r\nFN:"), Buffer.from([0xcd, 0xf5, 0xd0, 0xa1, 0xc3, 0xf7]), Buffer.from("\r\nEND:VCARD\r\n")]);
    expect(decodeVcardText(gbk)).toContain("王小明");
    expect(parseVcards(gbk).map((c) => c.name)).toEqual(["王小明"]);
  });

  it("文字里的转义（\\, \\; \\n）、带引号的参数值、嵌在里面的卡片（AGENT）不单算", () => {
    const text = crlf([
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:周\\,建国",
      'TEL;TYPE="cell,voice":138-0000-0003',
      "ADR;TYPE=work:;;Room 5\\nNo. 1 Some Road;Springfield;IL;62701;USA",
      "AGENT:BEGIN:VCARD",
      "BEGIN:VCARD",
      "FN:里面的人",
      "END:VCARD",
      "END:VCARD",
    ]);
    const contacts = parseVcards(text);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      name: "周,建国",
      phones: [{ value: "138-0000-0003", types: ["cell", "voice"] }],
      addresses: [{ value: "Room 5 No. 1 Some Road, Springfield, IL 62701, USA", types: ["work"] }],
    });
  });
});

describe("vCard：4.0、别的软件的写法", () => {
  it("RELATED（文字、urn:uuid）、ANNIVERSARY、TEL 写成 tel: 网址、PREF=1；X-ANNIVERSARY、X-SPOUSE", () => {
    const text = crlf([
      "BEGIN:VCARD",
      "VERSION:4.0",
      "UID:urn:uuid:aaaa-1111",
      "FN:李芳",
      "BDAY:--0815",
      "ANNIVERSARY:20120520",
      "RELATED;TYPE=spouse;VALUE=text:刘强",
      "RELATED;TYPE=child:urn:uuid:bbbb-2222",
      "RELATED;TYPE=friend:mailto:someone@example.com",
      "TEL;VALUE=uri;TYPE=cell:tel:+86-138-0000-0004",
      "TEL;VALUE=uri;TYPE=home;PREF=1:tel:+86-21-6000-0004",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:孙七",
      "X-ANNIVERSARY:2010-09-09",
      "X-SPOUSE:周八",
      "END:VCARD",
    ]);
    const [li, sun] = parseVcards(text);
    expect(li).toMatchObject({
      uid: "urn:uuid:aaaa-1111",
      birthday: { month: 8, day: 15 },
      anniversaries: [{ date: { year: 2012, month: 5, day: 20 }, label: "anniversary" }],
      related: [
        { name: "刘强", types: ["spouse"] },
        { uid: "bbbb-2222", types: ["child"] },
      ],
      phones: [
        { value: "+86-138-0000-0004", types: ["cell"], pref: false },
        { value: "+86-21-6000-0004", types: ["home"], pref: true },
      ],
    });
    expect(sun).toMatchObject({ anniversaries: [{ date: { year: 2010, month: 9, day: 9 }, label: "anniversary" }], related: [{ name: "周八", types: ["spouse"] }] });
  });

  it("住址：整段填在街道里的不重复写省市；同名的段只写一次", () => {
    const text = crlf([
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:钱九",
      "ADR;TYPE=HOME:;;上海市某某区某某路 2 号;上海市;上海市;;中国",
      "ADR:;;广州市天河区某某路 3 号;;;;",
      "END:VCARD",
    ]);
    expect(parseVcards(text)[0]!.addresses.map((a) => a.value)).toEqual(["上海市某某区某某路 2 号", "广州市天河区某某路 3 号"]);
  });
});

describe("vCard：日子", () => {
  it("认得出的写法", () => {
    expect(parseVcardDate("1990-03-02")).toEqual({ year: 1990, month: 3, day: 2 });
    expect(parseVcardDate("19900302")).toEqual({ year: 1990, month: 3, day: 2 });
    expect(parseVcardDate("1990-03-02T00:00:00Z")).toEqual({ year: 1990, month: 3, day: 2 });
    expect(parseVcardDate("--03-02")).toEqual({ month: 3, day: 2 });
    expect(parseVcardDate("--0302")).toEqual({ month: 3, day: 2 });
    expect(parseVcardDate("0000-03-02")).toEqual({ month: 3, day: 2 });
    expect(parseVcardDate("1604-03-02", "1604")).toEqual({ month: 3, day: 2 });
    expect(parseVcardDate("--02-29")).toEqual({ month: 2, day: 29 });
    expect(parseVcardDate("1990年3月2日")).toEqual({ year: 1990, month: 3, day: 2 });
    expect(parseVcardDate("3月2号")).toEqual({ month: 3, day: 2 });
  });

  it("认不出、日历上没有的那天不要", () => {
    expect(parseVcardDate("1990-02-30")).toBeUndefined();
    expect(parseVcardDate("1991-02-29")).toBeUndefined();
    expect(parseVcardDate("--13-01")).toBeUndefined();
    expect(parseVcardDate("1990")).toBeUndefined();
    expect(parseVcardDate("circa 1800")).toBeUndefined();
    expect(parseVcardDate("")).toBeUndefined();
  });

  it("苹果的 X-APPLE-OMIT-YEAR 参数：那个年份是占位的", () => {
    const text = crlf(["BEGIN:VCARD", "VERSION:3.0", "FN:吕十", "BDAY;X-APPLE-OMIT-YEAR=1604:1604-11-11", "END:VCARD"]);
    expect(parseVcards(text)[0]!.birthday).toEqual({ month: 11, day: 11 });
  });

  it("写成档案里的样子：有年份的 1990-03-02，没年份的 03-02", () => {
    expect(formatVcardDate({ year: 1990, month: 3, day: 2 })).toBe("1990-03-02");
    expect(formatVcardDate({ month: 12, day: 25 })).toBe("12-25");
  });

  it("苹果、Google 的标准名字写成小写英文词，自己起的原样", () => {
    expect(labelOf("_$!<Anniversary>!$_")).toBe("anniversary");
    expect(labelOf("_$!<Other>!$_")).toBe("other");
    expect(labelOf("结婚纪念日")).toBe("结婚纪念日");
    expect(labelOf("  ")).toBeUndefined();
  });
});
