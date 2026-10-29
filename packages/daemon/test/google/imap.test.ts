// 只读的 IMAP 客户端（298 号票，google/imap.ts）：不加依赖，自己写的那部分——
// - 按字节读回应（literal 被切在几个包里、长度 0 的、几条回应挤在一个包里）、解值（带方括号的 atom、NIL、引号里的转义、嵌套的括号）；
// - 只读：只放行 CAPABILITY / LOGIN / LIST / EXAMINE / UID SEARCH / UID FETCH（只能 BODY.PEEK）/ LOGOUT / NOOP，写操作和会标已读的 FETCH 拒绝；
// - 连本机的假 IMAP 服务（TLS，测试的自签证书经 ca 信任）：登录、列邮箱（\All、\Sent、修改过的 UTF-7 的中文名）、只读打开、
//   中文搜索（CHARSET UTF-8 + literal，等"+"再发）、取信头和整封（BODY.PEEK，不标已读）、只取前一段；服务端没收到任何写操作，用完断开；
// - 出错的种类：密码不对（AUTHENTICATIONFAILED）、要应用专用密码（ALERT）、证书不认、超时、连不上、EXAMINE 没给 READ-ONLY；消息里没有密码。
// 不连真的 Gmail、不联网。
import { afterEach, describe, expect, it } from "vitest";
import { assertReadOnly, connectImap, decodeMailboxName, encodeMailboxName, ImapError, type ImapSession, imapDate, ResponseReader, textOf, tokenize, uidSet } from "../../src/google/imap.ts";
import { parseMail } from "../../src/google/mime.ts";
import { type FakeImapServer, startFakeImapServer } from "../helpers/fake-imap.ts";
import { APP_PASSWORD, injectionMail, ME, sentReplyMail, ticketMail } from "../helpers/fake-mail.ts";
import { waitUntil } from "../helpers/process.ts";

const PASSWORD = APP_PASSWORD.replace(/\s+/g, "");

describe("读回应、解值", () => {
  it("literal 被切在几个包里、长度 0 的、几条回应挤在一个包里", () => {
    const reader = new ResponseReader();
    const whole = Buffer.concat([Buffer.from("* 1 FETCH (UID 7 BODY[] {6}\r\n", "latin1"), Buffer.from("你好", "utf8"), Buffer.from(" FLAGS ())\r\n* 2 FETCH (UID 8 BODY[] {0}\r\n)\r\nA1 OK done\r\n", "latin1")]);
    const got = [];
    for (let i = 0; i < whole.length; i += 5) got.push(...reader.push(whole.subarray(i, i + 5)));
    expect(got).toHaveLength(3);
    const first = tokenize(got[0]!);
    expect(first.slice(0, 3)).toEqual(["*", "1", "FETCH"]);
    const list = first[3] as unknown[];
    expect(list[0]).toBe("UID");
    expect((list[3] as Buffer).toString("utf8")).toBe("你好");
    expect(list.slice(4)).toEqual(["FLAGS", []]);
    expect(((tokenize(got[1]!)[3] as unknown[])[3] as Buffer).length).toBe(0);
    expect(tokenize(got[2]!).slice(0, 2)).toEqual(["A1", "OK"]);
  });

  it("带方括号的 atom 整个算一个（里面有空格和括号）、BODY[]<0>、NIL、引号里的转义、嵌套的括号", () => {
    const r = { parts: ['* 3 FETCH (UID 9 BODY[HEADER.FIELDS (DATE FROM)] NIL X "a \\"b\\" \\\\c" ((1 2) NIL) BODY[]<0> "")'] };
    const list = tokenize(r)[3] as unknown[];
    expect(list[2]).toBe("BODY[HEADER.FIELDS (DATE FROM)]");
    expect(list[3]).toBeNull();
    expect(textOf(list[5] as Buffer)).toBe('a "b" \\c');
    expect(list[6]).toEqual([["1", "2"], null]);
    expect(list[7]).toBe("BODY[]<0>");
    expect(tokenize({ parts: ['* LIST (\\HasNoChildren \\Sent) "/" "[Gmail]/&XfJT0ZAB-"'] })).toEqual(["*", "LIST", ["\\HasNoChildren", "\\Sent"], Buffer.from("/"), Buffer.from("[Gmail]/&XfJT0ZAB-")]);
  });

  it("修改过的 UTF-7 的邮箱名：中文、& 来回都对", () => {
    expect(encodeMailboxName("[Gmail]/已发邮件")).toBe("[Gmail]/&XfJT0ZCuTvY-");
    expect(decodeMailboxName("[Gmail]/&XfJT0ZCuTvY-")).toBe("[Gmail]/已发邮件");
    expect(decodeMailboxName(encodeMailboxName("A&B 草稿"))).toBe("A&B 草稿");
    expect(encodeMailboxName("A&B")).toBe("A&-B");
  });

  it("UID 序列集、IMAP 的日期", () => {
    expect(uidSet([7, 1, 2, 3, 9, 10, 3])).toBe("1:3,7,9:10");
    expect(imapDate("2026-10-05")).toBe("5-Oct-2026");
    expect(() => imapDate("10/05")).toThrow(ImapError);
  });
});

