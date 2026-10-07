// 端口和配置文件：测试要"端口从配置读"时，先挑一个空闲端口，写进临时数据目录的 config/ergou.json。
// 测试从不占用配置里默认的 8810（LSM 会清掉占用已登记端口的进程）。
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

/** 在数据目录里写配置文件，本机端口用一个空闲端口（外网端口取下一个），返回本机端口 */
export async function writePortConfig(dataDir: string): Promise<number> {
  const port = await freePort();
  const layout = dataDirLayout(dataDir);
  fs.mkdirSync(layout.config, { recursive: true });
  fs.writeFileSync(layout.configFile, JSON.stringify({ ports: { local: port, external: port + 1 } }));
  return port;
}
