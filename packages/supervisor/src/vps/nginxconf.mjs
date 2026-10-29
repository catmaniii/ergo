// 读 VPS 上 nginx 的配置（322 号票）：`lsm vps site add` 的体检要看出布局（443 前面有没有 stream 前门、前门后面的站点听哪个地址），
// `lsm vps scan` 要列出已有的站点和证书。都只读：VPS 上跑 `nginx -T`（把 nginx 实际读到的所有文件按顺序打出来），
// 这里把它解析成一棵树，按 include 拼回去，就知道每个 server 是在 http 里还是在 stream 里。
//
// 只认 nginx 配置的基本写法（指令、参数、块、引号、注释），够看出 server_name / listen / proxy_pass / ssl_certificate / map；
// 不求完整（不展开变量、不认 lua 之类的块）。看不懂的就当没有，宁可停下让你自己看，也不猜。

/** `nginx -T` 的输出 → [{ file, text }]（按出现顺序；第一个就是主配置 nginx.conf） */
export function splitDump(text) {
  const files = [];
  let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^# configuration file (.+):$/.exec(line);
    if (m) { cur = { file: m[1], lines: [] }; files.push(cur); continue; }
    if (cur) cur.lines.push(line);
  }
  return files.map((f) => ({ file: f.file, text: f.lines.join('\n') }));
}

/** 切词：单词、引号里的字符串、{ } ;。注释丢掉。每个词带行号。 */
function tokenize(text) {
  const out = [];
  const s = String(text);
  let i = 0, line = 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '#') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '{' || c === '}' || c === ';') { out.push({ t: c, line }); i++; continue; }
    if (c === '"' || c === "'") {
      let v = '';
      i++;
      while (i < s.length && s[i] !== c) {
        if (s[i] === '\\' && i + 1 < s.length) { v += s[i + 1]; i += 2; continue; }
        if (s[i] === '\n') line++;
        v += s[i++];
      }
      i++;
      out.push({ t: 'w', v, line });
      continue;
    }
    let v = '';
    while (i < s.length && !/[\s{};]/.test(s[i])) {
      // 变量的 ${name} 写法里有 {}，跟着单词走
      if (s[i] === '$' && s[i + 1] === '{') { const e = s.indexOf('}', i); if (e > 0) { v += s.slice(i, e + 1); i = e + 1; continue; } }
      v += s[i++];
    }
    out.push({ t: 'w', v, line });
  }
  return out;
}

/** 一个文件 → 指令树：[{ name, args, block?: [...], file, line }] */
export function parseConf(text, file = '') {
  const toks = tokenize(text);
  let i = 0;
  const parseBlock = () => {
    const list = [];
    while (i < toks.length) {
      const tk = toks[i];
      if (tk.t === '}') { i++; return list; }
      if (tk.t !== 'w') { i++; continue; }   // 多余的 ; 或者语法不对：跳过
      const d = { name: tk.v, args: [], file, line: tk.line };
      i++;
      while (i < toks.length && toks[i].t === 'w') d.args.push(toks[i++].v);
      if (i < toks.length && toks[i].t === '{') { i++; d.block = parseBlock(); } else if (i < toks.length && toks[i].t === ';') i++;
      list.push(d);
    }
    return list;
  };
  return parseBlock();
}

