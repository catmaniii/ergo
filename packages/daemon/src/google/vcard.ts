// vCard（.vcf）解析（301 号票）：用户从 Google 联系人导出、放进导入文件夹的那一份，只读出进档案候选够用的部分，不加 npm 依赖。
// 认的写法：vCard 2.1 / 3.0 / 4.0（Google 导出的是 3.0；手机、Outlook 导出的 2.1、4.0 也认得）——
// - 文件的编码：UTF-8（带不带 BOM）、UTF-16（带 BOM）；不是合法 UTF-8 的按 GB18030 读（老手机导出的中文）；
// - 续行（以空格或 Tab 开头的行接到上一行；按字节接——有的导出把一个汉字的几个字节折到两行）、QUOTED-PRINTABLE 的软换行（行末的 =）
//   和它的 CHARSET；
// - 属性的分组（Google、苹果的 item1.X-ABLabel 给同组的属性起名字）、参数（TYPE=CELL,VOICE、TYPE=cell;TYPE=pref、2.1 的光秃秃的
//   CELL;PREF、4.0 的 PREF=1、带引号的值）、文字里的转义（\n \, \; \\）、结构化的值（N、ADR 用 ; 分几段）；
// - 读的属性：FN、N、NICKNAME、BDAY、ANNIVERSARY / X-ANNIVERSARY / X-MS-ANNIVERSARY / X-EVOLUTION-ANNIVERSARY、X-ABDATE（Google、苹果的
//   "重要日子"，名字在同组的 X-ABLabel）、X-ABRELATEDNAMES（同组的 X-ABLabel 是关系）、RELATED（4.0，TYPE 是关系，值是名字或者
//   urn:uuid 指向同一份文件里的另一张）、X-SPOUSE 之类（Outlook、Evolution 的配偶、上司、助理）、TEL、ADR、UID。照片、邮箱、备注这些不读。
// 日子（生日、纪念日）认 19900302、1990-03-02、1990-03-02T00:00:00Z、没有年份的 --0302、--03-02、苹果的 X-APPLE-OMIT-YEAR=1604；
// 文字写的（VALUE=text:3月2日）也认。认不出、日历上没有这一天的不要。
// 解析只管 vCard 本身；哪个是用户自己、谁和用户什么关系、取哪个电话进档案在 contacts.ts。

/** 一个日子：没有年份的（--03-02）year 不写 */
export interface VcardDate {
  readonly year?: number;
  readonly month: number;
  readonly day: number;
}

/** 带类型的一个值（电话、住址）：TYPE 都小写；pref 是首选；label 是同组 X-ABLabel 起的名字 */
export interface VcardTyped {
  readonly value: string;
  readonly types: readonly string[];
  readonly pref: boolean;
  readonly label?: string;
}

/** 一个相关的人：名字或者指向同一份文件里另一张的 uid；types 是关系（RELATED 的 TYPE、X-SPOUSE 之类认成的），label 是 X-ABLabel */
export interface VcardRelated {
  readonly name?: string;
  readonly uid?: string;
  readonly types: readonly string[];
  readonly label?: string;
}

/** 一个纪念日（重要的日子）：label 是同组 X-ABLabel（苹果的 _$!<Anniversary>!$_ 写成 anniversary）；ANNIVERSARY 那几种写 anniversary */
export interface VcardDated {
  readonly date: VcardDate;
  readonly label?: string;
}

/** 一张联系人卡片 */
export interface VcardContact {
  readonly uid?: string;
  /** 称呼：FN，没有就用 N 拼出来（中文"姓名"连着写，西文"名 姓"） */
  readonly name: string;
  readonly nicknames: readonly string[];
  readonly birthday?: VcardDate;
  readonly anniversaries: readonly VcardDated[];
  readonly phones: readonly VcardTyped[];
  readonly addresses: readonly VcardTyped[];
  readonly related: readonly VcardRelated[];
}

interface Property {
  group?: string;
  /** 大写 */
  name: string;
  /** 参数名大写 → 值（几个的都在里面，没有拆逗号） */
  params: Map<string, string[]>;
  /** 原样的值（QUOTED-PRINTABLE 已经解开，转义还在） */
  raw: string;
}

