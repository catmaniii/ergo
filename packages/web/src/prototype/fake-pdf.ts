// 原型里现场生成的小 PDF：报告页的 pdf.js 真能画、能选字（不放二进制的样例文件进仓库）。手写最小的 PDF 文件结构：
// - 拉丁字母、数字用 Helvetica（标准 14 字体，不嵌），汉字用不嵌字体的 STSong-Light + UniGB-UCS2-H 编码——
//   中文 PDF 没嵌字体的常见写法，pdf.js 要取 cmaps 里的 UniGB-UCS2-H 才认得出字，画的时候借用系统的中文字体；
// - 勾选行前面的 ✔ 用 ZapfDingbats（pdf.js 要取 standard_fonts 里的 FoxitDingbats）；
// - 标题前面的小方块是一张 CCITT G4 压缩的 16×16 黑白图（当作蒙版、填主色）：pdf.js 不用 WebAssembly 时由
//   jbig2_nowasm_fallback.js 解，页面测试看它画没画出来；
// - encrypted：加一个解不开的加密字典（标准加密，口令校验值是乱填的），pdf.js 打开时要密码；
// - brokenPdf：开头像 PDF、后面没有对象，pdf.js 认不出结构。

/** 一行字：标题、小标题、正文、打勾的一条、灰色的小字 */
export interface FakePdfLine {
  readonly text: string;
  readonly style: "title" | "heading" | "body" | "check" | "note";
}

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 56;

const STYLE: Readonly<Record<FakePdfLine["style"], { size: number; latin: string; gap: number }>> = {
  title: { size: 20, latin: "/F2", gap: 2 },
  heading: { size: 15, latin: "/F2", gap: 1.9 },
  body: { size: 12, latin: "/F1", gap: 1.7 },
  check: { size: 12, latin: "/F1", gap: 1.7 },
  note: { size: 10, latin: "/F1", gap: 1.8 },
};

/** 16×16 全白的 CCITT G4 数据：每行一个 V0（和上一行一样），再一个 EOFB；BlackIs1 时解出来全是 0，当蒙版就是整块涂满 */
const CCITT_SQUARE = new Uint8Array([0xff, 0xff, 0x00, 0x10, 0x01]);

const ascii = (s: string) => new TextEncoder().encode(s);

