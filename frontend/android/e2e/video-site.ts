// 网页视频真全屏（票 407）联调用的小网站，安卓（video-fullscreen.ts）、鸿蒙（frontend/harmony/e2e/video-fullscreen.ts）共用：
// 一页两段 <video controls>（横的 640x360、竖的 360x640），/api/access 回得像二狗（App 扫码连接时要测这个），视频支持 Range。
// 测试视频用 ffmpeg 现生成（几秒的 H.264），不从网上取。只听 127.0.0.1，模拟器经 adb reverse / hdc rport 过来。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

/** 现生成一段测试视频（H.264、moov 在前，6 秒） */
function makeVideo(dir: string, name: string, width: number, height: number): string {
  const file = path.join(dir, name);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc=size=${width}x${height}:rate=25:duration=6`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "baseline", "-movflags", "+faststart", file]);
  return file;
}

const PAGE = `<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>video fullscreen</title>
<style>body{margin:0;font:16px sans-serif;background:#f4f4f4;color:#222}p{margin:12px}video{display:block;background:#000;margin:0 12px}#land{width:calc(100% - 24px)}#port{width:40%}</style>
<p>横视频 640x360</p><video id="land" controls playsinline preload="metadata" src="/landscape.mp4"></video>
<p>竖视频 360x640</p><video id="port" controls playsinline preload="metadata" src="/portrait.mp4"></video>
<script>if (window.ergoNative) window.ergoNative.appVersion();</script>`;

export interface VideoSite {
  origin: string;
  port: number;
  close(): void;
}

/** 生成两段视频、起网站；close 时连临时目录一起删 */
export function startVideoSite(): Promise<VideoSite> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ergo-video-e2e-"));
  const videos: Record<string, string> = {
    "/landscape.mp4": makeVideo(dir, "landscape.mp4", 640, 360),
    "/portrait.mp4": makeVideo(dir, "portrait.mp4", 360, 640),
  };
  console.log(`测试视频：横 ${statSync(videos["/landscape.mp4"]!).size} 字节、竖 ${statSync(videos["/portrait.mp4"]!).size} 字节`);
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = (req.url ?? "/").split("?")[0]!;
      if (url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE);
        return;
      }
      if (url === "/api/access") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"access":"none"}');
        return;
      }
      const file = videos[url];
      if (!file) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      const body = readFileSync(file);
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
        res.writeHead(206, { "content-type": "video/mp4", "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${body.length}`, "content-length": String(end - start + 1) });
        res.end(body.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, { "content-type": "video/mp4", "accept-ranges": "bytes", "content-length": String(body.length) });
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        port,
        close() {
          server.closeAllConnections();
          server.close();
          rmSync(dir, { recursive: true, force: true });
        },
      });
    });
  });
}

/** 页面里：像用户点了全屏按钮一样（要带用户手势）让一段视频静音开始放、进全屏 */
export function enterFullscreenScript(id: string): string {
  return `(async () => { const v = document.getElementById(${JSON.stringify(id)}); v.muted = true; await v.play().catch(() => {}); await v.requestFullscreen(); return true; })()`;
}
