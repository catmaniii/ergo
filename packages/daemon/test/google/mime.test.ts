// 邮件解析（298 号票，google/mime.ts）：不加依赖，自己写的那部分——
// - 信头：编码字（B / Q、GBK 的一个字切在两段里）、没编码的 8 位字节（UTF-8、GBK）、地址列表（引号里的逗号、注释、组、几个 To）、日期；
// - 参数：RFC 2231 的续段和字符集、引号里塞编码字的文件名；
// - 正文：multipart 嵌套（alternative 挑纯文本、只有 HTML 的转文字）、base64、quoted-printable（软换行、GBK 字节）、format=flowed、
//   截断了没有结束分隔线的、分隔线是另一条的前缀的；
// - 附件：名字、类型、大约多大，嵌在正文里的图片标 inline，转发的整封邮件；
// - 本人写的：去掉回复里引的原文（英文回复头折成两行、"写道："、"> "、Outlook 的发件人块、"原始邮件"分隔线；HTML 的 gmail_quote）。
import { describe, expect, it } from "vitest";
import { decodeBase64, decodeCharset, decodeQuotedPrintable, decodeWords, dropQuotedHtml, htmlToText, parseAddresses, parseMail, parseMailDate, parseParams, splitMultipart, stripQuoted } from "../../src/google/mime.ts";
import { b64, FAKE_PDF, gbk, mail, ME, multipart, part, qp, sentReplyMail, ticketMail, word } from "../helpers/fake-mail.ts";