describe("只读", () => {
  it.each(["CAPABILITY", "NOOP", "LOGIN \"a\" \"b\"", 'LIST "" "*"', 'EXAMINE "INBOX"', "LOGOUT", "UID SEARCH CHARSET UTF-8 SUBJECT {6}", "UID FETCH 1:3 (UID RFC822.SIZE INTERNALDATE BODY.PEEK[HEADER.FIELDS (DATE FROM)])", "UID FETCH 5 (UID BODY.PEEK[]<0.1048576>)", "UID FETCH 5 (RFC822.SIZE RFC822.HEADER)"])("放行：%s", (command) => {
    expect(() => assertReadOnly(command)).not.toThrow();
  });

  it.each([
    'SELECT "INBOX"',
    "STORE 1 +FLAGS (\\Seen)",
    "UID STORE 1 +FLAGS (\\Deleted)",
    "EXPUNGE",
    "UID EXPUNGE 1",
    'APPEND "INBOX" {10}',
    'UID COPY 1 "[Gmail]/Trash"',
    'UID MOVE 1 "[Gmail]/Trash"',
    'DELETE "x"',
    'CREATE "x"',
    "CLOSE",
    "FETCH 1 (BODY.PEEK[])",
    "UID FETCH 1 (BODY[])",
    "UID FETCH 1 (BODY[TEXT])",
    "UID FETCH 1 (RFC822)",
    "UID FETCH 1 (RFC822.TEXT)",
  ])("拒绝：%s", (command) => {
    expect(() => assertReadOnly(command)).toThrow(expect.objectContaining({ kind: "refused" }));
  });
});

