// HTTP 接口的路径：怎么拼（HTTP_PATHS）和怎么拆（parseHttpPath）只写在协议包里，两边对得上。
import { describe, expect, it } from "vitest";
import { attachmentPartFrom, HTTP_PATHS, HTTP_QUERY, imagePartFrom, parseHttpPath } from "../src/index.ts";

const pathOf = (url: string) => new URL(url, "http://127.0.0.1:8810").pathname;
const queryOf = (url: string) => Object.fromEntries(new URL(url, "http://127.0.0.1:8810").searchParams);

describe("HTTP 接口的路径", () => {
  it("拼出来的路径拆得回去：接口和参数一样", () => {
    expect(parseHttpPath(pathOf(HTTP_PATHS.uploads))).toEqual({ route: "uploads" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.upload("u-1")))).toEqual({ route: "upload", uploadId: "u-1" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.uploadChunk("u-1", 1024)))).toEqual({ route: "upload", uploadId: "u-1" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.uploadComplete("u-1")))).toEqual({ route: "upload_complete", uploadId: "u-1" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.media("a".repeat(64), { name: "报告 v2.pdf", download: true })))).toEqual({ route: "media", mediaId: "a".repeat(64) });
    expect(parseHttpPath(pathOf(HTTP_PATHS.history("maintainer:记忆系统", { before: 21 })))).toEqual({ route: "history", conversation: "maintainer:记忆系统" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.assistantName))).toEqual({ route: "assistant_name" });
  });

  it("查询参数用 HTTP_QUERY 里的名字", () => {
    expect(queryOf(HTTP_PATHS.uploadChunk("u-1", 1024))).toEqual({ [HTTP_QUERY.offset]: "1024" });
    expect(queryOf(HTTP_PATHS.media("a".repeat(64), { name: "报告 v2.pdf", download: true }))).toEqual({ [HTTP_QUERY.name]: "报告 v2.pdf", [HTTP_QUERY.download]: "1" });
    expect(queryOf(HTTP_PATHS.media("a".repeat(64)))).toEqual({});
    expect(queryOf(HTTP_PATHS.history("secretary", { before: 21, limit: 5 }))).toEqual({ [HTTP_QUERY.before]: "21", [HTTP_QUERY.limit]: "5" });
  });

  it("不是 HTTP 接口的路径拆不出来", () => {
    for (const p of ["/", "/ws", "/healthz", "/api/", "/api/nope", "/api/uploads/", "/api/uploads/u/x", "/api/media", "/api/conversations/secretary", "/api/conversations/secretary/messages/1", "/api/uploads/%E0%A4%A"]) {
      expect({ path: p, route: parseHttpPath(p) }).toEqual({ path: p, route: undefined });
    }
  });
});

describe("拼附件 part", () => {
  it("图片 part：宽高有就带上，没有就不写", () => {
    expect(imagePartFrom({ mediaId: "m", name: "a.png", mime: "image/png", width: 3, height: 2 })).toEqual({ type: "image", mediaId: "m", name: "a.png", mime: "image/png", width: 3, height: 2 });
    expect(imagePartFrom({ mediaId: "m", name: "a.png", mime: "image/png", width: undefined })).toEqual({ type: "image", mediaId: "m", name: "a.png", mime: "image/png" });
  });

  it("入库后的媒体：服务端认出是图片的发图片 part，其余发文件 part", () => {
    expect(attachmentPartFrom({ mediaId: "m", kind: "image", name: "a.png", mime: "image/png", size: 9, width: 3, height: 2 })).toEqual({ type: "image", mediaId: "m", name: "a.png", mime: "image/png", width: 3, height: 2 });
    expect(attachmentPartFrom({ mediaId: "m", kind: "file", name: "a.heic", mime: "image/heic", size: 9 })).toEqual({ type: "file", mediaId: "m", name: "a.heic", mime: "image/heic", size: 9 });
  });
});