describe("信头", () => {
  it("编码字：B 和 Q、UTF-8 和 GBK；相邻的几段之间的空白去掉，普通文字和编码字之间的留着", () => {
    expect(decodeWords(word("机票行程单"))).toBe("机票行程单");
    expect(decodeWords(word("你好 世界", { q: true }))).toBe("你好 世界");
    expect(decodeWords(word("行程单", { charset: "GBK" }))).toBe("行程单");
    expect(decodeWords(`${word("回复：")} ${word("周五聚餐")}`)).toBe("回复：周五聚餐");
    expect(decodeWords(`Re: ${word("聚餐")} (2)`)).toBe("Re: 聚餐 (2)");
    expect(decodeWords("=?utf-8?q?caf=C3=A9_au_lait?=")).toBe("café au lait");
    expect(decodeWords("=?ISO-8859-1?Q?Andr=E9?= Pirard")).toBe("André Pirard");
    expect(decodeWords("=?UTF-8*zh?B?5L2g5aW9?=")).toBe("你好");
  });

  it("同一字符集的相邻编码字先拼字节再解：GBK 的一个字被切在两段里也能解对", () => {
    const bytes = gbk("北京上海");
    const split = `=?GBK?B?${bytes.subarray(0, 3).toString("base64")}?= =?GBK?B?${bytes.subarray(3).toString("base64")}?=`;
    expect(decodeWords(split)).toBe("北京上海");
  });

  it("没编码直接写 8 位字节的信头：UTF-8 照解，不是 UTF-8 的按 GBK（GB18030）认", () => {
    const utf8 = Buffer.concat([Buffer.from("Subject: ", "latin1"), Buffer.from("直接写的主题", "utf8"), Buffer.from("\r\nFrom: ", "latin1"), gbk("王芳"), Buffer.from(" <wang.fang@example.com>\r\n\r\nhi", "latin1")]);
    const parsed = parseMail(utf8);
    expect(parsed.subject).toBe("直接写的主题");
    expect(parsed.from).toEqual([{ name: "王芳", address: "wang.fang@example.com" }]);
    const gbkSubject = Buffer.concat([Buffer.from("Subject: ", "latin1"), gbk("国内客户端发的"), Buffer.from("\r\nContent-Type: text/plain; charset=gb2312\r\n\r\n", "latin1"), gbk("正文")]);
    expect(parseMail(gbkSubject)).toMatchObject({ subject: "国内客户端发的", text: "正文" });
  });

  it("地址列表：引号里的逗号、名字里的编码字、注释、组、没有名字的；几个 To 信头合起来", () => {
    expect(parseAddresses(`"Li, Hua" <li.hua@example.com>, ${word("张小明")} <zhang.xiaoming@example.com>, plain@example.com`)).toEqual([
      { name: "Li, Hua", address: "li.hua@example.com" },
      { name: "张小明", address: "zhang.xiaoming@example.com" },
      { address: "plain@example.com" },
    ]);
    expect(parseAddresses("wang.fang@example.com (王芳)")).toEqual([{ name: "王芳", address: "wang.fang@example.com" }]);
    expect(parseAddresses("朋友们: a@example.com, b@example.com;, c@example.com")).toEqual([{ address: "a@example.com" }, { address: "b@example.com" }, { address: "c@example.com" }]);
    expect(parseAddresses("undisclosed-recipients:;")).toEqual([]);
    expect(parseAddresses('"Re: x" <a@example.com>')).toEqual([{ name: "Re: x", address: "a@example.com" }]);
    const two = parseMail(mail([["To", "a@example.com"], ["To", "B <b@example.com>"], ["Cc", "c@example.com"]], "x"));
    expect([two.to, two.cc]).toEqual([[{ address: "a@example.com" }, { name: "B", address: "b@example.com" }], [{ address: "c@example.com" }]]);
  });

  it("日期：带注释的、带星期的、没有星期的、两位年份；解析不了的没有", () => {
    expect(parseMailDate("Sat, 24 Oct 2026 10:00:00 +0800 (CST)")?.toISOString()).toBe("2026-10-24T02:00:00.000Z");
    expect(parseMailDate("24 Oct 2026 10:00 +0800")?.toISOString()).toBe("2026-10-24T02:00:00.000Z");
    expect(parseMailDate("Sat, 24 Oct 26 10:00:00 GMT")?.toISOString()).toBe("2026-10-24T10:00:00.000Z");
    expect(parseMailDate("明天")).toBeUndefined();
    expect(parseMailDate(undefined)).toBeUndefined();
  });

  it("参数：RFC 2231 的续段和字符集、引号里的编码字、没引号的、大小写", () => {
    expect(parseParams("attachment; filename*=UTF-8''%E8%A1%8C%E7%A8%8B%E5%8D%95.pdf")).toEqual({ value: "attachment", params: { filename: "行程单.pdf" } });
    expect(parseParams("attachment; filename*0*=UTF-8''%E6%9C%BA%E7%A5%A8; filename*1*=%E8%A1%8C%E7%A8%8B; filename*2=.pdf").params.filename).toBe("机票行程.pdf");
    expect(parseParams(`application/pdf; name="${word("发票", { charset: "GB18030" })}.pdf"`)).toEqual({ value: "application/pdf", params: { name: "发票.pdf" } });
    expect(parseParams('Text/Plain; Charset="GBK"; format=flowed; DelSp=Yes')).toEqual({ value: "text/plain", params: { charset: "GBK", format: "flowed", delsp: "Yes" } });
    expect(parseParams("attachment; filename*=gb2312''%D0%D0%B3%CC.txt").params.filename).toBe("行程.txt");
  });
});

describe("传输编码和字符集", () => {
  it("base64 容忍换行、空白和坏字符，末尾不完整的丢掉；quoted-printable 的软换行和 =XX", () => {
    expect(decodeBase64("5L2g\r\n5aW9 !!").toString("utf8")).toBe("你好");
    expect(decodeBase64("5L2g5aW9Z").toString("utf8")).toBe("你好");
    expect(decodeQuotedPrintable("caf=C3=A9 =\r\nau lait=\nok   \r\nnext").toString("utf8")).toBe("café au laitok\r\nnext");
    expect(decodeQuotedPrintable("a=ZZb").toString("latin1")).toBe("a=ZZb");
  });

  it("字符集：GBK / GB2312 / GB18030 / Big5 / ISO-8859-1 / Windows-1252；没写的先试 UTF-8，不是就按 GBK；认不得的按 UTF-8", () => {
    expect(decodeCharset(gbk("简体中文"), "GB2312")).toBe("简体中文");
    expect(decodeCharset(gbk("简体中文"), "gbk")).toBe("简体中文");
    expect(decodeCharset(gbk("简体中文"), "x-gbk")).toBe("简体中文");
    expect(decodeCharset(Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]), "big5")).toBe("中文");
    expect(decodeCharset(Buffer.from([0x63, 0x61, 0x66, 0xe9]), "iso-8859-1")).toBe("café");
    expect(decodeCharset(Buffer.from([0x93, 0x68, 0x69, 0x94]), "windows-1252")).toBe("“hi”");
    expect(decodeCharset(Buffer.from("你好", "utf8"))).toBe("你好");
    expect(decodeCharset(gbk("你好"))).toBe("你好");
    expect(decodeCharset(gbk("你好"), "us-ascii")).toBe("你好");
    expect(decodeCharset(Buffer.from("ok", "utf8"), "no-such-charset")).toBe("ok");
  });
});