describe("连本机的假 IMAP 服务（TLS，测试证书）", () => {
  let server: FakeImapServer;
  const sessions: ImapSession[] = [];
  const open = async (extra: { ca?: string | undefined; timeoutMs?: number } = {}) => {
    const s = await connectImap({ ...server.endpoint, ...("ca" in extra ? { ca: extra.ca } : {}), ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }) });
    sessions.push(s);
    return s;
  };
  afterEach(async () => {
    for (const s of sessions.splice(0)) s.close();
    await server?.close();
  });

  it("登录、列邮箱、只读打开、中文搜索、取信头和整封（不标已读）、只取前一段；服务端没收到写操作，用完断开", async () => {
    server = await startFakeImapServer({ user: ME, password: PASSWORD });
    const ticket = server.add(ticketMail(), ["INBOX", "all"]);
    server.add(injectionMail(), ["INBOX", "all"]);
    server.add(sentReplyMail(), ["sent", "all"]);
    const imap = await open();
    expect(imap.capabilities.has("IMAP4REV1")).toBe(true);
    await imap.login(ME, PASSWORD);

    const boxes = await imap.list();
    expect(boxes.map((b) => [b.display, b.flags.filter((f) => f === "\\all" || f === "\\sent" || f === "\\noselect")])).toEqual([
      ["[Gmail]", ["\\noselect"]],
      ["INBOX", []],
      ["[Gmail]/All Mail", ["\\all"]],
      ["[Gmail]/已发邮件", ["\\sent"]],
    ]);
    const sent = boxes.find((b) => b.flags.includes("\\sent"))!;
    expect(sent.name).toBe("[Gmail]/&XfJT0ZCuTvY-");

    const all = await imap.examine("[Gmail]/All Mail");
    expect(all).toEqual({ exists: 3, uidValidity: server.uidValidity("all"), uidNext: 103 });
    // 中文主题：CHARSET UTF-8 + literal
    expect(await imap.search({ subject: "行程单" })).toEqual([ticket.all]);
    expect(await imap.search({ text: "火锅" })).toEqual([102]);
    expect(await imap.search({ from: "air.example.com", since: "2026-10-24", before: "2026-10-25" })).toEqual([ticket.all]);
    expect(await imap.search({})).toEqual([100, 101, 102]);
    expect(await imap.search({ uidFrom: 200 })).toEqual([]);

    const [head] = await imap.fetch([ticket.all!], { size: true, internalDate: true, flags: true, headerFields: ["DATE", "FROM", "SUBJECT"] });
    expect(head).toMatchObject({ uid: ticket.all, size: ticketMail().length, internalDate: "24-Oct-2026 10:00:00 +0800", flags: [] });
    expect(parseMail(head!.header!).subject).toBe("机票行程单：10 月 30 日 北京-上海");
    const [whole] = await imap.fetch([ticket.all!], { body: {} });
    expect(whole!.body!.equals(ticketMail())).toBe(true);
    const [part] = await imap.fetch([ticket.all!], { body: { maxBytes: 200 } });
    expect(part!.body!.length).toBe(200);

    // 打开发件箱（名字是修改过的 UTF-7）
    expect((await imap.examine(sent.name)).exists).toBe(1);
    await imap.logout();
    await waitUntil(() => server.active === 0, { timeoutMs: 5_000, describe: () => `还开着 ${server.active} 个` });
    expect(server.flags("all", ticket.all!)).toEqual([]);
    expect(server.writes).toEqual([]);
    expect(new Set(server.commands)).toEqual(new Set(["LOGIN", "LIST", "EXAMINE", "UID SEARCH", "UID FETCH", "LOGOUT"]));
  });

  it("客户端自己拒绝写操作：一个字节都不发出去", async () => {
    server = await startFakeImapServer({ user: ME, password: PASSWORD });
    const imap = await open();
    await imap.login(ME, PASSWORD);
    // 绕过类型，假装有人想发 STORE：会话没有这种方法；底下的命令口也只认只读的
    expect(Object.keys(imap).toSorted()).toEqual(["capabilities", "close", "examine", "fetch", "list", "login", "logout", "search"]);
    await imap.logout();
    expect(server.writes).toEqual([]);
  });

  it("密码不对：登录没通过（AUTHENTICATIONFAILED），消息里没有密码；要应用专用密码时是 ALERT", async () => {
    server = await startFakeImapServer({ user: ME, password: PASSWORD });
    const imap = await open();
    const err = await imap.login(ME, "wrongpassword123").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImapError);
    expect(err).toMatchObject({ kind: "auth", code: "AUTHENTICATIONFAILED" });
    expect(String((err as Error).message)).not.toContain("wrongpassword123");
    server.alert = "Application-specific password required: https://support.google.com/accounts/answer/185833";
    const again = await (await open()).login(ME, PASSWORD).catch((e: unknown) => e);
    expect(again).toMatchObject({ kind: "auth", code: "ALERT" });
    expect((again as Error).message).toContain("Application-specific password required");
  });

  it("证书不认（没交测试证书）：tls；连上了什么都不回：超时；端口没人听：连不上", async () => {
    server = await startFakeImapServer({ user: ME, password: PASSWORD });
    expect(await open({ ca: undefined }).catch((e: unknown) => e)).toMatchObject({ kind: "tls" });
    server.hang = true;
    expect(await open({ timeoutMs: 300 }).catch((e: unknown) => e)).toMatchObject({ kind: "timeout" });
    const { port } = server.endpoint;
    await server.close();
    expect(await connectImap({ host: "127.0.0.1", port, timeoutMs: 2_000 }).catch((e: unknown) => e)).toMatchObject({ kind: "connect", code: "ECONNREFUSED" });
    server = await startFakeImapServer({ user: ME, password: PASSWORD });
  });

  it("EXAMINE 回来的不是 [READ-ONLY]：不往下做", async () => {
    server = await startFakeImapServer({ user: ME, password: PASSWORD });
    server.readWrite = true;
    const imap = await open();
    await imap.login(ME, PASSWORD);
    expect(await imap.examine("INBOX").catch((e: unknown) => e)).toMatchObject({ kind: "protocol" });
  });

  it("中止信号：正在等的命令出错（aborted）", async () => {
    server = await startFakeImapServer({ user: ME, password: PASSWORD });
    server.hang = true;
    const controller = new AbortController();
    const pending = connectImap({ ...server.endpoint, signal: controller.signal }).catch((e: unknown) => e);
    setTimeout(() => controller.abort(), 100);
    expect(await pending).toMatchObject({ kind: "aborted" });
  });
});
