// 312 号票：系统里的 ergou 换成了 ergo，兼容期旧名字照样认。旧名字一律从新名字推出来（oldNameOf），这里核对推法，
// 和协议包里认旧名字的几处：事件来源的旧编号、旧名字的网页版本 meta。
import { describe, expect, it } from "vitest";
import { ERGO_EVENT_SOURCE, eventSourceOf, eventTriggerProblems, isNameOrOld, newNameOf, OLD_SPELLING, oldNameOf, webVersionInHtml } from "../src/index.ts";

describe("旧名字的推法", () => {
  it("大小写各自对应：ergo → ergou、Ergo → Ergou、ERGO → ERGOU", () => {
    expect(oldNameOf("ERGO_DATA_DIR")).toBe("ERGOU_DATA_DIR");
    expect(oldNameOf(".ergo")).toBe(".ergou");
    expect(oldNameOf("ergo.db")).toBe("ergou.db");
    expect(oldNameOf("__Host-ergo-device")).toBe("__Host-ergou-device");
    expect(oldNameOf("ergoNative")).toBe("ergouNative");
    expect(oldNameOf("ErgoApp")).toBe("ErgouApp");
    expect(oldNameOf("mcp__ergo__")).toBe("mcp__ergou__");
    expect(oldNameOf("ergo-theme")).toBe(`${OLD_SPELLING}-theme`);
  });

  it("已经是旧名字的、没有 ergo 的不变；newNameOf 换回来", () => {
    expect(oldNameOf("ergou.db")).toBe("ergou.db");
    expect(oldNameOf("folder")).toBe("folder");
    for (const name of ["ERGO_DATA_DIR", ".ergo", "ergo.db", "__Host-ergo-device", "ergoNative", "ErgoApp", "ergo-input"]) expect(newNameOf(oldNameOf(name))).toBe(name);
    expect(newNameOf("projectOps.problem.ergouAction")).toBe("projectOps.problem.ergoAction");
  });

  it("isNameOrOld：新名字和它的旧名字都算", () => {
    expect(isNameOrOld("ergo-input", "ergo-input")).toBe(true);
    expect(isNameOrOld("ergou-input", "ergo-input")).toBe(true);
    expect(isNameOrOld("ergo-inputs", "ergo-input")).toBe(false);
    expect(isNameOrOld(undefined, "ergo-input")).toBe(false);
  });
});

describe("协议包里认旧名字的地方", () => {
  it("事件触发方式里存着的二狗内部事件的旧来源编号照样认", () => {
    expect(eventSourceOf(oldNameOf(ERGO_EVENT_SOURCE))?.id).toBe(ERGO_EVENT_SOURCE);
    expect(eventTriggerProblems({ kind: "event", source: "ergou", events: ["task_done"] })).toEqual([]);
  });

  it("312 号票之前构建的页面（meta 名是旧名字）照样认得出版本号", () => {
    expect(webVersionInHtml('<html><head><meta name="ergou-web-version" content="abc123" /></head></html>')).toBe("abc123");
    expect(webVersionInHtml('<html><head><meta name="ergo-web-version" content="def456" /></head></html>')).toBe("def456");
  });
});