describe("正文和附件", () => {
  it("机票行程单：mixed 里套 alternative，挑 GBK base64 的纯文本；附件是中文名的 PDF（大约多大）；发件人、主题、日期、Message-ID", () => {
    const parsed = parseMail(ticketMail());
    expect(parsed.subject).toBe("机票行程单：10 月 30 日 北京-上海");
    expect(parsed.from).toEqual([{ name: "示例航空", address: "noreply@air.example.com" }]);
    expect(parsed.to).toEqual([{ address: ME }]);
    expect(parsed.date?.toISOString()).toBe("2026-10-24T02:00:00.000Z");
    expect(parsed.messageId).toBe("<ticket-1@air.example.com>");
    expect(parsed.text).toBe("尊敬的旅客：\n您预订的 10 月 30 日 北京-上海 航班已出票，行程单见附件。\n航班号 XX1234，08:30 起飞。");
    expect(parsed.fromHtml).toBe(false);
    expect(parsed.attachments).toEqual([{ filename: "行程单.pdf", contentType: "application/pdf", size: FAKE_PDF.length }]);
  });

  it("只有 HTML（GBK quoted-printable）：转成文字，块级换行、列表、链接写出网址、实体换回，脚本样式去掉，行内标签不插空格", () => {
    const html = '<html><head><style>p{color:red}</style><title>t</title></head><body><p>您好，<b>张</b>先生&nbsp;&amp;&nbsp;家人：</p><ul><li>第一项</li><li>第二项</li></ul><p>详情见 <a href="https://shop.example.com/o/1">订单页</a>&hellip;</p><script>alert(1)</script></body></html>';
    const parsed = parseMail(mail([["Content-Type", "text/html; charset=gb2312"], ["Content-Transfer-Encoding", "quoted-printable"]], qp(gbk(html))));
    expect(parsed.fromHtml).toBe(true);
    expect(parsed.text).toBe("您好，张先生 & 家人：\n\n- 第一项\n- 第二项\n\n详情见 订单页（https://shop.example.com/o/1）…");
  });

  it("嵌在正文里的图片标 inline、引号里塞编码字的附件名、转发的整封邮件算附件；mixed 里只有 HTML 的那段也转成文字", () => {
    const forwarded = mail([["Subject", word("转发的那封")], ["From", "x@example.com"]], "inner body");
    const raw = mail(
      [["Content-Type", 'multipart/mixed; boundary="b1"']],
      multipart("b1", [
        part([["Content-Type", 'multipart/related; boundary="b2"']], multipart("b2", [part([["Content-Type", "text/html; charset=utf-8"]], '<p>看图：<img src="cid:img1"></p>'), part([["Content-Type", "image/png"], ["Content-ID", "<img1>"], ["Content-Transfer-Encoding", "base64"]], b64(Buffer.alloc(300, 1)))])),
        part([["Content-Type", `application/vnd.ms-excel; name="${word("报销单", { charset: "GBK" })}.xls"`], ["Content-Transfer-Encoding", "base64"]], b64(Buffer.alloc(1200, 2))),
        part([["Content-Type", "message/rfc822"]], forwarded),
      ]),
    );
    const parsed = parseMail(raw);
    expect(parsed.text).toBe("看图：");
    expect(parsed.fromHtml).toBe(true);
    expect(parsed.attachments).toEqual([
      { filename: "image.png", contentType: "image/png", size: 300, inline: true },
      { filename: "报销单.xls", contentType: "application/vnd.ms-excel", size: 1200 },
      { filename: "转发的那封.eml", contentType: "message/rfc822", size: forwarded.length },
    ]);
  });

  it("format=flowed：行尾空格是软换行（DelSp=yes 去掉那个空格）；签名线不接", () => {
    const flowed = parseMail(mail([["Content-Type", "text/plain; charset=utf-8; format=flowed"]], "这是很长的一句 \n接着写完。\n-- \n签名"));
    expect(flowed.text).toBe("这是很长的一句 接着写完。\n-- \n签名");
    const delsp = parseMail(mail([["Content-Type", "text/plain; charset=utf-8; format=flowed; delsp=yes"]], "abc \ndef"));
    expect(delsp.text).toBe("abcdef");
  });

  it("截断了的（没有结束分隔线、base64 断在中间）：照样解出前面的正文，附件列出来", () => {
    const full = ticketMail();
    const cut = full.subarray(0, full.length - 1500);
    const parsed = parseMail(cut);
    expect(parsed.text).toContain("航班号 XX1234");
    expect(parsed.attachments.map((a) => a.filename)).toEqual(["行程单.pdf"]);
  });

  it("分隔线：长一截的另一条分隔线不算（外层 b、里层 b-inner），前言后记不进正文，没有信头的段按纯文本", () => {
    const body = ["preamble", "--b", "Content-Type: multipart/alternative; boundary=b-inner", "", "--b-inner", "", "inner plain", "--b-inner--", "--b", "", "second part", "--b--", "epilogue"].join("\r\n");
    expect(splitMultipart(body, "b")).toEqual(["Content-Type: multipart/alternative; boundary=b-inner\r\n\r\n--b-inner\r\n\r\ninner plain\r\n--b-inner--", "\r\nsecond part"]);
    const parsed = parseMail(mail([["Content-Type", "multipart/mixed; boundary=b"]], Buffer.from(body, "latin1")));
    expect(parsed.text).toBe("inner plain\n\nsecond part");
  });

  it("没有 Content-Type 的按 US-ASCII 纯文本；有 8 位字节的先试 UTF-8", () => {
    expect(parseMail(mail([["Subject", "x"]], "就是正文")).text).toBe("就是正文");
  });
});