const UTF8_BOM = [0xef, 0xbb, 0xbf];

const isBlank = (b: number | undefined) => b === 0x20 || b === 0x09;

/**
 * 按字节接上续行（换行后面紧跟空格或 Tab 的，换行和那一个空白去掉）：要在读成文字之前做——有的导出按 75 个字节折行，
 * 把一个汉字的几个字节折到了两行。UTF-8、GB18030 的多字节里不会有换行、空格这几个字节，不会接错
 */
function unfoldBytes(bytes: Buffer): Buffer {
  const out = Buffer.alloc(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 0x0d && bytes[i + 1] === 0x0a && isBlank(bytes[i + 2])) {
      i += 2;
      continue;
    }
    if ((b === 0x0a || b === 0x0d) && isBlank(bytes[i + 1])) {
      i += 1;
      continue;
    }
    out[n++] = b;
  }
  return out.subarray(0, n);
}

/** 文件的字节读成文字：认 BOM（UTF-8、UTF-16），不是合法 UTF-8 的按 GB18030；续行先按字节接上 */
export function decodeVcardText(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  const body = unfoldBytes(UTF8_BOM.every((b, i) => bytes[i] === b) ? bytes.subarray(3) : bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    try {
      return new TextDecoder("gb18030").decode(body);
    } catch {
      return new TextDecoder("utf-8").decode(body);
    }
  }
}

/** 文件开头一段像不像 vCard（导入文件夹认文件用；开头 4 KB 里有 BEGIN:VCARD） */
export function looksLikeVcard(head: Buffer): boolean {
  return /^\s*BEGIN:VCARD\s*$/im.test(decodeVcardText(head));
}

/** 在引号外面找第一个 ch */
function indexOutsideQuotes(text: string, ch: string): number {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (c === ch && !quoted) return i;
  }
  return -1;
}

