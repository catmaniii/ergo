// 日志是索引不是采集（钩子自己 detach 的服务，管理器本来就拿不到它的输出）：管理器不收集日志，只按需读项目自己的日志文件，
// 以及它自己 spawn 的服务的命令行输出（logs/<id>.out.log）。
//
// 命令行输出太大会被切开（rotate.mjs）：现在这份之外还有 .1 .2 …。读它们用一套「位置」：
// 现在这份从 0 开始，切下来的旧的排在负数上——.1 占 [-size(.1), 0)，.2 在 .1 前面，依此类推。
// 日志页的首屏、往前翻、断线续传都用这套位置，所以现在这份很短时（刚切过、服务刚重启）首屏会接上 .1 的尾巴，
// 往前翻能一直翻进更早的几份。项目自己登记的日志不归管理器切，只有现在这一份（位置全是非负的，和以前一样）。
import fs from 'node:fs';
import path from 'node:path';
import { rotatedFile, MAX_KEEP } from './rotate.mjs';

// 展示日志 = 一个正则漏了就送 key。控制面现在只在本机，
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

/**
 * 一个服务的各份日志：[{ label, file }]。WebUI 的日志页和接入层的 manage.logs 用同一份清单。
 * 管理器托管的服务永远有「命令行输出」这一份：它 spawn 的进程的输出、各个钩子的输出都写在这里。
 * 还没起过也列出来——日志页会等着它出现，起了之后自动开始滚动。
 * rotated：这份由管理器切（rotate.mjs），读的时候要连着切下来的 .1 .2 … 一起看；项目自己的日志没有这个标记。
 */
export function logEntries(sup, svc) {
  const out = (svc.logs || []).map((l) => ({ label: l.label || l.path, file: resolveLogPath(svc, l.path), rotated: false }));
  if (svc.kind !== 'external') out.unshift({ label: '命令行输出', file: sup.st(svc.id).managerLog || sup.outLog(svc.id), rotated: true });
  return out;
}

/** 日志页、/api/logs、manage.logs 该读哪个文件：管理器切的那份就是它本身（现在这份暂时不在也照样能读 .1）；项目的日志可能登记的是目录 */
export function entryFile(entry) {
  if (!entry) return null;
  return entry.rotated ? entry.file : resolveLogFile(entry.file);
}

/**
 * 一份日志的各段，从旧到新：[{ file, n, start, size, exists }]，n = 0 是现在这份，start 是它在「位置」上的起点（见文件头）。
 * rotated 为假（项目自己的日志）时只有现在这一段。现在这份不存在时 size 记 0、exists 为假（刚切完、还没重新建出来）。
 */
export function logSegments(file, { rotated = false } = {}) {
  const segs = [];
  let base = 0;
  if (rotated) {
    for (let n = 1; n <= MAX_KEEP + 1; n++) {
      let size;
      try { size = fs.statSync(rotatedFile(file, n)).size; } catch { break; }
      base -= size;
      segs.unshift({ file: rotatedFile(file, n), n, start: base, size, exists: true });
    }
  }
  let size = 0, exists = false;
  try { size = fs.statSync(file).size; exists = true; } catch {}
  segs.push({ file, n: 0, start: 0, size, exists });
  return segs;
}

/** 文件头的编码和 BOM 长度（见 sniff）；文件读不了按没有 BOM 算 */
function sniffFile(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); return sniff(fd); } catch { return { enc: 'auto', bom: 0 }; } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

/** 切下来的一段读到了头：标一行，告诉看日志的人上面是哪一份 */
function boundaryLine(seg, text) {
  return `${text && !text.endsWith('\n') ? '\n' : ''}----- 日志在这里切开过：以上在 ${path.basename(seg.file)}，以下是接着的一份 -----\n`;
}

/**
 * 读 [start, end) 这一段（「位置」见文件头），跨过切开的地方时把几段接起来，中间标一行。
 * 和 readRange 一样对齐到整行：起点不在某段开头时丢掉第一个不完整的行。
 * rotated 为假时就是 readRange（起点不小于 0）。
 */
