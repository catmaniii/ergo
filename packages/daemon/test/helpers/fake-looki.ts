// 本机的假 Looki 开放接口（296 号票，只在测试里）：一个只听 127.0.0.1 临时端口的服务，Looki 插件的请求都发到这里
// （createLookiPlugin 的 endpoints），从不连真的 open.looki.tech / open.looki.ai、不用真 Key。
// 剧本照调研（docs/research/38-looki-and-life-data-sources.md 1.3 节）里官方文档的写法：
// - 只读、全部 GET，请求头 X-API-Key；Key 不对回 401；每分钟 60 次，超了回 429（这里由测试拨 mode 模拟）；
// - GET /api/v1/me：账号资料（id、邮箱、姓名、时区、性别、生日、地区）；
// - GET /api/v1/moments?on_date=YYYY-MM-DD：那一天的时刻（id、title、description、media_types、封面文件、date、tz、start_time、end_time；
//   地点在文件上：封面文件的 location），封面文件带 1 小时过期的预签名链接 temporary_url；
// - GET /api/v1/moments/search?query=…&start_date&end_date：按意思搜（这里按标题、描述里有没有这个词）；
// - GET /api/v1/journals?cursor_date&max_days&sort_order：按天分组的日记（type、title、description 摘要、content 全文、recorded_at）；
// - 307 号票（存一份到本地）：GET /api/v1/moments/{id}/files?limit&cursor_id——时刻里的照片、视频、录音（id、media_type、
//   temporary_url、created_at、size、duration、location），一页最多 limit 个，下一页的游标 next_cursor_id；
//   GET /api/v1/for_you/items?group=vlog——AI 生成的每日 vlog（id、type DAILY_VLOG、title、recorded_date、files）；
//   文件的下载链接指向同一个假服务的 /media/…（不带 Key 也能下，和 S3 的预签名链接一样），每列一次发一批新链接；
//   测试拨 expireNext 让接下来几次列出的链接一发出就过期（下载回 403，像 S3 的"Request has expired"），brokenMedia 里的文件下载回 500。
// 官方文档没写清的（成功时外面包不包一层 data、时间是不是带偏移的 ISO、地点在时刻上还是只在文件上、分页参数叫什么）这里各挑一种，
// 插件按宽松的读法写（looki/records.ts、looki/client.ts），等用户拿到 Key 真机核对（296 号票 Comments）。
import http from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";

/** 测试用的 Key（lk- 开头，和真的一样只显示一次；出错原因、日志、事件、网页里都不许出现它） */
export const LOOKI_TEST_KEY = "lk-test-7f3a9c2e5b1d4a6f8e0c";

/** 官方文档里时刻的样子（剧本用） */
export interface FakeLookiMoment {
  id: string;
  title: string;
  description: string;
  media_types: string[];
  cover_file?: { id: string; location?: string | null; created_at: string; temporary_url: string; media_type: string; size: number; duration?: number | null };
  date: string;
  tz: string;
  start_time: string;
  end_time: string;
}

/** 官方文档里日记的样子 */
export interface FakeLookiJournal {
  id: string;
  type: string;
  title: string;
  description: string;
  content: string;
  recorded_at: string;
}

/** 时刻里的一个文件（官方文档的字段；bytes 是编的文件内容） */
export interface FakeLookiFile {
  id: string;
  media_type: "IMAGE" | "VIDEO" | "AUDIO";
  created_at: string;
  location?: string | null;
  size: number;
  duration?: number | null;
  /** 文件内容（下载回这个） */
  bytes: Buffer;
  /** 链接路径上的扩展名 */
  ext: string;
  contentType: string;
}

/** 一个 AI 生成的 vlog（for_you 里的一条） */
export interface FakeLookiVlog {
  id: string;
  type: string;
  title: string;
  description: string;
  recorded_date: string;
  created_at: string;
  file: FakeLookiFile;
}

/** 编一张"照片"：JPEG 的开头、带拍摄时间和地点的 EXIF 段（一段编的字节）、结尾——下载下来要一个字节不差 */
export function fakePhoto(id: string, createdAt: string, location = ""): FakeLookiFile {
  const exif = Buffer.from(`Exif\u0000\u0000DateTimeOriginal=${createdAt};GPS=${location};id=${id}`, "utf8");
  const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 0xff]), exif, Buffer.from(`pixels-of-${id}`), Buffer.from([0xff, 0xd9])]);
  return { id, media_type: "IMAGE", created_at: createdAt, location: location || null, size: bytes.length, bytes, ext: ".jpg", contentType: "image/jpeg" };
}