/** 按 sep 拆开（引号里的不拆） */
function splitOutsideQuotes(text: string, sep: string): string[] {
  const out: string[] = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (c === sep && !quoted) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** 这一行属性的名字和参数那一段（冒号前面） */
const headOf = (line: string) => {
  const colon = indexOutsideQuotes(line, ":");
  return colon < 0 ? line : line.slice(0, colon);
};

const isQuotedPrintable = (head: string) => /QUOTED-PRINTABLE/i.test(head);

/** 拆行、接上续行：以空格或 Tab 开头的接到上一行；QUOTED-PRINTABLE 的值行末是 = 的，下一行接上（软换行） */
function unfold(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    const last = lines.length - 1;
    if (last >= 0 && isQuotedPrintable(headOf(lines[last]!)) && lines[last]!.endsWith("=")) {
      lines[last] = lines[last]!.slice(0, -1) + line.replace(/^[ \t]/, "");
    } else if (last >= 0 && (line.startsWith(" ") || line.startsWith("\t"))) {
      lines[last] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines.filter((l) => l.trim() !== "");
}

/** 参数值去掉两头的引号 */
const unquote = (v: string) => (v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);

/** 2.1 里不写名字的参数：编码、字符集之外的都当 TYPE */
const BARE_ENCODINGS = new Set(["QUOTED-PRINTABLE", "BASE64", "8BIT", "7BIT", "B"]);

/** QUOTED-PRINTABLE 解成字节，再按字符集读成文字 */
function decodeQuotedPrintable(raw: string, charset: string | undefined): string {
  const bytes: number[] = [];
  const text = raw.replace(/=\r?\n/g, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (c === "=") {
      // 后面不是两位十六进制的 = 是软换行接上以后剩下的，不要
      continue;
    } else {
      for (const b of Buffer.from(c, "utf8")) bytes.push(b);
    }
  }
  const buffer = Buffer.from(bytes);
  try {
    return new TextDecoder(charset?.toLowerCase() ?? "utf-8").decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

/** 一行拆成属性；认不出的（没有冒号）是 undefined */
function parseLine(line: string): Property | undefined {
  const colon = indexOutsideQuotes(line, ":");
  if (colon <= 0) return undefined;
  const [first = "", ...rest] = splitOutsideQuotes(line.slice(0, colon), ";");
  const dot = first.lastIndexOf(".");
  const group = dot > 0 ? first.slice(0, dot) : undefined;
  const name = (dot > 0 ? first.slice(dot + 1) : first).trim().toUpperCase();
  const params = new Map<string, string[]>();
  const put = (key: string, values: string[]) => params.set(key, [...(params.get(key) ?? []), ...values]);
  for (const part of rest) {
    if (part.trim() === "") continue;
    const eq = indexOutsideQuotes(part, "=");
    if (eq < 0) {
      const bare = part.trim().toUpperCase();
      put(BARE_ENCODINGS.has(bare) ? "ENCODING" : "TYPE", [bare]);
      continue;
    }
    const key = part.slice(0, eq).trim().toUpperCase();
    put(key, splitOutsideQuotes(part.slice(eq + 1), ",").map((v) => unquote(v.trim())));
  }
  let raw = line.slice(colon + 1);
  const encoding = params.get("ENCODING")?.[0]?.toUpperCase();
  if (encoding === "QUOTED-PRINTABLE") raw = decodeQuotedPrintable(raw, params.get("CHARSET")?.[0]);
  else if (encoding === "B" || encoding === "BASE64") raw = "";
  return { ...(group === undefined ? {} : { group: group.toLowerCase() }), name, params, raw };
}

/** 去掉文字里的转义：\n → 换行，\, \; \\ 原样 */
function unescapeText(raw: string): string {
  return raw.replace(/\\([nN,;:\\])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

/** 按没转义的 sep 拆开（N、ADR 的几段，NICKNAME 的几个），每段去掉转义 */
function splitEscaped(raw: string, sep: string): string[] {
  const out: string[] = [];
  let current = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === "\\" && i + 1 < raw.length) {
      current += c + raw[i + 1];
      i += 1;
    } else if (c === sep) {
      out.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  out.push(current);
  return out.map(unescapeText);
}

/** 一行文字：去掉转义、换行换成空格、两头空白去掉 */
const textOf = (raw: string) => unescapeText(raw).replace(/\s*\n\s*/g, " ").trim();

const CJK = /\p{Script=Han}/u;

/** N（姓;名;中间名;前缀;后缀）拼成称呼：带中文的"姓名"连着写，别的"前缀 名 中间名 姓 后缀" */
function nameFromN(raw: string): string {
  const [family = "", given = "", additional = "", prefix = "", suffix = ""] = splitEscaped(raw, ";").map((p) => p.replace(/\s+/g, " ").trim());
  if (CJK.test(family) || CJK.test(given)) return `${family}${given}`.trim();
  return [prefix, given, additional, family, suffix].filter((p) => p !== "").join(" ");
}

/** ADR（邮政信箱;扩展;街道;城市;省;邮编;国家）拼成一行：带中文的从大到小连着写（不写邮编、国家），别的西文的写法 */
function addressFromAdr(raw: string): string {
  const [pobox = "", extended = "", street = "", locality = "", region = "", code = "", country = ""] = splitEscaped(raw, ";").map((p) => p.replace(/\s+/g, " ").trim());
  const all = [pobox, extended, street, locality, region, code, country];
  if (all.some((p) => CJK.test(p))) {
    // 用户常把整段地址填在街道里：被别的一段包含的不再写一遍
    const parts = [region, locality, street, extended, pobox].filter((p) => p !== "");
    return parts.filter((p, i) => !parts.some((other, j) => j !== i && other.includes(p) && (other !== p || j < i))).join("");
  }
  return [pobox, extended, street, locality, [region, code].filter((p) => p !== "").join(" "), country].filter((p) => p !== "").join(", ");
}

/** 苹果、Google 的标准名字（_$!<Anniversary>!$_）写成小写的英文词，别的原样（去掉两头空白） */
export function labelOf(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const text = textOf(raw);
  const standard = /^_\$!<(.+)>!\$_$/.exec(text);
  if (standard) return standard[1]!.trim().toLowerCase();
  return text === "" ? undefined : text;
}

const daysIn = (month: number, year: number | undefined) => (month === 2 ? (year === undefined || (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31);

function validDate(year: number | undefined, month: number, day: number): VcardDate | undefined {
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > daysIn(month, year)) return undefined;
  return year === undefined ? { month, day } : { year, month, day };
}

/**
 * 生日、纪念日的写法认成日子：19900302、1990-03-02（后面带时间的去掉时间）、没有年份的 --0302、--03-02、年份是 0000 的、
 * 苹果的 X-APPLE-OMIT-YEAR（那个年份是占位的）；文字写的"1990年3月2日""3月2日"也认。认不出是 undefined
 */
export function parseVcardDate(raw: string, omitYear?: string): VcardDate | undefined {
  const text = raw.trim();
  const full = /^(\d{4})-?(\d{2})-?(\d{2})(?:$|T)/.exec(text);
  if (full) {
    const year = Number(full[1]);
    const placeholder = year === 0 || (omitYear !== undefined && Number(omitYear) === year);
    return validDate(placeholder ? undefined : year, Number(full[2]), Number(full[3]));
  }
  const noYear = /^--(\d{2})-?(\d{2})$/.exec(text);
  if (noYear) return validDate(undefined, Number(noYear[1]), Number(noYear[2]));
  // @i18n-ignore-next data：认 vCard 里文字写的中文日子
  const written = /^(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?$/u.exec(text);
  if (written) return validDate(written[1] === undefined ? undefined : Number(written[1]), Number(written[2]), Number(written[3]));
  return undefined;
}

/** 日子写成档案里的样子："1990-03-02"，没有年份的 "03-02"（档案认得出这两种，每年提醒按它算） */
export function formatVcardDate(date: VcardDate): string {
  const md = `${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
  return date.year === undefined ? md : `${String(date.year).padStart(4, "0")}-${md}`;
}

/** 电话、住址、关系的类型：TYPE 的几个值（小写）；4.0 的 PREF 参数算 pref */
function typesOf(p: Property): { types: string[]; pref: boolean } {
  const types = (p.params.get("TYPE") ?? []).flatMap((t) => t.split(",")).map((t) => t.trim().toLowerCase()).filter((t) => t !== "");
  return { types, pref: types.includes("pref") || p.params.has("PREF") };
}

/** ANNIVERSARY 那几种（值就是纪念日） */
const ANNIVERSARY_PROPS = new Set(["ANNIVERSARY", "X-ANNIVERSARY", "X-MS-ANNIVERSARY", "X-EVOLUTION-ANNIVERSARY"]);

/** Outlook、Evolution、KAddressBook 写在一张卡上的配偶、上司、助理 */
const RELATED_PROPS: ReadonlyMap<string, string> = new Map([
  ["X-SPOUSE", "spouse"],
  ["X-MS-SPOUSE", "spouse"],
  ["X-EVOLUTION-SPOUSE", "spouse"],
  ["X-KADDRESSBOOK-X-SPOUSESNAME", "spouse"],
  ["X-MS-MANAGER", "manager"],
  ["X-EVOLUTION-MANAGER", "manager"],
  ["X-KADDRESSBOOK-X-MANAGERSNAME", "manager"],
  ["X-MS-ASSISTANT", "assistant"],
  ["X-EVOLUTION-ASSISTANT", "assistant"],
  ["X-KADDRESSBOOK-X-ASSISTANTSNAME", "assistant"],
]);

/** 一张卡片的属性收成联系人；没有称呼的（FN、N、NICKNAME 都没有）是 undefined */
function contactOf(props: readonly Property[]): VcardContact | undefined {
  // 同组的 X-ABLabel：组 → 名字
  const labels = new Map<string, string>();
  for (const p of props) {
    if (p.name === "X-ABLABEL" && p.group !== undefined) {
      const label = labelOf(p.raw);
      if (label !== undefined) labels.set(p.group, label);
    }
  }
  const labelFor = (p: Property) => (p.group === undefined ? undefined : labels.get(p.group));
  let fn = "";
  let n = "";
  let uid: string | undefined;
  let birthday: VcardDate | undefined;
  const nicknames: string[] = [];
  const anniversaries: VcardDated[] = [];
  const phones: VcardTyped[] = [];
  const addresses: VcardTyped[] = [];
  const related: VcardRelated[] = [];
  for (const p of props) {
    const label = labelFor(p);
    const withLabel = label === undefined ? {} : { label };
    const omitYear = p.params.get("X-APPLE-OMIT-YEAR")?.[0];
    switch (p.name) {
      case "FN":
        if (fn === "") fn = textOf(p.raw);
        break;
      case "N":
        if (n === "") n = nameFromN(p.raw);
        break;
      case "UID":
        uid ??= textOf(p.raw) || undefined;
        break;
      case "NICKNAME":
        for (const nick of splitEscaped(p.raw, ",").map((s) => s.replace(/\s+/g, " ").trim())) if (nick !== "" && !nicknames.includes(nick)) nicknames.push(nick);
        break;
      case "BDAY":
        birthday ??= parseVcardDate(textOf(p.raw), omitYear);
        break;
      case "X-ABDATE": {
        const date = parseVcardDate(textOf(p.raw), omitYear);
        if (date) anniversaries.push({ date, ...withLabel });
        break;
      }
      case "X-ABRELATEDNAMES": {
        const name = textOf(p.raw);
        if (name !== "") related.push({ name, types: typesOf(p).types, ...withLabel });
        break;
      }
      case "RELATED": {
        const value = textOf(p.raw);
        const { types } = typesOf(p);
        const isText = (p.params.get("VALUE")?.[0] ?? "").toLowerCase() === "text";
        if (value === "") break;
        if (!isText && /^urn:uuid:/i.test(value)) related.push({ uid: value.replace(/^urn:uuid:/i, ""), types, ...withLabel });
        // 别的网址（mailto:、tel:、http:）认不出是谁，不要
        else if (isText || !/^[a-z][a-z0-9+.-]*:/i.test(value)) related.push({ name: value, types, ...withLabel });
        break;
      }
      case "TEL": {
        const value = textOf(p.raw).replace(/^tel:/i, "");
        if (value !== "") phones.push({ value, ...typesOf(p), ...withLabel });
        break;
      }
      case "ADR": {
        const formatted = addressFromAdr(p.raw);
        const fallback = p.params.get("LABEL")?.[0];
        const value = formatted !== "" ? formatted : fallback === undefined ? "" : textOf(fallback);
        if (value !== "") addresses.push({ value, ...typesOf(p), ...withLabel });
        break;
      }
      default: {
        if (ANNIVERSARY_PROPS.has(p.name)) {
          const date = parseVcardDate(textOf(p.raw), omitYear);
          if (date) anniversaries.push({ date, label: label ?? "anniversary" });
          break;
        }
        const relation = RELATED_PROPS.get(p.name);
        if (relation !== undefined) {
          const name = textOf(p.raw);
          if (name !== "") related.push({ name, types: [relation] });
        }
      }
    }
  }
  const name = fn || n || nicknames[0] || "";
  if (name === "") return undefined;
  return {
    ...(uid === undefined ? {} : { uid }),
    name,
    nicknames: nicknames.filter((nick) => nick !== name),
    ...(birthday === undefined ? {} : { birthday }),
    anniversaries,
    phones,
    addresses,
    related,
  };
}

/** 解析一份 vCard 文件（字节或者已经读成的文字）：每张卡片一个联系人，没有称呼的跳过；嵌在里面的卡片（2.1 的 AGENT）不单算 */
export function parseVcards(input: Buffer | string): VcardContact[] {
  const text = typeof input === "string" ? input : decodeVcardText(input);
  const contacts: VcardContact[] = [];
  let depth = 0;
  let props: Property[] = [];
  for (const line of unfold(text)) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === "BEGIN" && p.raw.trim().toUpperCase() === "VCARD") {
      depth += 1;
      if (depth === 1) props = [];
      continue;
    }
    if (p.name === "END" && p.raw.trim().toUpperCase() === "VCARD") {
      if (depth === 1) {
        const contact = contactOf(props);
        if (contact) contacts.push(contact);
      }
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 1) props.push(p);
  }
  return contacts;
}