export function readSpan(file, start, end, { rotated = false } = {}) {
  if (!rotated) return readRange(file, Math.max(0, start), end);
  let text = '', from = null, enc = 'auto';
  for (const seg of logSegments(file, { rotated })) {
    if (seg.n === 0 && !seg.exists) continue;
    const segEnd = seg.start + seg.size;
    const lo = Math.max(start, seg.start);
    const hi = Math.min(end, segEnd);
    if (hi <= lo) continue;
    const r = readRange(seg.file, lo - seg.start, hi - seg.start);
    if (!r.ok) return r;
    if (from == null) { from = seg.start + r.start; enc = r.enc; }
    text += r.text;
    if (seg.n > 0 && hi === segEnd) text += boundaryLine(seg, text);
  }
  return { ok: true, enc, start: from ?? end, end, text };
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

/**
 * 读文件末尾若干行（老接口 /api/logs、接入层的 manage.logs 在用）。
 * rotated（管理器切的命令行输出）：现在这份不够 maxBytes 时往前接上 .1（再不够接 .2 …）的尾巴，切开的地方标一行。
 */
export function tail(file, { lines = 200, maxBytes = 256 * 1024, rotated = false } = {}) {
  if (rotated) {
    const segs = logSegments(file, { rotated });
    const cur = segs.at(-1);
    if (!cur.exists && segs.length === 1) return { ok: false, why: `读不到日志：${file} 不存在` };
    const r = readSpan(file, Math.max(segs[0].start, cur.size - maxBytes), cur.size, { rotated });
    if (!r.ok) return r;
    let mtime = null;
    try { mtime = fs.statSync(cur.exists ? file : segs.at(-2).file).mtimeMs; } catch {}
    return { ok: true, file, size: cur.size, mtime, lines: r.text.split(/\r?\n/).slice(-lines).join('\n') };
  }
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

/** 文件的身份（NTFS 的文件号）：改名不变，切开后新建的那份是另一个。拿不到（或者文件系统给 0）就是 null */
function fileIdOf(file) {
  try {
    const id = fs.statSync(file, { bigint: true }).ino;
    return id ? String(id) : null;
  } catch { return null; }
}

/** 从 file 的 at 处读最多 len 字节（文件比预想的短就少给） */
function readAt(file, at, len) {
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { return buf.subarray(0, fs.readSync(fd, buf, 0, len, at)); } finally { fs.closeSync(fd); }
}

/**
 * 把一个日志文件以 SSE 推给浏览器：先推末尾（或从 Last-Event-ID 续上），之后跟随增长。
 * 位置（id、start、earliest）用文件头说的那套：管理器切的命令行输出（rotated）里，切下来的旧日志在负数上。
 *
 * 事件：
 *   meta    {file, size, start, enc, earliest}  开始/换文件时发一次；earliest 到 start 之间可以用 /api/logs/range 往前翻
 *   chunk   {text}                     **整行**（以换行结尾），id = 读到的位置，断线重连从这里续
 *   partial {text}                     还没写完的最后一行（进度条、提示符），下一次 chunk 会把它整行重发
 *   rotated {shift, earliest, why}     日志切开了：页面上已有的内容现在在 .1 里，位置整体减 shift（id = 换算后的位置）。
 *                                      没推完的那点接着从 .1 推完、标一行「切开过」，再接新的一份——页面不清屏
 *   reset   {why}                      文件被截断或换了，页面清屏重来
 *   missing {why}                      文件还不存在（服务从没起过），会一直等它出现
 *
 * 只按整行推进位置，是为了脱敏：密钥被拆在两个块里，正则就认不出来了。
 * 半行（partial）只在两种情况下给：写入方停顿了一会儿（提示符），
 * 或者那是 \r 刷新的进度条——只给最后一个**已经写完**的 \r 段。切下来的旧日志不会再长，读到头就整段推完。
 */
export function streamLog(req, res, getFile, { from = null, rotated = false } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');

  // segs：各段（logSegments，带上编码），现在这份在最后；curId：现在这份的身份，用来认出「切开了」
  let file = null, segs = [], curId = null, pos = 0, size = 0, earliest = 0;
  let resumeAt = Number.isFinite(from) ? from : null;
  let missingSent = false, lastPartial = '', remSeenAt = 0, remKey = '';
  let closed = false;

  const send = (event, data, id) => {
    if (closed) return;
    res.write(`${id != null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const survey = (f) => {
    segs = logSegments(f, { rotated }).map((s) => ({ ...s, ...(s.exists ? sniffFile(s.file) : { enc: 'auto', bom: 0 }) }));
    const cur = segs.at(-1);
    size = cur.size;
    curId = cur.exists ? fileIdOf(f) : null;
    earliest = segs[0].start + segs[0].bom;
  };
  const segAt = (p) => segs.find((s) => s.n === 0 || p < s.start + s.size);
  // 位置落到某段的 BOM 里、或 UTF-16 的奇数字节上时挪到能读的地方
  const settle = () => {
    if (pos < earliest) pos = earliest;
    const s = segAt(pos);
    let local = Math.max(pos - s.start, s.bom);
    if (s.enc === 'utf16le' && (local - s.bom) % 2) local += 1;
    pos = s.start + local;
  };

  const open = (f, startAt) => {
    survey(f);
    if (startAt != null && startAt >= earliest && startAt <= size) pos = startAt;
    else {
      // 首屏：末尾 INITIAL_BYTES（现在这份不够就接上切下来的旧日志的尾巴），起点对齐到下一个整行
      pos = Math.max(earliest, size - INITIAL_BYTES);
      settle();
      const s = segAt(pos);
      const local = pos - s.start;
      if (local > s.bom) {
        const head = readAt(s.file, local, Math.max(0, Math.min(64 * 1024, (s.n === 0 ? size : s.size) - local)));
        const k = firstLineEnd(head, s.enc);
        if (k > 0) pos += k;
      }
    }
    settle();
    file = f; lastPartial = ''; remKey = '';
    send('meta', { file: f, size, start: pos, enc: segs.at(-1).enc, earliest });
  };

  const pump = () => {
    if (closed) return;
    try {
      const f = getFile();
      const exists = !!f && fs.existsSync(f);
      // 管理器切的那份：现在这份刚切走、还没重新建出来时，.1 还在就照常读
      if (!f || (!exists && !(rotated && fs.existsSync(rotatedFile(f, 1))))) {
        if (!missingSent) { send('missing', { why: '日志文件还不存在——这个服务还没被管理器启动过，或者还没写出任何东西' }); missingSent = true; }
        file = null;
        return;
      }
      if (missingSent) missingSent = false;
      if (f !== file) {
        if (file) send('reset', { why: `日志换成了新文件：${path.basename(f)}` });
        open(f, file ? null : resumeAt);
        resumeAt = null;
      } else if (rotated) {
        const id = exists ? fileIdOf(f) : null;
        if (id !== curId) {
          const was = curId;
          survey(f);
          const first = segs.find((s) => s.n === 1);
          if (was && first && fileIdOf(first.file) === was) {
            // 切开了：刚才读的那份现在是 .1（改名不换身份）。位置整体往前挪它的大小，没推完的接着从 .1 推
            pos -= first.size;
            remKey = '';
            send('rotated', { shift: first.size, earliest, why: `日志切开了：前面的在 ${path.basename(first.file)}` }, pos);
            // 那份早就推完了（常见：服务停了一会儿才重启）：下面不会再读到它的结尾，「切开过」这一行在这里补上
            if (pos >= 0) send('chunk', { text: boundaryLine(first, '') }, pos);
          } else if (was) {
            send('reset', { why: '日志文件被换掉了，重新读末尾' });
            open(f, null);
          }
          // was 为空：现在这份是刚建出来的（上次切完还没人写），位置不用动
        }
      }
      size = exists ? fs.statSync(f).size : 0;
      const cur = segs.at(-1);
      cur.size = size;
      if (pos > size) {
        send('reset', { why: '日志文件被截断或重写了，从头再读' });
        open(f, cur.bom);
      }
      // 一次 pump 最多推几块，首屏一大份也能很快送完
      for (let guard = 0; guard < 8; guard++) {
        settle();
        const seg = segAt(pos);
        if (seg.n > 0) {
          // 切下来的一段：不会再长了，读到头就把剩下的整段推完（最后一行没换行也推），再标一行「切开过」
          const segEnd = seg.start + seg.size;
          const buf = readAt(seg.file, pos - seg.start, Math.min(CHUNK_BYTES, segEnd - pos));
          if (!buf.length) { survey(f); break; }   // 这份刚被删了（份数满了）：重新看一遍有哪几段
          let cut = pos + buf.length >= segEnd ? buf.length : lastLineEnd(buf, seg.enc);
          if (!cut) cut = seg.enc === 'utf16le' ? buf.length - (buf.length % 2) : buf.length;
          pos += cut;
          let text = mask(decodeBytes(buf.subarray(0, cut), seg.enc));
          if (pos >= segEnd) text += boundaryLine(seg, text);
          send('chunk', { text }, pos);
          lastPartial = '';
          continue;
        }
        if (size <= pos) break;
        const enc = seg.enc;
        const len = Math.min(CHUNK_BYTES, size - pos);
        const buf = readAt(f, pos, len);
        let cut = lastLineEnd(buf, enc);
        // 一整块都没有换行（超长的一行）：硬切，否则会永远卡住
        if (!cut && buf.length === CHUNK_BYTES) cut = enc === 'utf16le' ? buf.length - (buf.length % 2) : buf.length;
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
