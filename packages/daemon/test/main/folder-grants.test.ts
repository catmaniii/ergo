// 主切面：目录授权（ADR-0049）。真实装配路径（startTestDaemon），假模型；登记的目录是临时目录。
// - 设置接口登记了只读：秘书读那个目录不再问（对话审批开着也一样），使用记录里查得到谁、什么时候、哪个路径、读了多少字节；
//   写同一个目录照旧拦下，说明里写"登记了只读，没登记写"；
// - 对话审批关着时秘书写草稿区之外照旧要用户授权：审批卡上多一个"以后都允许"，点了把目录按这次要的操作登记成长期授权、
//   这一次接着写；之后同一个目录的写不再问，记进使用记录；
// - 设置接口：加的不对回 400 和原因，删、清掉都回改完的一份。
import fs from "node:fs";
import path from "node:path";
import { type ApprovalCardPayload, CHANNELS, type FolderGrantsView, type FolderGrantUsesView, HTTP_PATHS, type ToolCallDetail } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { requestJson } from "../helpers/http.ts";
import { call, cardWhere, latestCards, ok, real, say, toolCallsOf, turnsOf } from "../helpers/task-flow.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const SECRETARY = CHANNELS.secretary;
const ALL = { [SECRETARY]: 0, [CHANNELS.cards]: 0, [CHANNELS.inbox]: 0 };

/** 一个登记用的目录（真实路径）和里面一个文件 */
function notesDir() {
  const notes = real(makeTempDir("ergo-grant-notes-"));
  const a = path.join(notes, "a.txt");
  fs.writeFileSync(a, "读书笔记：第一章");
  return { notes, a };
}

const grantsOf = async (url: string) => (await requestJson<FolderGrantsView>(url, HTTP_PATHS.folderGrants)).body;
const usesOf = async (url: string) => (await requestJson<FolderGrantUsesView>(url, HTTP_PATHS.folderGrantUses())).body.uses;

describe("目录授权", () => {
  it("登记了只读：读不问、记使用记录；写照旧拦下，说明写登记了只读", { timeout: 90_000 }, async () => {
    const { notes, a } = notesDir();
    const b = path.join(notes, "b.txt");
    const td = await startTestDaemon({
      config: { guard: { conversationApprovals: "on" } },
      secretary: [call("read", { path: a }), say("读完了"), call("write", { path: b, content: "x" }), say("写不了")],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe(ALL);

    const added = await requestJson<FolderGrantsView>(td.url, HTTP_PATHS.folderGrants, { method: "POST", body: { agentId: "secretary", path: notes, modes: ["read"], note: "整理读书笔记" } });
    expect(added.status).toBe(200);
    expect(added.body.grants).toMatchObject([{ agentId: "secretary", path: notes, modes: ["read"], note: "整理读书笔记", addedBy: "user", state: "active" }]);

    await frontend.sendText("读一下笔记");
    await turnsOf(frontend, SECRETARY, 1);
    const [read] = toolCallsOf(frontend, SECRETARY);
    expect(read).toMatchObject({ tool: "read", outcome: "done" });
    expect(latestCards(frontend).filter((c) => c.type === "approval")).toEqual([]);
    const uses = await usesOf(td.url);
    expect(uses).toMatchObject([{ agentId: "secretary", grantId: added.body.grants[0]!.id, dir: notes, path: a, mode: "read", tool: "read", viaShell: false }]);
    expect(uses[0]!.bytes).toBeGreaterThan(0);
    expect(uses[0]!.agentLabel).toBeDefined();

    await frontend.sendText("写一个");
    await turnsOf(frontend, SECRETARY, 2);
    const write = toolCallsOf(frontend, SECRETARY).at(-1)! as ReturnType<typeof toolCallsOf>[number] & { callId: string };
    expect(write).toMatchObject({ tool: "write", outcome: "blocked", blockedBy: "hard_refusal" });
    // 模型收到的说明（完整的）写明为什么没放开
    const detail = await requestJson<ToolCallDetail>(td.url, HTTP_PATHS.toolCall(write.callId));
    expect(detail.body.result).toContain(`${notes} 登记了只读，没登记写`);
    expect(fs.existsSync(b)).toBe(false);
  });

  it("审批卡上点“以后都允许”：登记目录、这次接着写；之后同一个目录的写不再问", { timeout: 90_000 }, async () => {
    const { notes } = notesDir();
    const b = path.join(notes, "b.txt");
    const c = path.join(notes, "c.txt");
    const td = await startTestDaemon({
      config: { guard: { conversationApprovals: "off" } },
      secretary: [call("write", { path: b, content: "一" }), say("写好了"), call("write", { path: c, content: "二" }), say("又写好了")],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe(ALL);

    await frontend.sendText("写一个");
    const card = await cardWhere(frontend, (x) => x.type === "approval" && x.status === "pending", "审批卡");
    expect((card.payload as ApprovalCardPayload).folderGrant).toEqual({ path: notes, modes: ["write"] });
    ok(await frontend.cardAction({ cardId: card.id, action: "allow_folder", expectedVersion: card.version }));
    await turnsOf(frontend, SECRETARY, 1);
    expect(fs.readFileSync(b, "utf8")).toBe("一");
    const view = await grantsOf(td.url);
    expect(view.grants).toMatchObject([{ agentId: "secretary", path: notes, modes: ["write"], addedBy: "approval", state: "active" }]);
    expect(view.grants[0]!.expiresAt).toBeUndefined();

    await frontend.sendText("再写一个");
    await turnsOf(frontend, SECRETARY, 2);
    expect(fs.readFileSync(c, "utf8")).toBe("二");
    expect(latestCards(frontend).filter((x) => x.type === "approval")).toHaveLength(1);
    expect((await usesOf(td.url)).map((u) => [u.path, u.mode, u.bytes])).toEqual([[c, "write", Buffer.byteLength("二")]]);
  });

  it("设置接口：不对的回 400 和原因；删、清掉回改完的一份", { timeout: 60_000 }, async () => {
    const { notes } = notesDir();
    const td = await startTestDaemon({ secretary: [] });
    const bad = await requestJson<{ error: { message: string } }>(td.url, HTTP_PATHS.folderGrants, { method: "POST", body: { agentId: "secretary", path: "notes", modes: ["read"] } });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain("完整的路径");
    const noTable = await requestJson(td.url, HTTP_PATHS.folderGrants, { method: "POST", body: { agentId: "sa-9", path: notes, modes: ["read"] } });
    expect(noTable.status).toBe(400);
    const added = await requestJson<FolderGrantsView>(td.url, HTTP_PATHS.folderGrants, { method: "POST", body: { agentId: "secretary", path: notes, modes: ["read", "delete"] } });
    const id = added.body.grants[0]!.id;
    expect((await requestJson(td.url, HTTP_PATHS.folderGrant("nope"), { method: "DELETE" })).status).toBe(404);
    expect((await requestJson<FolderGrantsView>(td.url, HTTP_PATHS.folderGrant(id), { method: "DELETE" })).body.grants).toEqual([]);
    await requestJson(td.url, HTTP_PATHS.folderGrants, { method: "POST", body: { agentId: "secretary", path: notes, modes: ["read"] } });
    expect((await requestJson<FolderGrantsView>(td.url, HTTP_PATHS.folderGrantsClear, { method: "POST", body: { agentId: "secretary" } })).body.grants).toEqual([]);
  });
});
