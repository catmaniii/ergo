// 从 GitHub 装 skill（465）的测试底座：假的下载那一层（Transport），按下载地址回事先放好的压缩包、HTTP 状态、连不上、一直不回；
// 现做 GitHub 那样的源码压缩包（全局 pax 头里写提交号，顶上一层 <仓库>-<ref>/）。绝不连真网络。
import type { IncomingHttpHeaders } from "node:http";
import type { Transport, TransportResponse } from "../../src/components/transport.ts";
import { makeTar, type TarItem } from "./fake-downloads.ts";

/** 一个地址怎么回 */
export type FakeReply =
  | { status: number; body?: Buffer | string; headers?: IncomingHttpHeaders }
  /** 连不上（transport 直接抛） */
  | { error: string }
  /** 一直不回，直到被中止 */
  | { hang: true }
  /** 回 200，给 bytes 个字节以后断开 */
  | { cut: Buffer };

export interface FakeGithub {
  transport: Transport;
  /** 收到的请求地址（按先后） */
  requests: string[];
  /** 放一个地址的回答（没放的回 404） */
  reply(url: string, reply: FakeReply): void;
}

export function fakeGithub(): FakeGithub {
  const replies = new Map<string, FakeReply>();
  const requests: string[] = [];
  const transport: Transport = async (url, request) => {
    requests.push(url);
    const reply = replies.get(url) ?? { status: 404, body: "Not Found" };
    if ("error" in reply) throw new Error(reply.error);
    if ("hang" in reply) {
      return new Promise<never>((_, reject) => {
        if (request.signal.aborted) reject(request.signal.reason);
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      });
    }
    const state = { destroyed: false };
    if ("cut" in reply) {
      const data = reply.cut;
      const body = (async function* () {
        yield data;
        throw new Error("socket hang up");
      })();
      return { status: 200, headers: {}, body, url, destroy: () => {} } satisfies TransportResponse;
    }
    const data = typeof reply.body === "string" ? Buffer.from(reply.body) : (reply.body ?? Buffer.alloc(0));
    const body = (async function* () {
      // 一块一块给（64 KB 一块），看大小上限是边收边数的
      for (let i = 0; i < data.length; i += 65536) {
        if (state.destroyed) return;
        yield data.subarray(i, i + 65536);
      }
    })();
    return {
      status: reply.status,
      headers: reply.headers ?? { "content-length": String(data.length) },
      body,
      url,
      destroy: () => {
        state.destroyed = true;
      },
    } satisfies TransportResponse;
  };
  return { transport, requests, reply: (url, r) => replies.set(url, r) };
}

/** 压缩包里的一项：内容；{ symlink } 是链接；{ dir } 是空目录 */
export type RepoFile = string | Buffer | { symlink: true } | { dir: true };

/** GitHub 那样的源码压缩包：全局 pax 头（comment=<提交号>）、顶上一层 top/、各项 */
export function githubArchive(top: string, files: Record<string, RepoFile>, commit?: string): Buffer {
  const items: TarItem[] = [];
  if (commit) items.push({ path: "", type: "global", records: { comment: commit } });
  items.push({ path: `${top}/`, type: "dir" });
  for (const [rel, content] of Object.entries(files)) {
    const p = `${top}/${rel}`;
    if (typeof content === "object" && !Buffer.isBuffer(content)) items.push("symlink" in content ? { path: p, type: "symlink" } : { path: `${p}/`, type: "dir" });
    else items.push({ path: p, body: content, ...(p.length > 99 ? { pax: true } : {}) });
  }
  return makeTar(items, true);
}

/** 一个 SKILL.md */
export function skillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n照着做。\n`;
}
