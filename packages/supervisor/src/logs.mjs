// 日志是索引不是采集（钩子自己 detach 的服务，管理器本来就拿不到它的输出）：管理器不收集日志，只按需读项目自己的日志文件，
// 以及它自己 spawn 的服务的命令行输出（logs/<id>.out.log）。
import fs from 'node:fs';
import path from 'node:path';

// 展示日志 = 一个正则漏了就送 key。控制面现在只在本机（用户 2026-10 定的），
// 但这道脱敏不因此撤掉：有的项目配置文件里就明文躺着第三方的 apiKey。
const MASKS = [
  [/\b(sk-[A-Za-z0-9_-]{6,})/g, 'sk-***'],
  [/((?:api[_-]?key|apikey|token|passcode|password|secret|authorization)\s*["']?\s*[:=]\s*["']?)([^\s"',}&]{4,})/gi, '$1***'],
  [/\b([0-9a-f]{32,})\b/gi, '***'],
  [/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, '$1***$2'],
];

export function mask(text) {
  let out = text;
  for (const [re, rep] of MASKS) out = out.replace(re, rep);
  return out;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });
const GBK = new TextDecoder('gbk');

/**
 * 字节 → 文本。一个 .out.log 里常常混着两种编码：node/ssh 写 UTF-8，
 * 而 PowerShell 5.1 被重定向时按系统代码页写——中文机器上是 GBK。
 * 所以逐行判：能按 UTF-8 严格解开就是 UTF-8，解不开就当 GBK。
 * PS 的 `*>` 写的是 UTF-16LE（带 BOM），那种文件整份按 UTF-16 解。
 */
export function decodeBytes(buf, enc) {
  if (enc === 'utf16le') return buf.toString('utf16le');
  let out = '';
  for (let start = 0; start < buf.length;) {
    const nl = buf.indexOf(0x0a, start);
    const end = nl < 0 ? buf.length : nl + 1;
    const line = buf.subarray(start, end);
    try { out += UTF8.decode(line); } catch { out += GBK.decode(line); }
    start = end;
  }
  return out;
}