/** 编一段"视频"（原始视频片段、vlog） */
export function fakeVideo(id: string, createdAt: string): FakeLookiFile {
  const bytes = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftypmp42-video-of-${id}`)]);
  return { id, media_type: "VIDEO", created_at: createdAt, size: bytes.length, duration: 12, bytes, ext: ".mp4", contentType: "video/mp4" };
}

export interface FakeLookiRequest {
  path: string;
  query: Record<string, string>;
  /** 请求头里的 X-API-Key（断言 Key 只发给认得的地址；测试里一律是假的） */
  key: string | undefined;
}

/** 假接口现在怎么回：照常、Key 失效（一律 401）、限速（一律 429）、那边出错（500） */
export type FakeLookiMode = "ok" | "revoked" | "rate_limited" | "down";

export interface FakeLooki {
  /** 这个假服务的接口地址（插件的 endpoints 填它） */
  base: string;
  requests: FakeLookiRequest[];
  /** 每一天的时刻（测试往里放） */
  moments: Map<string, FakeLookiMoment[]>;
  journals: FakeLookiJournal[];
  mode: FakeLookiMode;
  /** 只限速接下来的几次（之后照常）；mode 是 rate_limited 时一直限 */
  rateLimitNext: number;
  /** /journals 回 422（模拟参数和官方文档对不上） */
  journalsRejected: boolean;
  /** 每个时刻的文件（307 号票；测试往里放） */
  files: Map<string, FakeLookiFile[]>;
  /** 列文件一页最多几个（测试拨小了测翻页） */
  filesPageSize: number;
  /** AI 生成的 vlog */
  vlogs: FakeLookiVlog[];
  /** 接下来几次列文件、列 vlog 发出的链接一发出就过期 */
  expireNext: number;
  /** 这些文件一下载就回 500 */
  brokenMedia: Set<string>;
  /** 下载成功的文件 id（按先后；断言不重下） */
  downloads: string[];
  /** 下载请求里带着 X-API-Key 的次数（Key 只许发给开放接口，不许发给文件链接） */
  mediaWithKey: number;
  /** 带着 Key 的请求 */
  keyed(): FakeLookiRequest[];
}

/** 一个时刻（官方文档的字段；地点放在封面文件上） */
export function fakeMoment(input: { id: string; date: string; start: string; end: string; title: string; description: string; location?: string; media?: string[] }): FakeLookiMoment {
  return {
    id: input.id,
    title: input.title,
    description: input.description,
    media_types: input.media ?? ["IMAGE"],
    cover_file: {
      id: `file-${input.id}`,
      location: input.location ?? null,
      created_at: `${input.date}T${input.start}:00+08:00`,
      temporary_url: `https://cdn.looki.example/${input.id}.jpg?X-Amz-Signature=expires-in-one-hour`,
      media_type: "IMAGE",
      size: 482_113,
    },
    date: input.date,
    tz: "Asia/Shanghai",
    start_time: `${input.date}T${input.start}:00+08:00`,
    end_time: `${input.date}T${input.end}:00+08:00`,
  };
}

const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

