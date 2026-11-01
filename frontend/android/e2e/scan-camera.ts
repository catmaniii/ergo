// 相机这条路的联调（364 号票）：scan.ts 经测试入口喂文字，走不到取景和逐帧解码。这里用模拟器的虚拟场景相机：房间墙上挂一张二维码海报，
// 经模拟器的 gRPC 把相机转过去对准，Camera2 的帧经 ZXing 解出地址，再走测试和报错。海报的地址连不上（.invalid，网也关了），所以不需要守护进程。
// 海报要在模拟器启动时给，分三步：
//   node frontend/android/e2e/scan-camera.ts poster <png 的绝对路径>
//   emulator -avd <名字> -port 5570 -grpc 17590 -camera-back virtualscene -virtualscene-poster wall=<png 的绝对路径> -no-snapshot-save
//   npm run build:android -- --webview-debug
//   node frontend/android/e2e/scan-camera.ts run emulator-5570 17590 [截图目录]
// 这是虚拟的房间，光线和对焦都是理想的：过了只说明代码路通，真的屏幕、手抖、反光还要真机。
import http2 from "node:http2";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { findChrome } from "../../../packages/web/build/chrome.ts";
import { QR_QUIET_MODULES, qrMatrix, qrPath } from "../../../packages/web/src/util/qr.ts";
import { expectTrue, Run } from "./harness.ts";
import { Device, PACKAGE } from "./lib.ts";

const POSTER_URL = "https://ergo-poster.invalid/";
const APK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app", "build", "outputs", "apk", "debug", "app-debug.apk");

// 虚拟场景的配置（SDK 的 emulator/resources/Toren1BD.posters）：墙上的海报 2 米见方，朝向 -150 度。这个位置离它约 4 米、正对着，整张码都在画面里
const FACING_POSTER = { position: [-2.483, 0.55, 1.665], rotation: [0, -150, 0] };
const FACING_ROOM = { position: [0, 0, 0], rotation: [0, 0, 0] };

/** PhysicalModelValue（SDK 的 emulator/lib/emulator_controller.proto）：target = 1（0 位置，1 旋转），value = 3 { data = 1（packed float）} */
function physicalModel(target: 0 | 1, values: number[]): Buffer {
  const data = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => data.writeFloatLE(v, i * 4));
  const value = Buffer.concat([Buffer.from([0x0a, data.length]), data]);
  return Buffer.concat([Buffer.from([0x08, target, 0x1a, value.length]), value]);
}

/** 一次 gRPC 调用：node 自带 http2 就够，不为这一个调用加依赖 */
function setPhysicalModel(client: http2.ClientHttp2Session, message: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = client.request({ ":method": "POST", ":path": "/android.emulation.control.EmulatorController/setPhysicalModel", "content-type": "application/grpc", te: "trailers" });
    const frame = Buffer.alloc(5 + message.length);
    frame.writeUInt32BE(message.length, 1);
    message.copy(frame, 5);
    let status: unknown;
    req.on("response", (headers) => {
      status ??= headers["grpc-status"];
    });
    req.on("trailers", (headers) => {
      status = headers["grpc-status"];
    });
    req.on("data", () => {});
    req.on("error", reject);
    req.on("end", () => {
      if (String(status) === "0") resolve();
      else reject(new Error(`模拟器的 gRPC 回了 ${String(status)}：启动时带 -grpc 了吗`));
    });
    req.end(frame);
  });
}

async function aim(grpcPort: string, pose: { position: number[]; rotation: number[] }): Promise<void> {
  const client = http2.connect(`http://127.0.0.1:${grpcPort}`);
  try {
    await setPhysicalModel(client, physicalModel(1, pose.rotation));
    await setPhysicalModel(client, physicalModel(0, pose.position));
  } finally {
    client.close();
  }
}

async function makePoster(file: string): Promise<void> {
  const chrome = findChrome();
  if (!chrome) throw new Error("找不到 Chrome：要用它把二维码画成图");
  const matrix = qrMatrix(POSTER_URL);
  const side = matrix.length + QR_QUIET_MODULES * 2;
  const browser = await chromium.launch({ executablePath: chrome });
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  await page.setContent(`<!doctype html><body style="margin:0;background:#fff"><svg viewBox="0 0 ${side} ${side}" width="1024" height="1024" shape-rendering="crispEdges"><rect width="${side}" height="${side}" fill="#fff"/><path d="${qrPath(matrix)}" fill="#000"/></svg></body>`);
  await page.screenshot({ path: file });
  await browser.close();
}

async function scan(serial: string, grpcPort: string, shotsDir: string | undefined): Promise<number> {
  const device = new Device(serial);
  const run = new Run(device, shotsDir);
  device.shell("svc wifi disable; svc data disable");
  try {
    device.adb("install", "-r", APK);
    device.shell(`pm clear ${PACKAGE}`);
    device.shell(`pm grant ${PACKAGE} android.permission.CAMERA`);
    device.shell("cmd uimode night no");
    await aim(grpcPort, FACING_ROOM);
    device.shell(`am start -n ${PACKAGE}/.MainActivity`);

    await run.step("取景页：相机画面是房间，没有码就一直等，不会乱报", async () => {
      const button = await device.waitText("Scan to connect");
      device.tap(button.x, button.y);
      await device.waitText("Fit the code inside the frame");
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await device.waitText("Fit the code inside the frame", 2000);
      expectTrue(!device.ui().some((n) => n.text.includes("Can't connect")), "没有码的时候没有报错");
      run.shot("android-camera-room");
    });
    await run.step("相机转过去对准海报：解出地址，走测试，报解析不了", async () => {
      await aim(grpcPort, FACING_POSTER);
      await device.waitText(POSTER_URL, 40_000);
      await device.waitText("doesn't resolve", 20_000);
      run.shot("android-camera-decoded");
      const prefs = device.adb("exec-out", "run-as", PACKAGE, "sh", "-c", "cat shared_prefs/*.xml 2>/dev/null; true");
      expectTrue(!prefs.includes('name="server_url"'), "连不上的地址没有记下来");
    });
    return run.finish();
  } finally {
    device.shell("svc wifi enable; svc data enable");
  }
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "poster" && rest[0]) {
  await makePoster(rest[0]);
  process.exit(0);
} else if (mode === "run" && rest[0] && rest[1]) {
  process.exit(await scan(rest[0], rest[1], rest[2]));
} else {
  console.error("用法见文件开头");
  process.exit(2);
}