/** 看文件头判编码：UTF-16LE BOM / UTF-8 BOM / 没有 BOM（逐行自动判）。 */
function sniff(fd) {
  const b = Buffer.alloc(3);
  const n = fs.readSync(fd, b, 0, 3, 0);
  if (n >= 2 && b[0] === 0xff && b[1] === 0xfe) return { enc: 'utf16le', bom: 2 };
  if (n >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { enc: 'auto', bom: 3 };
  return { enc: 'auto', bom: 0 };
}

/** buf 里最后一个换行符之后的位置；没有换行返回 0。UTF-16 的换行是偶数位上的 0A 00。 */
export function lastLineEnd(buf, enc) {
  if (enc === 'utf16le') {
    for (let i = (buf.length - 2) & ~1; i >= 0; i -= 2) {
      if (buf[i] === 0x0a && buf[i + 1] === 0x00) return i + 2;
    }
    return 0;
  }
  const i = buf.lastIndexOf(0x0a);
  return i < 0 ? 0 : i + 1;
}

/** buf 里第一个换行符之后的位置；没有换行返回 -1。 */
function firstLineEnd(buf, enc) {
  if (enc === 'utf16le') {
    for (let i = 0; i + 1 < buf.length; i += 2) if (buf[i] === 0x0a && buf[i + 1] === 0x00) return i + 2;
    return -1;
  }
  const i = buf.indexOf(0x0a);
  return i < 0 ? -1 : i + 1;
}

export function resolveLogPath(svc, rel) {
  return path.isAbsolute(rel) ? rel : path.join(svc.root, rel);
}

/** 有些项目的日志登记的是目录，取里面最新的那个文件。 */
export function resolveLogFile(p) {
  let st;
  try { st = fs.statSync(p); } catch { return null; }
  if (!st.isDirectory()) return p;
  const newest = fs.readdirSync(p)
    .map((f) => { try { const s = fs.statSync(path.join(p, f)); return s.isFile() ? { f, m: s.mtimeMs } : null; } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.m - a.m)[0];
  return newest ? path.join(p, newest.f) : null;
}

/**
 * 读 [start, end) 这一段并对齐到整行：起点不在文件头时，丢掉第一个不完整的行。
 * 「加载更早的」和流的首屏都用它，所以拼起来不会出现半行。
 */
export function readRange(file, start, end) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { enc, bom } = sniff(fd);
    let from = Math.max(start, bom);
    if (enc === 'utf16le' && (from - bom) % 2) from += 1;
    if (end <= from) return { ok: true, enc, start: from, end: Math.max(end, from), text: '' };
    const buf = Buffer.alloc(end - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    let skip = 0;
    if (from > bom) {
      const k = firstLineEnd(buf, enc);
      skip = k < 0 ? buf.length : k;
    }
    return { ok: true, enc, start: from + skip, end, text: mask(decodeBytes(buf.subarray(skip), enc)) };
  } catch (e) {
    return { ok: false, why: `读不到日志：${e.message}` };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

/** 读文件末尾若干行（卡片之外的老接口 /api/logs 仍在用）。 */
export function tail(file, { lines = 200, maxBytes = 256 * 1024 } = {}) {
  const f = resolveLogFile(file);
  if (!f) return { ok: false, why: `读不到日志：${file} 不存在或是空目录` };
  try {
    const st = fs.statSync(f);
    const r = readRange(f, Math.max(0, st.size - maxBytes), st.size);
    if (!r.ok) return r;
    return { ok: true, file: f, size: st.size, mtime: st.mtimeMs, lines: r.text.split(/\r?\n/).slice(-lines).join('\n') };
  } catch (e) {
    return { ok: false, why: `读不到日志：${e.message}` };
  }
}

export const INITIAL_BYTES = 2 * 1024 * 1024;   // 首屏给末尾 2 MB，更早的由页面按需往前翻
const POLL_MS = 600;
const CHUNK_BYTES = 512 * 1024;                  // 单个事件的上限，首屏分几次推，浏览器不会一口噎住
const PARTIAL_IDLE_MS = 800;

/**
 * 把一个日志文件以 SSE 推给浏览器：先推末尾（或从 Last-Event-ID 续上），之后跟随增长。
 *
 * 事件：
 *   meta    {file, size, start, enc}   开始/换文件时发一次；start 之前的内容可以用 /api/logs/range 往前翻
 *   chunk   {text}                     **整行**（以换行结尾），id = 读到的字节位置，断线重连从这里续
 *   partial {text}                     还没写完的最后一行（进度条、提示符），下一次 chunk 会把它整行重发
 *   reset   {why}                      文件被截断或换了，页面清屏重来
 *   missing {why}                      文件还不存在（服务从没起过），会一直等它出现
 *
 * 只按整行推进位置，是为了脱敏：密钥被拆在两个块里，正则就认不出来了。
 * 半行（partial）只在两种情况下给：写入方停顿了一会儿（提示符），
 * 或者那是 \r 刷新的进度条——只给最后一个**已经写完**的 \r 段。
 */
export function streamLog(req, res, getFile, { from = null } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');

  let file = null, enc = 'auto', bom = 0, pos = 0, size = 0;
  let resumeAt = Number.isFinite(from) ? from : null;
  let missingSent = false, lastPartial = '', remSeenAt = 0, remKey = '';
  let closed = false;

  const send = (event, data, id) => {
    if (closed) return;
    res.write(`${id != null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const open = (f, startAt) => {
    const fd = fs.openSync(f, 'r');
    try { ({ enc, bom } = sniff(fd)); } finally { fs.closeSync(fd); }
    size = fs.statSync(f).size;
    let start;
    if (startAt != null && startAt >= bom && startAt <= size) start = startAt;
    else {
      // 首屏：末尾 INITIAL_BYTES，起点对齐到下一个整行
      start = Math.max(bom, size - INITIAL_BYTES);
      if (enc === 'utf16le' && (start - bom) % 2) start += 1;
      if (start > bom) {
        const head = Buffer.alloc(Math.min(64 * 1024, size - start));
        const fd2 = fs.openSync(f, 'r');
        try { fs.readSync(fd2, head, 0, head.length, start); } finally { fs.closeSync(fd2); }
        const k = firstLineEnd(head, enc);
        if (k > 0) start += k;
      }
    }
    file = f; pos = start; lastPartial = ''; remKey = '';
    send('meta', { file: f, size, start: pos, enc });
  };

  const pump = () => {
    if (closed) return;
    try {
      const f = getFile();
      if (!f || !fs.existsSync(f)) {
        if (!missingSent) { send('missing', { why: '日志文件还不存在——这个服务还没被管理器启动过，或者还没写出任何东西' }); missingSent = true; }
        file = null;
        return;
      }
      if (missingSent) missingSent = false;
      if (f !== file) {
        if (file) send('reset', { why: `日志换成了新文件：${path.basename(f)}` });
        open(f, file ? null : resumeAt);
        resumeAt = null;
      }
      size = fs.statSync(f).size;
      if (size < pos) {
        send('reset', { why: '日志文件被截断或重写了，从头再读' });
        open(f, bom);
      }
      // 一次 pump 最多推几块，首屏一大份也能很快送完
      for (let guard = 0; guard < 8 && size > pos; guard++) {
        const len = Math.min(CHUNK_BYTES, size - pos);
        const buf = Buffer.alloc(len);
        const fd = fs.openSync(f, 'r');
        try { fs.readSync(fd, buf, 0, len, pos); } finally { fs.closeSync(fd); }
        let cut = lastLineEnd(buf, enc);
        // 一整块都没有换行（超长的一行）：硬切，否则会永远卡住
        if (!cut && len === CHUNK_BYTES) cut = enc === 'utf16le' ? len - (len % 2) : len;
        if (cut) {
          pos += cut;
          send('chunk', { text: mask(decodeBytes(buf.subarray(0, cut), enc)) }, pos);
          lastPartial = '';
          if (cut === len) continue;
        }
        // 剩下的是还没写完的最后一行
        const rem = buf.subarray(cut);
        const key = `${pos}:${rem.length}`;
        if (key !== remKey) { remKey = key; remSeenAt = Date.now(); }
        const text = decodeBytes(rem, enc);
        const lastCr = text.lastIndexOf('\r');
        let show = '';
        if (lastCr > 0) show = text.slice(text.lastIndexOf('\r', lastCr - 1) + 1, lastCr);   // 进度条：最后一个写完的 \r 段
        else if (Date.now() - remSeenAt >= PARTIAL_IDLE_MS) show = text;                    // 提示符：写入方停下来了
        if (show && show !== lastPartial) { lastPartial = show; send('partial', { text: mask(show) }); }
        break;
      }
    } catch (e) {
      send('missing', { why: `读不到日志：${e.message}` });
      file = null;
    }
  };

  const timer = setInterval(pump, POLL_MS);
  const beat = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, 15000);
  const cleanup = () => { closed = true; clearInterval(timer); clearInterval(beat); };
  req.on('close', cleanup);
  res.on('error', cleanup);
  pump();
}
