// 测试用的假 IMAP 服务（298 号票，只在测试里）：本机 127.0.0.1 随机端口起一个 TLS 服务（下面的测试自签证书，CN=localhost、
// SAN 有 127.0.0.1，2020–2120 年有效，只给测试用，客户端经 ca 信任它），照 Gmail 的样子回应——不连真的 Gmail、不联网。
// - 三个邮箱：INBOX、[Gmail]/All Mail（\All）、[Gmail]/已发邮件（\Sent，名字是修改过的 UTF-7，和中文界面的 Gmail 一样）；
//   每个邮箱有自己的 UIDVALIDITY 和 UID，一封邮件可以同时在几个邮箱里；
// - 认的命令：CAPABILITY、LOGIN（地址和应用专用密码对才过；alert 给了就回 [ALERT]，像 Gmail 要求应用专用密码时那样）、LIST、
//   EXAMINE（回 [READ-ONLY]；readWrite 置位时故意回 [READ-WRITE]）、UID SEARCH（ALL、UID 范围、SINCE、BEFORE、FROM、TO、SUBJECT、TEXT、
//   BODY，CHARSET UTF-8，literal 先回"+"再收）、UID FETCH（UID、RFC822.SIZE、INTERNALDATE、FLAGS、BODY.PEEK[HEADER.FIELDS (…)]、
//   BODY.PEEK[]、BODY.PEEK[]<0.n>）、NOOP、LOGOUT；
// - **写操作一律记下来**（writes）：SELECT、STORE、EXPUNGE、APPEND、COPY、MOVE、DELETE、CREATE、RENAME、CLOSE……（回 NO），
//   不带 PEEK 的 BODY[] / RFC822 也记（还会把那封标成已读：测试能看出标没标）；commands 记下收到的每条命令的动词（LOGIN 只记动词，不记密码）；
// - 搜索按解码后的信头和正文比（借 google/mime.ts 的 parseMail；它自己有单元测试），不分大小写、按子串；
// - hang 置位时连上以后什么都不回（测超时）；connections / active 数连了几次、还开着几个（客户端用完要断开）。
import tls from "node:tls";
import { type ImapEndpoint, encodeMailboxName, tokenize, textOf, type ImapValue } from "../../src/google/imap.ts";
import { formatAddress, parseMail } from "../../src/google/mime.ts";
import { pemBegin, pemEnd } from "./fake-secrets.ts";

/** 测试用的自签证书（只给假服务用，不是任何真的密钥） */
export const TEST_IMAP_CERT = `-----BEGIN CERTIFICATE-----
MIIBzjCCAXWgAwIBAgIUWeeCpCod1xUAaYUKKhnD4KYu8+0wCgYIKoZIzj0EAwIw
LjESMBAGA1UEAwwJbG9jYWxob3N0MRgwFgYDVQQKDA9lcmdvdSB0ZXN0IG9ubHkw
IBcNMjAwMTAxMDAwMDAwWhgPMjEyMDAxMDEwMDAwMDBaMC4xEjAQBgNVBAMMCWxv
Y2FsaG9zdDEYMBYGA1UECgwPZXJnb3UgdGVzdCBvbmx5MFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAErCyd4S1Etl80l2Fj2jWdMdq1b7acA7R9NUWm4U1HQWLwr6xr
WhjpF+PmAx1FVlmgdBRWJE+8t0xiXIPKagJ9T6NvMG0wHQYDVR0OBBYEFMQP31kw
Zfw36kRbDpuSKji9oOoUMB8GA1UdIwQYMBaAFMQP31kwZfw36kRbDpuSKji9oOoU
MA8GA1UdEwEB/wQFMAMBAf8wGgYDVR0RBBMwEYIJbG9jYWxob3N0hwR/AAABMAoG
CCqGSM49BAMCA0cAMEQCIDge53bz/7JSYRVehUXp3sNuGRTGPbWmVtBAj6lyCQGV
AiAYGaX4Ucj6zSWZXAtAlKhRF7q7RHFlb4YvLBvQQ1o4Tw==
-----END CERTIFICATE-----
`;
// 私钥那两行开头、结尾在运行时拼（helpers/fake-secrets.ts）：源码里不出现完整的私钥块
const TEST_IMAP_KEY = `${pemBegin()}
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgRhyvXXRxfetoO/jT
lks8Tg1ocKG359+DOoSeVrHJJXShRANCAASsLJ3hLUS2XzSXYWPaNZ0x2rVvtpwD
tH01RabhTUdBYvCvrGtaGOkX4+YDHUVWWaB0FFYkT7y3TGJcg8pqAn1P
${pemEnd()}
`;

