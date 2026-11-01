// 主切面：连接地址（364 号票）——手机从外面连到二狗用的地址。入口问服务管家（link 协议 §8，这里是替身；真的管理器走一遍在
// test/lsm/link-entries-real.test.ts），服务管家不知道的用户手填。两个端口都是系统挑的，不碰真的 8810 / 8811、不碰真的服务管家。
import fs from "node:fs";
import path from "node:path";
import { type ConnectionAddressesView, type DoctorCheckDataById, HTTP_PATHS } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { startTestDaemon } from "../helpers/daemon.ts";
import { doctorApi } from "../helpers/http.ts";
import { startLsmStandIn } from "../helpers/lsm-stand-in.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const view = async (url: string) => {
  const res = await fetch(`${url}${HTTP_PATHS.connectionAddresses}`);
  expect(res.status).toBe(200);
  return (await res.json()) as ConnectionAddressesView;
};
const post = (url: string, manual: string | null) =>
  fetch(`${url}${HTTP_PATHS.connectionAddresses}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ manual }) });

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** 这个临时环境里连不上真的服务管家：端口写 1，数据目录是空的 */
const noRealManager = () => ({ ERGO_SVC_PORT: "1", LSM_DATA_DIR: makeTempDir() });

describe("连接地址（364 号票）", () => {
  it("新管理器：hello 里说了外网端口和要入口，公网、tailnet 都给；顺序对、打不通的标明；变了推过来", { timeout: 60_000 }, async () => {
    const standIn = await startLsmStandIn({ entries: { entries: [], wrongPort: [] } });
    const td = await startTestDaemon({ env: { ...noRealManager(), ...standIn.env } });
    const hello = await standIn.waitFor((m) => m.type === "hello", "hello");
    expect(hello.features).toContain("entries");
    expect(hello.externalPort).toBe(new URL(td.externalUrl).port === "" ? undefined : Number(new URL(td.externalUrl).port));
    const external = hello.externalPort as number;

    await until(async () => (await view(td.url)).manager === "supported", "管理器算支持");
    expect((await view(td.url)).addresses).toEqual([]);

    // 公网打不通、tailnet 打通了：tailnet 排前面，公网仍然列出、标明打不通
    standIn.setEntries({
      entries: [
        { kind: "public", url: "https://ergo.example.test/", port: external, reachable: false, why: "超时" },
        { kind: "tailnet", url: "https://ergo.tail.example.test/", port: external, reachable: true, why: null },
      ],
      wrongPort: [],
    });
    await until(async () => (await view(td.url)).addresses.length === 2, "入口推过来了");
    expect((await view(td.url)).addresses).toEqual([
      { kind: "tailnet", url: "https://ergo.tail.example.test/", reachable: true },
      { kind: "public", url: "https://ergo.example.test/", reachable: false },
    ]);

    // 公网也通了：公网排回最前（二维码默认用它）
    standIn.setEntries({
      entries: [
        { kind: "public", url: "https://ergo.example.test/", port: external, reachable: true, why: null },
        { kind: "tailnet", url: "https://ergo.tail.example.test/", port: external, reachable: true, why: null },
      ],
      wrongPort: [],
    });
    await until(async () => (await view(td.url)).addresses[0]?.kind === "public", "公网排回最前");

    // 服务管家的网页：从接入端点算的，给设备配对页的链接
    expect((await view(td.url)).managerUrl).toBe(`http://${new URL(standIn.env.LSM_URL!).host}/`);
  });

  it("指向本机端口的入口不出现：管理器放在 wrongPort 的、管理器筛漏了混在 entries 里的，都不给；写进日志和体检", { timeout: 60_000 }, async () => {
    const standIn = await startLsmStandIn({ entries: { entries: [], wrongPort: [] } });
    const lines: string[] = [];
    const td = await startTestDaemon({ env: { ...noRealManager(), ...standIn.env }, log: (line: string) => lines.push(line) });
    const hello = await standIn.waitFor((m) => m.type === "hello", "hello");
    const external = hello.externalPort as number;
    const local = Number(new URL(td.url).port);
    await until(async () => (await view(td.url)).manager === "supported", "管理器算支持");

    standIn.setEntries({
      entries: [
        { kind: "public", url: "https://ok.example.test/", port: external, reachable: true, why: null },
        // 老版本、写错了的管理器把本机端口混在 entries 里：二狗自己再核对一遍
        { kind: "tailnet", url: "https://leak.example.test/", port: local, reachable: true, why: null },
      ],
      wrongPort: [{ kind: "tailnet", url: "https://wrong.example.test/", port: local, reachable: null, why: null }],
    });
    await until(async () => (await view(td.url)).addresses.length === 1, "入口推过来了");
    const shown = await view(td.url);
    expect(shown.addresses.map((a) => a.url)).toEqual(["https://ok.example.test/"]);
    expect(shown.rejected.map((r) => [r.url, r.reason, r.port])).toEqual([
      ["https://leak.example.test/", "wrong_port", local],
      ["https://wrong.example.test/", "wrong_port", local],
    ]);

    // 日志
    await until(() => lines.some((line) => line.includes("https://wrong.example.test/")), "写进日志");
    // 体检：外网入口这一项不健康，修法是专门的那条
    const checks = (await doctorApi.view(td.url)).body.checks;
    const external_ = checks.find((check) => check.id === "external")!;
    expect(external_.ok).toBe(false);
    expect(external_.fix).toBe("doctor.fix.externalRejected");
    expect((external_.data as DoctorCheckDataById["external"]).rejected?.map((r) => r.url)).toEqual(["https://leak.example.test/", "https://wrong.example.test/"]);
  });

  it("不是 https 的入口：手机 App 不认，不放进二维码，写进体检", { timeout: 60_000 }, async () => {
    const standIn = await startLsmStandIn({ entries: { entries: [], wrongPort: [] } });
    const td = await startTestDaemon({ env: { ...noRealManager(), ...standIn.env } });
    const hello = await standIn.waitFor((m) => m.type === "hello", "hello");
    await until(async () => (await view(td.url)).manager === "supported", "管理器算支持");
    standIn.setEntries({ entries: [{ kind: "public", url: "http://ergo.example.test/", port: hello.externalPort, reachable: true, why: null }], wrongPort: [] });
    await until(async () => (await view(td.url)).rejected.length === 1, "入口推过来了");
    const shown = await view(td.url);
    expect(shown.addresses).toEqual([]);
    expect(shown.rejected[0]?.reason).toBe("not_https");
  });

  it("老管理器（welcome 里没有这项能力）：不报错，没有入口，只有手填的；手填的写进配置文件", { timeout: 90_000 }, async () => {
    const standIn = await startLsmStandIn();
    const td = await startTestDaemon({ env: { ...noRealManager(), ...standIn.env } });
    const dataDir = td.dataDir;
    await until(async () => (await view(td.url)).manager === "unsupported", "算老管理器");
    expect((await view(td.url)).addresses).toEqual([]);

    const saved = await post(td.url, " https://frp.example.test:8443/ ");
    expect(saved.status).toBe(200);
    const body = (await saved.json()) as ConnectionAddressesView;
    expect(body.manual).toBe("https://frp.example.test:8443/");
    expect(body.addresses).toEqual([{ kind: "manual", url: "https://frp.example.test:8443/", reachable: null }]);
    const config = JSON.parse(fs.readFileSync(path.join(dataDir, "config", "ergo.json"), "utf8")) as { connection?: unknown };
    expect(config.connection).toEqual({ manualAddress: "https://frp.example.test:8443/" });

    // 体检：手填了也算查到了依据
    const external = (await doctorApi.view(td.url)).body.checks.find((check) => check.id === "external")!;
    expect(external.data).toEqual({ configured: true, kind: "manual" });

    // 去掉：配置文件里整节没了
    expect((await (await post(td.url, null)).json()) as ConnectionAddressesView).toMatchObject({ addresses: [] });
    expect((JSON.parse(fs.readFileSync(path.join(dataDir, "config", "ergo.json"), "utf8")) as { connection?: unknown }).connection).toBeUndefined();
  });

  it("手填的校验：局域网、不是 https、写法不对都回 400 和原因，不写配置；请求体不对也是 400", { timeout: 60_000 }, async () => {
    const td = await startTestDaemon({ env: noRealManager() });
    for (const bad of ["https://192.168.1.5/", "http://frp.example.test/", "https://nas.local/", "ftp://x.example.test/"]) {
      const res = await post(td.url, bad);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message?: string }).message).toBeTruthy();
    }
    const res = await fetch(`${td.url}${HTTP_PATHS.connectionAddresses}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: "x" }) });
    expect(res.status).toBe(400);
    expect((await view(td.url)).manual).toBeUndefined();
  });

  it("二狗不是服务管家拉起的：没接入，不报错，只有手填；配置里写坏的手填地址当没写，不挡启动", { timeout: 60_000 }, async () => {
    const td = await startTestDaemon({ config: { connection: { manualAddress: "http://192.168.1.5" } }, env: noRealManager() });
    expect(await view(td.url)).toEqual({ addresses: [], manager: "disabled", rejected: [] });
  });

  it("配置里写对的手填地址：一启动就有", { timeout: 60_000 }, async () => {
    const td = await startTestDaemon({ config: { connection: { manualAddress: "https://frp.example.test/" } }, env: noRealManager() });
    expect((await view(td.url)).addresses).toEqual([{ kind: "manual", url: "https://frp.example.test/", reachable: null }]);
  });

  it("外网端口上没凭证的请求拿不到地址（别的接口一样要凭证）", { timeout: 60_000 }, async () => {
    const td = await startTestDaemon({ env: noRealManager() });
    const res = await fetch(`${td.externalUrl}${HTTP_PATHS.connectionAddresses}`);
    expect(res.status).toBe(401);
  });
});
