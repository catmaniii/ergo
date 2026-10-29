// 网页正文抽取（70 号票）：照搬用户 web-search skill 的 fetch.mjs（极简版：去掉脚本、样式这些，块级标签换成换行，剥掉标签，
// 压缩空白），会带少量导航噪声，抓重点就够。纯函数。

/** HTML 实体换回字符（常见的几个命名实体和数字实体） */
export function decodeEntities(s: string): string {
  return (s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d: string) => codePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => codePoint(parseInt(h, 16)));
}

/** 数字实体：码点不合法的原样留空（skill 里 String.fromCodePoint 会抛错，这里不让一个坏实体弄丢整页） */
function codePoint(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

/** 网页的标题和正文纯文本 */
export function htmlToText(html: string): { title: string; text: string } {
  let s = html;
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(s) ?? [])[1];
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|noscript|svg|head|nav|footer|form)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|br|section|article|header)[^>]*>/gi, "\n");
  s = s.replace(/<br[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[ \t]+/gm, "")
    .trim();
  return { title: title ? decodeEntities(title).trim() : "", text: s };
}