describe("本人写的：去掉引用的原文", () => {
  it("英文 Gmail 回复头折成两行：之后的都去掉；> 开头的行去掉", () => {
    const parsed = parseMail(sentReplyMail());
    expect(stripQuoted(parsed.text)).toBe("周五晚上我可以，地点就定在公司楼下那家火锅店吧。\n我先订位子。");
  });

  it.each([
    ["中文 Gmail", "好的，收到。\n\n张小明 <zhang.xiaoming@example.com> 于2026年10月24日周六 18:00写道：\n> 原文"],
    ["在……写道", "好的，收到。\n\n在 2026年10月24日 18:00，张小明 写道:\n原文"],
    ["原始邮件分隔线", "好的，收到。\n\n------------------ 原始邮件 ------------------\n发件人: 张小明\n原文"],
    ["Outlook 的发件人块", "好的，收到。\n\n发件人: 张小明 <zhang.xiaoming@example.com>\n发送时间: 2026年10月24日 18:00\n收件人: 我\n原文"],
    ["英文 Outlook", "好的，收到。\n________________________________\nFrom: Zhang\nSent: Saturday\n原文"],
    ["Forwarded", "好的，收到。\n\n---------- Forwarded message ---------\nFrom: x\n原文"],
  ])("%s：回复头之后的都去掉", (_name, text) => {
    expect(stripQuoted(text)).toBe("好的，收到。");
  });

  it("正文里提到'发件人'但后面不是信头块的不去掉；没有引用的原样", () => {
    expect(stripQuoted("发件人: 写错了地址\n我再发一次。")).toBe("发件人: 写错了地址\n我再发一次。");
    expect(stripQuoted("只是一句话")).toBe("只是一句话");
  });

  it("HTML：blockquote、gmail_quote 去掉再转文字", () => {
    const html = '<div dir="ltr">我也去。</div><br><div class="gmail_quote"><div class="gmail_attr">On Sat, Oct 24 张小明 wrote:<br></div><blockquote class="gmail_quote"><div>一起吃饭吗？<div>嵌套</div></div></blockquote></div>';
    expect(htmlToText(dropQuotedHtml(html))).toBe("我也去。");
    expect(htmlToText(dropQuotedHtml("<p>前</p><blockquote>引<blockquote>再引</blockquote>还是引</blockquote><p>后</p>"))).toBe("前\n\n后");
  });
});