/** 起一个假 Looki（用例结束时关掉） */
export async function startFakeLooki(options: { key?: string } = {}): Promise<FakeLooki> {
  const key = options.key ?? LOOKI_TEST_KEY;
  const state: Omit<FakeLooki, "base" | "keyed"> = {
    requests: [],
    moments: new Map(),
    journals: [],
    mode: "ok",
    rateLimitNext: 0,
    journalsRejected: false,
    files: new Map(),
    filesPageSize: 100,
    vlogs: [],
    expireNext: 0,
    brokenMedia: new Set(),
    downloads: [],
    mediaWithKey: 0,
  };
  /** 发出去的链接：签名 → 哪个文件、过期了没有 */
  const issued = new Map<string, { file: FakeLookiFile; expired: boolean }>();
  let signature = 0;
  let origin = "";
  /** 这一批链接（列一次发一批） */
  const linker = () => {
    const expired = state.expireNext > 0;
    if (expired) state.expireNext -= 1;
    return (file: FakeLookiFile) => {
      const sig = `sig${++signature}`;
      issued.set(sig, { file, expired });
      return `${origin}/media/${encodeURIComponent(file.id)}${file.ext}?X-Amz-Expires=3600&X-Amz-Signature=${sig}`;
    };
  };
  const fileView = (file: FakeLookiFile, link: (f: FakeLookiFile) => string) => ({
    id: file.id,
    media_type: file.media_type,
    created_at: file.created_at,
    location: file.location ?? null,
    size: file.size,
    duration: file.duration ?? null,
    temporary_url: link(file),
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const query = Object.fromEntries(url.searchParams);
    const apiKey = typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined;
    // 文件链接（预签名，不要 Key）：不记进接口请求、不限速
    if (url.pathname.startsWith("/media/")) {
      if (apiKey !== undefined) state.mediaWithKey += 1;
      const hit = issued.get(query["X-Amz-Signature"] ?? "");
      if (!hit) return json(res, 403, { error: "SignatureDoesNotMatch" });
      if (hit.expired) {
        res.writeHead(403, { "content-type": "application/xml" });
        return res.end("<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>");
      }
      if (state.brokenMedia.has(hit.file.id)) return json(res, 500, { error: "InternalError" });
      state.downloads.push(hit.file.id);
      res.writeHead(200, { "content-type": hit.file.contentType, "content-length": String(hit.file.bytes.length) });
      return res.end(hit.file.bytes);
    }
    state.requests.push({ path: url.pathname, query, key: apiKey });
    if (req.method !== "GET") return json(res, 405, { detail: "Method Not Allowed" });
    if (state.mode === "down") return json(res, 500, { detail: "Internal Server Error" });
    if (state.mode === "rate_limited" || state.rateLimitNext > 0) {
      if (state.rateLimitNext > 0) state.rateLimitNext -= 1;
      return json(res, 429, { detail: "Rate limit exceeded: 60 per 1 minute" }, { "retry-after": "60" });
    }
    if (state.mode === "revoked" || apiKey !== key) return json(res, 401, { detail: "Invalid or missing API key" });
    switch (url.pathname) {
      case "/api/v1/me":
        return json(res, 200, { data: { id: "u-8812", email: "dongdong@example.com", name: "东东", timezone: "Asia/Shanghai", gender: "male", birthday: "1990-05-01", region: "CN" } });
      case "/api/v1/moments": {
        if (!query.on_date) return json(res, 422, { detail: "on_date is required" });
        return json(res, 200, { data: state.moments.get(query.on_date) ?? [] });
      }
      case "/api/v1/moments/search": {
        const q = query.query ?? "";
        if (q.length < 1 || q.length > 100) return json(res, 422, { detail: "query must be 1-100 characters" });
        const all = [...state.moments.entries()].filter(([date]) => (!query.start_date || date >= query.start_date) && (!query.end_date || date <= query.end_date)).flatMap(([, list]) => list);
        return json(res, 200, { data: { items: all.filter((m) => m.title.includes(q) || m.description.includes(q)), next_cursor: null } });
      }
      case "/api/v1/journals": {
        if (state.journalsRejected) return json(res, 422, { detail: [{ loc: ["query", "cursor_date"], msg: "field required" }] });
        const cursor = query.cursor_date;
        const days = Math.min(31, Number(query.max_days ?? "7"));
        const inRange = (date: string) => {
          if (!cursor) return true;
          const end = new Date(`${cursor}T00:00:00Z`).getTime();
          const at = new Date(`${date}T00:00:00Z`).getTime();
          return at <= end && at > end - days * 86_400_000;
        };
        const byDay = new Map<string, FakeLookiJournal[]>();
        for (const j of state.journals) {
          const date = j.recorded_at.slice(0, 10);
          if (inRange(date)) byDay.set(date, [...(byDay.get(date) ?? []), j]);
        }
        const groups = [...byDay.entries()].map(([date, journals]) => ({ date, journals })).toSorted((a, b) => (query.sort_order === "asc" ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)));
        return json(res, 200, { data: groups });
      }
      case "/api/v1/for_you/items": {
        const link = linker();
        const items = state.vlogs
          .filter(() => query.group === undefined || query.group === "all" || query.group === "vlog")
          .map((v) => ({ id: v.id, type: v.type, title: v.title, description: v.description, content: "", recorded_date: v.recorded_date, created_at: v.created_at, files: [fileView(v.file, link)] }));
        return json(res, 200, { data: { items, next_cursor: null } });
      }
      default: {
        const filesOf = /^\/api\/v1\/moments\/([^/]+)\/files$/.exec(url.pathname);
        if (filesOf) {
          const all = state.files.get(decodeURIComponent(filesOf[1]!));
          if (!all) return json(res, 404, { detail: "Moment not found" });
          const limit = Math.min(100, Number(query.limit ?? "20"), state.filesPageSize);
          const start = query.cursor_id === undefined ? 0 : all.findIndex((f) => f.id === query.cursor_id) + 1;
          const page = all.slice(start, start + limit);
          const link = linker();
          const more = start + limit < all.length;
          return json(res, 200, { data: { items: page.map((f) => fileView(f, link)), next_cursor_id: more ? page.at(-1)!.id : null } });
        }
        return json(res, 404, { detail: "Not Found" });
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
  const base = `${origin}/api/v1`;
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const fake = state as FakeLooki;
  fake.base = base;
  fake.keyed = () => state.requests.filter((r) => r.key !== undefined);
  return fake;
}