const globRe = (pattern) => new RegExp(`^${pattern.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);

/**
 * `nginx -T` 的输出 → 拼好 include 的整棵树（include 换成被包含文件的内容，按文件名排序，和 nginx 一样）。
 * 返回 { tree, files: [{file,text}], main }。没有内容就是空树。
 */
export function parseDump(text) {
  const files = splitDump(text);
  if (!files.length) return { tree: [], files, main: null };
  const main = files[0].file;
  const prefix = main.replace(/[^/]*$/, '');   // /etc/nginx/
  const parsed = new Map(files.map((f) => [f.file, parseConf(f.text, f.file)]));
  const expand = (list, depth) => list.flatMap((d) => {
    if (d.name === 'include' && d.args[0] && depth < 10) {
      const pat = d.args[0].startsWith('/') ? d.args[0] : prefix + d.args[0];
      const re = globRe(pat);
      return files.map((f) => f.file).filter((f) => re.test(f)).toSorted().flatMap((f) => expand(parsed.get(f), depth + 1));
    }
    return [d.block ? { ...d, block: expand(d.block, depth) } : d];
  });
  return { tree: expand(parsed.get(main), 0), files, main };
}

const children = (list, name) => (list || []).filter((d) => d.name === name);
const first = (list, name) => children(list, name)[0];

/** 一个 server 块里我们关心的几样 */
function describeServer(s) {
  const locs = [];
  const walk = (list) => {
    for (const d of list || []) {
      if (d.name === 'proxy_pass' && d.args[0]) locs.push(d.args[0]);
      if (d.block) walk(d.block);
    }
  };
  walk(s.block);
  return {
    file: s.file, line: s.line,
    serverNames: children(s.block, 'server_name').flatMap((d) => d.args),
    listen: children(s.block, 'listen').map((d) => d.args.join(' ')),
    certificate: first(s.block, 'ssl_certificate')?.args[0] || null,
    proxyPass: [...new Set(locs)],
    root: first(s.block, 'root')?.args[0] || null,
    returns: first(s.block, 'return')?.args.join(' ') || null,
  };
}

/** http 里的每个 server（站点） */
export function httpServers(tree) {
  return children(tree, 'http').flatMap((h) => children(h.block, 'server')).map(describeServer);
}

/**
 * 443 前面的 stream 前门：stream 里 ssl_preread on 的 server，它按 map $ssl_preread_server_name $变量 { 域名 去向; } 分流。
 * 没有前门是 null。有但看不懂（proxy_pass 不是那个 map 的变量、map 找不到）时 ok:false + why。
 */
export function frontdoor(tree) {
  const streams = children(tree, 'stream');
  const servers = streams.flatMap((s) => children(s.block, 'server')).filter((s) => children(s.block, 'ssl_preread').some((d) => d.args[0] === 'on'));
  if (!servers.length) return null;
  const srv = servers.find((s) => children(s.block, 'listen').some((d) => /(^|:)443$/.test(d.args[0]))) || servers[0];
  const listen = children(srv.block, 'listen').map((d) => d.args.join(' '));
  const proxyProtocol = children(srv.block, 'proxy_protocol').some((d) => d.args[0] === 'on');
  const pass = first(srv.block, 'proxy_pass')?.args[0] || '';
  const maps = streams.flatMap((s) => children(s.block, 'map')).filter((m) => m.args[0] === '$ssl_preread_server_name');
  const map = maps.find((m) => m.args[1] === pass);
  const base = { listen, proxyProtocol, serverFile: srv.file, pass };
  if (!map) return { ...base, ok: false, why: pass.startsWith('$') ? `前门的 proxy_pass ${pass} 不是按 $ssl_preread_server_name 分流的 map` : `前门的 proxy_pass 是固定的 ${pass || '（没写）'}，不按域名分流` };
  const entries = (map.block || []).filter((d) => d.name !== 'hostnames' && d.name !== 'include').map((d) => ({ name: d.name, to: d.args[0] ?? '' }));
  return {
    ...base, ok: true, mapVar: map.args[1].slice(1), mapFile: map.file, mapLine: map.line,
    entries: entries.filter((e) => e.name !== 'default'),
    default: entries.find((e) => e.name === 'default')?.to || null,
  };
}

/**
 * 前门后面的 nginx 站点听哪个地址（新站点也听它）：http 里 listen 127.0.0.1:<端口> … ssl 的地址，
 * 优先挑前门 map 里出现过的那个、再挑用得最多的；都没有就用 map 的 default（是 127.0.0.1:<端口> 才算）。认不出是 null。
 */
export function frontdoorBackend(tree, fd) {
  const count = new Map();
  for (const s of httpServers(tree)) {
    for (const l of s.listen) {
      const [addr, ...params] = l.split(/\s+/);
      if (/^127\.0\.0\.1:\d+$/.test(addr) && params.includes('ssl')) count.set(addr, (count.get(addr) || 0) + 1);
    }
  }
  const targets = new Set([...(fd?.entries || []).map((e) => e.to), fd?.default].filter(Boolean));
  const ranked = [...count.entries()].toSorted((a, b) => b[1] - a[1]).map(([a]) => a);
  return ranked.find((a) => targets.has(a)) || ranked[0] || (/^127\.0\.0\.1:\d+$/.test(fd?.default || '') ? fd.default : null);
}

/** map 那一行是不是写在一行里（脚本按这一行往下插一行；写成多行的不动，让你自己加） */
export function mapLineOk(files, fd) {
  const f = files.find((x) => x.file === fd.mapFile);
  if (!f) return false;
  const re = new RegExp(`^\\s*map\\s+\\$ssl_preread_server_name\\s+\\$${fd.mapVar}\\s*\\{\\s*(#.*)?$`);
  return f.text.split(/\r?\n/).some((l) => re.test(l));
}