export type FakeBox = "INBOX" | "all" | "sent";
/** 邮箱的名字（原样的，修改过的 UTF-7）和属性 */
const BOXES: Record<FakeBox, { name: string; flags: string[] }> = {
  INBOX: { name: "INBOX", flags: ["\\HasNoChildren"] },
  all: { name: "[Gmail]/All Mail", flags: ["\\All", "\\HasNoChildren"] },
  sent: { name: encodeMailboxName("[Gmail]/已发邮件"), flags: ["\\HasNoChildren", "\\Sent"] },
};
const ROOT = { name: "[Gmail]", flags: ["\\HasChildren", "\\Noselect"] };

export interface FakeMessage {
  uid: number;
  raw: Buffer;
  /** INTERNALDATE（"24-Oct-2026 10:00:00 +0800"） */
  internalDate: string;
  flags: string[];
}

interface Mailbox {
  readonly name: string;
  readonly flags: readonly string[];
  readonly uidValidity: number;
  nextUid: number;
  readonly messages: FakeMessage[];
}

export interface FakeImapServer {
  readonly endpoint: ImapEndpoint;
  /** 收到的每条命令的动词（"LOGIN"、"UID FETCH"……；LOGIN 不记参数） */
  readonly commands: string[];
  /** 收到的写操作（不该有） */
  readonly writes: string[];
  /** 连过几次、还开着几个 */
  connections: number;
  active: number;
  /** LOGIN 回 NO [ALERT] 这句（像 Gmail 要应用专用密码时） */
  alert: string | undefined;
  /** EXAMINE 故意回 [READ-WRITE] */
  readWrite: boolean;
  /** 连上以后什么都不回 */
  hang: boolean;
  /** 收到的 LOGIN 用的地址（不记密码） */
  readonly logins: string[];
  /** 放一封邮件进几个邮箱：交回它在每个邮箱里的 UID */
  add(raw: Buffer, boxes: readonly FakeBox[], options?: { internalDate?: string; seen?: boolean }): Record<FakeBox, number | undefined>;
  /** 某个邮箱的 UIDVALIDITY */
  uidValidity(box: FakeBox): number;
  /** 某个邮箱里某封的标记 */
  flags(box: FakeBox, uid: number): string[];
  close(): Promise<void>;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** INTERNALDATE → 这一天（YYYY-MM-DD，按它自己写的时区） */
function dayOf(internalDate: string): string {
  const m = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(internalDate)!;
  return `${m[3]}-${String(MONTHS.indexOf(m[2]!) + 1).padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
}
/** IMAP 的日期（24-Oct-2026）→ YYYY-MM-DD */
function imapDay(text: string): string {
  return dayOf(text);
}

/** 只取某几个信头（原样的行，续行跟着），末尾一个空行 */
function headerFields(raw: Buffer, fields: readonly string[]): Buffer {
  const text = raw.toString("latin1");
  const end = text.search(/\r?\n\r?\n/);
  const head = end < 0 ? text : text.slice(0, end);
  const want = new Set(fields.map((f) => f.toLowerCase()));
  const out: string[] = [];
  let keep = false;
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      if (keep) out.push(line);
      continue;
    }
    keep = want.has(line.slice(0, line.indexOf(":")).trim().toLowerCase());
    if (keep) out.push(line);
  }
  return Buffer.from(`${out.join("\r\n")}\r\n\r\n`, "latin1");
}

/** 序列集里有没有它（"1:3,7"、"5:*"） */
function inSet(set: string, uid: number, max: number): boolean {
  return set.split(",").some((piece) => {
    const [a, b] = piece.split(":");
    const lo = a === "*" ? max : Number(a);
    if (b === undefined) return uid === lo;
    const hi = b === "*" ? max : Number(b);
    return uid >= Math.min(lo, hi) && uid <= Math.max(lo, hi);
  });
}

const WRITE_VERBS = /^(SELECT|STORE|UID STORE|EXPUNGE|UID EXPUNGE|APPEND|COPY|UID COPY|MOVE|UID MOVE|DELETE|CREATE|RENAME|SUBSCRIBE|UNSUBSCRIBE|CLOSE|SETQUOTA|SETACL)$/;
const CAPS = "IMAP4rev1 UNSELECT IDLE NAMESPACE QUOTA ID CHILDREN X-GM-EXT-1 UIDPLUS SPECIAL-USE";

export async function startFakeImapServer(options: { user: string; password: string }): Promise<FakeImapServer> {
  let validity = 600_000;
  const boxes = new Map<FakeBox, Mailbox>(
    (Object.keys(BOXES) as FakeBox[]).map((k) => [k, { name: BOXES[k].name, flags: BOXES[k].flags, uidValidity: ++validity, nextUid: k === "all" ? 100 : k === "sent" ? 40 : 1, messages: [] }]),
  );
  const byName = (name: string) => [...boxes.values()].find((b) => b.name.toLowerCase() === name.toLowerCase());
  const sockets = new Set<tls.TLSSocket>();

  const state: Omit<FakeImapServer, "endpoint" | "add" | "uidValidity" | "flags" | "close"> = {
    commands: [],
    writes: [],
    connections: 0,
    active: 0,
    alert: undefined,
    readWrite: false,
    hang: false,
    logins: [],
  };

  const server = tls.createServer({ key: TEST_IMAP_KEY, cert: TEST_IMAP_CERT }, (socket) => {
    state.connections += 1;
    state.active += 1;
    sockets.add(socket);
    socket.on("close", () => {
      state.active -= 1;
      sockets.delete(socket);
    });
    socket.on("error", () => {});
    if (state.hang) return;
    const send = (text: string | Buffer) => socket.write(typeof text === "string" ? Buffer.from(text, "latin1") : text);
    send(`* OK [CAPABILITY ${CAPS}] Fake IMAP ready\r\n`);
    let authed = false;
    let selected: Mailbox | undefined;
    // 收命令：一行一行，行尾 {n} 的先回"+"再收 n 个字节
    let buf = Buffer.alloc(0);
    let parts: Array<string | Buffer> = [];
    let need: number | undefined;
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (need !== undefined) {
          if (buf.length < need) return;
          parts.push(buf.subarray(0, need));
          buf = buf.subarray(need);
          need = undefined;
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl < 0) return;
        const line = buf.subarray(0, nl).toString("latin1");
        buf = buf.subarray(nl + 2);
        parts.push(line);
        const lit = /\{(\d+)(\+?)\}$/.exec(line);
        if (lit) {
          need = Number(lit[1]);
          if (lit[2] !== "+") send("+ Ready for literal data\r\n");
          continue;
        }
        const tokens = tokenize({ parts });
        parts = [];
        handle(tokens);
      }
    });

    const handle = (tokens: ImapValue[]) => {
      const tag = textOf(tokens[0]);
      let verb = textOf(tokens[1]).toUpperCase();
      let args = tokens.slice(2);
      if (verb === "UID") {
        verb = `UID ${textOf(args[0]).toUpperCase()}`;
        args = args.slice(1);
      }
      state.commands.push(verb);
      const ok = (text: string) => send(`${tag} OK ${text}\r\n`);
      const no = (text: string) => send(`${tag} NO ${text}\r\n`);
      if (WRITE_VERBS.test(verb)) {
        state.writes.push(verb);
        no("[CANNOT] write commands are not allowed in this fake");
        return;
      }
      switch (verb) {
        case "CAPABILITY":
          send(`* CAPABILITY ${CAPS}\r\n`);
          ok("Success");
          return;
        case "NOOP":
          ok("Success");
          return;
        case "LOGOUT":
          send("* BYE LOGOUT Requested\r\n");
          ok("73 good day (Success)");
          socket.end();
          return;
        case "LOGIN": {
          const user = textOf(args[0]);
          state.logins.push(user);
          if (state.alert) return no(`[ALERT] ${state.alert} (Failure)`);
          if (user.toLowerCase() !== options.user.toLowerCase() || textOf(args[1]) !== options.password) return no("[AUTHENTICATIONFAILED] Invalid credentials (Failure)");
          authed = true;
          ok(`[CAPABILITY ${CAPS}] ${user} authenticated (Success)`);
          return;
        }
      }
      if (!authed) {
        send(`${tag} BAD Not authenticated\r\n`);
        return;
      }
      switch (verb) {
        case "LIST": {
          for (const b of [ROOT, ...boxes.values()]) send(`* LIST (${b.flags.join(" ")}) "/" "${b.name}"\r\n`);
          ok("Success");
          return;
        }
        case "EXAMINE": {
          const box = byName(Buffer.isBuffer(args[0]) ? args[0].toString("latin1") : textOf(args[0]));
          if (!box) return no("[NONEXISTENT] Unknown Mailbox (Failure)");
          selected = box;
          send("* FLAGS (\\Answered \\Flagged \\Draft \\Deleted \\Seen)\r\n* OK [PERMANENTFLAGS ()] Flags permitted.\r\n");
          send(`* OK [UIDVALIDITY ${box.uidValidity}] UIDs valid.\r\n* ${box.messages.length} EXISTS\r\n* 0 RECENT\r\n* OK [UIDNEXT ${box.nextUid}] Predicted next UID.\r\n`);
          ok(`[${state.readWrite ? "READ-WRITE" : "READ-ONLY"}] ${box.name} selected. (Success)`);
          return;
        }
        case "UID SEARCH": {
          if (!selected) return no("No mailbox selected");
          const box = selected;
          let i = 0;
          if (textOf(args[0]).toUpperCase() === "CHARSET") {
            if (textOf(args[1]).toUpperCase() !== "UTF-8") return no("[BADCHARSET (UTF-8)] charset not supported");
            i = 2;
          }
          const tests: Array<(m: FakeMessage) => boolean> = [];
          const max = box.messages.at(-1)?.uid ?? 0;
          while (i < args.length) {
            const key = textOf(args[i++]).toUpperCase();
            const value = () => textOf(args[i++]).toLowerCase();
            const parsed = (m: FakeMessage) => parseMail(m.raw);
            if (key === "ALL") continue;
            if (key === "UID") {
              const set = textOf(args[i++]);
              tests.push((m) => inSet(set, m.uid, max));
            } else if (key === "SINCE") {
              const day = imapDay(textOf(args[i++]));
              tests.push((m) => dayOf(m.internalDate) >= day);
            } else if (key === "BEFORE") {
              const day = imapDay(textOf(args[i++]));
              tests.push((m) => dayOf(m.internalDate) < day);
            } else if (key === "FROM") {
              const v = value();
              tests.push((m) => parsed(m).from.map(formatAddress).join(", ").toLowerCase().includes(v));
            } else if (key === "TO") {
              const v = value();
              tests.push((m) => parsed(m).to.map(formatAddress).join(", ").toLowerCase().includes(v));
            } else if (key === "SUBJECT") {
              const v = value();
              tests.push((m) => parsed(m).subject.toLowerCase().includes(v));
            } else if (key === "BODY") {
              const v = value();
              tests.push((m) => parsed(m).text.toLowerCase().includes(v));
            } else if (key === "TEXT") {
              const v = value();
              tests.push((m) => {
                const p = parsed(m);
                return [p.subject, p.text, ...p.from.map(formatAddress), ...p.to.map(formatAddress)].join("\n").toLowerCase().includes(v);
              });
            } else return send(`${tag} BAD Unknown search key ${key}\r\n`);
          }
          const hits = box.messages.filter((m) => tests.every((t) => t(m))).map((m) => m.uid);
          // 照 RFC："UID n:*" 至少回最后一封
          send(`* SEARCH${hits.map((u) => ` ${u}`).join("")}\r\n`);
          ok("SEARCH completed (Success)");
          return;
        }
        case "UID FETCH": {
          if (!selected) return no("No mailbox selected");
          const box = selected;
          const set = textOf(args[0]);
          const itemsValue = args[1];
          const items = (Array.isArray(itemsValue) ? itemsValue : [itemsValue]).map((x) => textOf(x as ImapValue));
          const max = box.messages.at(-1)?.uid ?? 0;
          for (const [index, m] of box.messages.entries()) {
            if (!inSet(set, m.uid, max)) continue;
            const out: Buffer[] = [Buffer.from(`* ${index + 1} FETCH (UID ${m.uid}`, "latin1")];
            for (const item of items.map((x) => x.toUpperCase())) {
              if (item === "UID") continue;
              if (item === "RFC822.SIZE") out.push(Buffer.from(` RFC822.SIZE ${m.raw.length}`, "latin1"));
              else if (item === "INTERNALDATE") out.push(Buffer.from(` INTERNALDATE "${m.internalDate}"`, "latin1"));
              else if (item === "FLAGS") out.push(Buffer.from(` FLAGS (${m.flags.join(" ")})`, "latin1"));
              else if (item.startsWith("BODY.PEEK[HEADER.FIELDS")) {
                const fields = /\(([^)]*)\)/.exec(item)![1]!.split(/\s+/).filter(Boolean);
                const bytes = headerFields(m.raw, fields);
                out.push(Buffer.from(` BODY[HEADER.FIELDS (${fields.join(" ")})] {${bytes.length}}\r\n`, "latin1"), bytes);
              } else if (/^BODY(\.PEEK)?\[\](<\d+\.\d+>)?$/.test(item) || item === "RFC822" || item === "RFC822.TEXT") {
                if (!item.includes(".PEEK")) {
                  state.writes.push(`FETCH ${item}`);
                  if (!m.flags.includes("\\Seen")) m.flags.push("\\Seen");
                }
                const partial = /<(\d+)\.(\d+)>/.exec(item);
                const bytes = partial ? m.raw.subarray(Number(partial[1]), Number(partial[1]) + Number(partial[2])) : m.raw;
                out.push(Buffer.from(` BODY[]${partial ? `<${partial[1]}>` : ""} {${bytes.length}}\r\n`, "latin1"), bytes);
              } else return send(`${tag} BAD Unknown fetch item ${item}\r\n`);
            }
            out.push(Buffer.from(")\r\n", "latin1"));
            send(Buffer.concat(out));
          }
          ok("Success");
          return;
        }
        default:
          send(`${tag} BAD Unknown command\r\n`);
      }
    };
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return Object.assign(state, {
    endpoint: { host: "127.0.0.1", port, ca: TEST_IMAP_CERT },
    add(raw: Buffer, inBoxes: readonly FakeBox[], opts: { internalDate?: string; seen?: boolean } = {}) {
      const out: Record<FakeBox, number | undefined> = { INBOX: undefined, all: undefined, sent: undefined };
      const date = parseMail(raw).date ?? new Date();
      const internalDate = opts.internalDate ?? internalDateOf(date);
      for (const key of inBoxes) {
        const box = boxes.get(key)!;
        const uid = box.nextUid++;
        box.messages.push({ uid, raw, internalDate, flags: opts.seen ? ["\\Seen"] : [] });
        out[key] = uid;
      }
      return out;
    },
    uidValidity: (box: FakeBox) => boxes.get(box)!.uidValidity,
    flags: (box: FakeBox, uid: number) => [...(boxes.get(box)!.messages.find((m) => m.uid === uid)?.flags ?? [])],
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}

const pad = (n: number) => String(n).padStart(2, "0");
/** 时间 → INTERNALDATE（按 +0800 写） */
export function internalDateOf(date: Date): string {
  const local = new Date(date.getTime() + 8 * 3_600_000);
  return `${pad(local.getUTCDate())}-${MONTHS[local.getUTCMonth()]}-${local.getUTCFullYear()} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())} +0800`;
}