/** PDF 字面字符串里要转义的：\ ( ) */
const literal = (s: string) => `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;

/** 按 UCS-2 写成十六进制串（UniGB-UCS2-H 的编码就是 UCS-2 大端）；BMP 以外的字跳过 */
const ucs2Hex = (s: string) =>
  `<${[...s]
    .map((c) => c.codePointAt(0)!)
    .filter((cp) => cp <= 0xffff)
    .map((cp) => cp.toString(16).padStart(4, "0"))
    .join("")}>`;

/** 一行字拆成几段：ASCII 可见字符一段用拉丁字体，别的一段用中文字体；每段写一个 Tj，位置跟着字宽往后走 */
function showText(text: string, size: number, latinFont: string): string {
  const runs = text.match(/[\x20-\x7e]+|[^\x20-\x7e]+/g) ?? [];
  return runs.map((run) => (/^[\x20-\x7e]/.test(run) ? `${latinFont} ${size} Tf ${literal(run)} Tj` : `/F3 ${size} Tf ${ucs2Hex(run)} Tj`)).join(" ");
}

/** 一页的内容流 */
function pageContent(lines: readonly FakePdfLine[], footer: string): string {
  const ops = ["0.11 0.13 0.16 rg"];
  let y = PAGE_HEIGHT - MARGIN - 20;
  lines.forEach((line, i) => {
    const { size, latin, gap } = STYLE[line.style];
    // 小标题上面多空一点
    if (line.style === "heading" && i > 0) y -= 10;
    if (line.style === "title") {
      // 标题前面一个小方块（CCITT 图当蒙版，填主色），然后是标题
      ops.push(`q 0.16 0.55 0.53 rg ${size} 0 0 ${size} ${MARGIN} ${y - 2} cm /Im1 Do Q`);
      ops.push(`BT ${MARGIN + size + 10} ${y} Td ${showText(line.text, size, latin)} ET`);
    } else if (line.style === "check") {
      ops.push(`q 0.16 0.55 0.53 rg BT ${MARGIN + 4} ${y} Td /F4 ${size} Tf (4) Tj ET Q`);
      ops.push(`BT ${MARGIN + 24} ${y} Td ${showText(line.text, size, latin)} ET`);
    } else if (line.style === "note") {
      ops.push(`q 0.42 0.45 0.5 rg BT ${MARGIN} ${y} Td ${showText(line.text, size, latin)} ET Q`);
    } else {
      ops.push(`BT ${MARGIN + (line.style === "body" ? 4 : 0)} ${y} Td ${showText(line.text, size, latin)} ET`);
    }
    y -= size * gap;
    if (line.style === "heading" || line.style === "title") y -= 4;
  });
  ops.push(`q 0.42 0.45 0.5 rg BT ${MARGIN} ${MARGIN - 20} Td ${showText(footer, 9, "/F1")} ET Q`);
  return ops.join("\n");
}

/** 拼一个 PDF：对象一个个写，记下各自的位置，最后写交叉引用表和文件尾 */
class PdfWriter {
  private readonly parts: Uint8Array[] = [];
  private length = 0;
  private readonly offsets: number[] = [];

  constructor() {
    // 第二行几个高位字节：告诉别的程序这是二进制文件
    this.push(ascii("%PDF-1.7\n"));
    this.push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  }

  private push(bytes: Uint8Array): void {
    this.parts.push(bytes);
    this.length += bytes.length;
  }

  /** 写第 n 个对象（从 1 数，按顺序写） */
  object(body: string, stream?: Uint8Array): void {
    this.offsets.push(this.length);
    const n = this.offsets.length;
    if (stream === undefined) return this.push(ascii(`${n} 0 obj\n${body}\nendobj\n`));
    this.push(ascii(`${n} 0 obj\n${body}\nstream\n`));
    this.push(stream);
    this.push(ascii("\nendstream\nendobj\n"));
  }

  /** 收尾：交叉引用表、文件尾（trailer 里另加的写在 extra） */
  finish(extra = ""): Uint8Array<ArrayBuffer> {
    const xref = this.length;
    const count = this.offsets.length + 1;
    const rows = this.offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
    this.push(ascii(`xref\n0 ${count}\n0000000000 65535 f \n${rows}trailer\n<< /Size ${count} /Root 1 0 R${extra} >>\nstartxref\n${xref}\n%%EOF\n`));
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

/** 几页字写成一个 PDF；footer(第几页, 共几页) 是每页底下那行小字 */
export function fakePdf(pages: readonly (readonly FakePdfLine[])[], footer: (page: number, total: number) => string, options: { encrypted?: boolean } = {}): Uint8Array<ArrayBuffer> {
  const w = new PdfWriter();
  // 1 目录、2 页树、3–8 字体、9 小方块的图；之后每页两个对象（页、内容流）；加密的最后再加一个加密字典
  const first = 10;
  const kids = pages.map((_, i) => `${first + i * 2} 0 R`).join(" ");
  w.object("<< /Type /Catalog /Pages 2 0 R >>");
  w.object(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  w.object("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  w.object("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  w.object("<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>");
  w.object("<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /FontDescriptor 7 0 R /DW 1000 /W [1 95 500] >>");
  w.object("<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>");
  w.object("<< /Type /Font /Subtype /Type1 /BaseFont /ZapfDingbats >>");
  w.object(`<< /Type /XObject /Subtype /Image /Width 16 /Height 16 /ImageMask true /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns 16 /Rows 16 /BlackIs1 true >> /Length ${CCITT_SQUARE.length} >>`, CCITT_SQUARE);
  const resources = "<< /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 8 0 R >> /XObject << /Im1 9 0 R >> >>";
  pages.forEach((lines, i) => {
    const content = ascii(pageContent(lines, footer(i + 1, pages.length)));
    w.object(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources ${resources} /Contents ${first + i * 2 + 1} 0 R >>`);
    w.object(`<< /Length ${content.length} >>`, content);
  });
  if (!options.encrypted) return w.finish();
  // 标准加密（RC4 40 位）的字典，口令校验值是乱填的：空口令对不上，pdf.js 要密码才肯打开
  const filler = "8f3a51c7e2094bd6a1c35e7f90b24d68".repeat(2);
  w.object(`<< /Filter /Standard /V 1 /R 2 /O <${filler}> /U <${[...filler].toReversed().join("")}> /P -3904 >>`);
  const encryptRef = first + pages.length * 2;
  return w.finish(` /Encrypt ${encryptRef} 0 R /ID [<5f1e2d3c4b5a69788796a5b4c3d2e1f0> <5f1e2d3c4b5a69788796a5b4c3d2e1f0>]`);
}

/** 坏的 PDF：开头像 PDF，后面是一段说明文字，没有任何对象（上传断在半路的样子） */
export function brokenPdf(note: string): Uint8Array<ArrayBuffer> {
  const bytes = new TextEncoder().encode(`%PDF-1.4\n%${note}\n`);
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}
