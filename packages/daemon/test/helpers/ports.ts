// 端口和配置文件：测试要"端口从配置读"时，先挑一个空闲端口，写进临时数据目录的 config/ergo.json。
// 测试从不占用配置里默认的 8810、8811（LSM 会清掉占用已登记端口的进程）。
import fs from "node:fs";
import net from "node:net";
import { dataDirLayout } from "../../src/config/data-dir.ts";

/** 系统挑一个 127.0.0.1 上的空闲端口（挑完就放开） */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** 本机端口和外网端口各挑一个空闲端口（两个不一样） */
export async function freePorts(): Promise<{ local: number; external: number }> {
  const local = await freePort();
  let external = await freePort();
  while (external === local) external = await freePort();
  return { local, external };
}

/**
 * 测试写进配置文件的语音设置（45 号票起守护进程一起来就预热语音模型）：识别进程的 Python 是占位符（识别不可用，不拉真的 Python）、
 * 合成服务连不上（不碰本机 8090）。像 LSM 那样拉起真入口（main.ts）的测试靠它；startTestDaemon 另有假的识别进程和合成服务，盖过它
 */
export const NO_VOICE_SERVICES_CONFIG = { recognizer: { python: "<测试里不拉真的 Python>" }, speech: { url: "http://127.0.0.1:1" } } as const;

/** 在数据目录里写配置文件，本机端口和外网端口各用一个空闲端口（语音设置是 NO_VOICE_SERVICES_CONFIG），返回两个端口 */
export async function writePortsConfig(dataDir: string): Promise<{ local: number; external: number }> {
  const { local, external } = await freePorts();
  const layout = dataDirLayout(dataDir);
  fs.mkdirSync(layout.config, { recursive: true });
  fs.writeFileSync(layout.configFile, JSON.stringify({ ports: { local, external }, voice: NO_VOICE_SERVICES_CONFIG }));
  return { local, external };
}

/** 同上，只返回本机端口 */
export async function writePortConfig(dataDir: string): Promise<number> {
  return (await writePortsConfig(dataDir)).local;
}
