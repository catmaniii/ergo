// 按队列选方式（162 号票）的纯函数：web_search 不指定 engine 时依次试哪几种、什么时候停下让模型用 agent-browser、只启用 agent-browser 时；
// web_fetch 在直接请求之后依次试哪几种；显式指定 engine 时停用了、没 key 的拒绝；工具说明、参数里能写的 engine。
// 182 号票：第四种"鸿蒙 App 的内置浏览器"——这一轮能用（秘书从浏览侧边栏、悬浮按钮来的那一轮）时 web_search 只试排在它前面的，
// 到它就停下（排第一时一个都不试）；这一轮用不了时跳过它；停用了不在队列里。
import type { WebMethod } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { engineBlocked, fetchPlan, searchEngines, searchPlan } from "../../src/web/index.ts";

const q = (...methods: WebMethod[]) => methods;

describe("web_search 按队列依次试", () => {
  it("agent-browser 排最后（初始顺序）：DeepSeek → 浏览器，都没成时提示 agent-browser", () => {
    expect(searchPlan(q("deepseek", "browser", "agent-browser"), true)).toEqual({ kind: "try", methods: ["deepseek", "browser"], next: { method: "agent-browser", rest: [] } });
    expect(searchPlan(q("browser", "deepseek", "agent-browser"), true)).toEqual({ kind: "try", methods: ["browser", "deepseek"], next: { method: "agent-browser", rest: [] } });
  });

  it("agent-browser 停用：只试另外两种，不提 agent-browser", () => {
    expect(searchPlan(q("deepseek", "browser"), true)).toEqual({ kind: "try", methods: ["deepseek", "browser"] });
    expect(searchPlan(q("browser"), true)).toEqual({ kind: "try", methods: ["browser"] });
  });

  it("agent-browser 排第一：模型先用它；调了 web_search 就按后面的顺序试", () => {
    expect(searchPlan(q("agent-browser", "browser", "deepseek"), true)).toEqual({ kind: "try", methods: ["browser", "deepseek"] });
  });

  it("agent-browser 排中间：试到它前面为止，停下让模型用 agent-browser，后面的写明（再调时指定 engine）", () => {
    expect(searchPlan(q("deepseek", "agent-browser", "browser"), true)).toEqual({ kind: "try", methods: ["deepseek"], next: { method: "agent-browser", rest: ["browser"] } });
  });

  it("只启用了 agent-browser：不试别的，回'只用 agent-browser'", () => {
    expect(searchPlan(q("agent-browser"), true)).toEqual({ kind: "only_agent_browser", usable: true });
  });

  it("这个 agent 没有 bash（用不了 agent-browser）：当它不在队列里；只启用了它时说明用不了", () => {
    expect(searchPlan(q("deepseek", "agent-browser", "browser"), false)).toEqual({ kind: "try", methods: ["deepseek", "browser"] });
    expect(searchPlan(q("agent-browser", "browser"), false)).toEqual({ kind: "try", methods: ["browser"] });
    expect(searchPlan(q("agent-browser"), false)).toEqual({ kind: "only_agent_browser", usable: false });
  });
});

describe("鸿蒙 App 的内置浏览器（182 号票）", () => {
  it("这一轮能用、排第一：一个都不试，停下让模型先用 browse_*，后面的写明", () => {
    expect(searchPlan(q("app-browser", "deepseek", "browser", "agent-browser"), true, true)).toEqual({
      kind: "try",
      methods: [],
      next: { method: "app-browser", rest: ["deepseek", "browser", "agent-browser"] },
    });
  });

  it("这一轮能用、排中间：只试排在它前面的，没成就停下", () => {
    expect(searchPlan(q("deepseek", "app-browser", "browser", "agent-browser"), true, true)).toEqual({
      kind: "try",
      methods: ["deepseek"],
      next: { method: "app-browser", rest: ["browser", "agent-browser"] },
    });
  });

  it("这一轮能用、排最后（初始顺序）：前面的都没成、agent-browser 也没成时才轮到它", () => {
    expect(searchPlan(q("deepseek", "browser", "agent-browser", "app-browser"), true, true)).toEqual({
      kind: "try",
      methods: ["deepseek", "browser"],
      next: { method: "agent-browser", rest: ["app-browser"] },
    });
    expect(searchPlan(q("deepseek", "browser", "app-browser"), true, true)).toEqual({ kind: "try", methods: ["deepseek", "browser"], next: { method: "app-browser", rest: [] } });
    // 没 bash 的不算 agent-browser
    expect(searchPlan(q("deepseek", "agent-browser", "app-browser", "browser"), false, true)).toEqual({ kind: "try", methods: ["deepseek"], next: { method: "app-browser", rest: ["browser"] } });
  });

  it("agent-browser 排第一、内置浏览器第二：模型先用了 agent-browser，web_search 一调就停在内置浏览器", () => {
    expect(searchPlan(q("agent-browser", "app-browser", "deepseek"), true, true)).toEqual({ kind: "try", methods: [], next: { method: "app-browser", rest: ["deepseek"] } });
  });

  it("这一轮用不了（不是侧边栏、悬浮按钮来的，或者这个 agent 没有 browse_* 工具）：跳过它，照其余的顺序", () => {
    expect(searchPlan(q("app-browser", "deepseek", "browser", "agent-browser"), true, false)).toEqual({ kind: "try", methods: ["deepseek", "browser"], next: { method: "agent-browser", rest: [] } });
    expect(searchPlan(q("deepseek", "app-browser", "browser"), true)).toEqual({ kind: "try", methods: ["deepseek", "browser"] });
  });

  it("只启用了它：这一轮能用时直接停下用它；用不了时一种都没有（写明是哪几种用不了）", () => {
    expect(searchPlan(q("app-browser"), true, true)).toEqual({ kind: "try", methods: [], next: { method: "app-browser", rest: [] } });
    expect(searchPlan(q("app-browser"), true, false)).toEqual({ kind: "unusable", methods: ["app-browser"] });
    expect(searchPlan(q("agent-browser", "app-browser"), false, false)).toEqual({ kind: "unusable", methods: ["agent-browser", "app-browser"] });
    // agent-browser 用得了、内置浏览器这一轮用不了：照"只用 agent-browser"
    expect(searchPlan(q("app-browser", "agent-browser"), true, false)).toEqual({ kind: "only_agent_browser", usable: true });
  });

  it("读网页：直接请求之后照旧试 DeepSeek、浏览器；都没读到时这一轮能用的提示它", () => {
    expect(fetchPlan(q("app-browser", "deepseek", "browser", "agent-browser"), true, true)).toEqual({ methods: ["deepseek", "browser"], agentBrowser: true, appBrowser: true });
    expect(fetchPlan(q("app-browser", "browser"), true, false)).toEqual({ methods: ["browser"], agentBrowser: false, appBrowser: false });
    expect(fetchPlan(q("browser"), true, true)).toEqual({ methods: ["browser"], agentBrowser: false, appBrowser: false });
  });

  it("engine 里没有它（不是工具自己能做的）", () => {
    expect(searchEngines(q("app-browser", "deepseek"), false)).toEqual(["deepseek"]);
    expect(searchEngines(q("app-browser"), false)).toEqual([]);
  });
});

describe("web_fetch 在直接请求之后依次试", () => {
  it("按队列里的 DeepSeek、浏览器；agent-browser 不打断（web_fetch 没法指定方式），启用着、用得了时都没读到再提示它", () => {
    expect(fetchPlan(q("deepseek", "browser", "agent-browser"), true)).toEqual({ methods: ["deepseek", "browser"], agentBrowser: true, appBrowser: false });
    expect(fetchPlan(q("browser", "agent-browser", "deepseek"), true)).toEqual({ methods: ["browser", "deepseek"], agentBrowser: true, appBrowser: false });
    expect(fetchPlan(q("browser"), true)).toEqual({ methods: ["browser"], agentBrowser: false, appBrowser: false });
    expect(fetchPlan(q("agent-browser"), true)).toEqual({ methods: [], agentBrowser: true, appBrowser: false });
    expect(fetchPlan(q("agent-browser", "deepseek"), false)).toEqual({ methods: ["deepseek"], agentBrowser: false, appBrowser: false });
  });
});

describe("显式指定 engine", () => {
  it("启用着的照用；停用了的、没配 key 的 DeepSeek 拒绝（浏览器的几个引擎跟着浏览器）", () => {
    expect(engineBlocked("deepseek", q("deepseek", "browser"), true)).toBeUndefined();
    expect(engineBlocked("ddg", q("deepseek", "browser"), true)).toBeUndefined();
    expect(engineBlocked("deepseek", q("browser", "agent-browser"), true)).toEqual({ method: "deepseek", why: "disabled" });
    expect(engineBlocked("deepseek", q("browser", "agent-browser"), false)).toEqual({ method: "deepseek", why: "no_key" });
    for (const engine of ["browser", "ddg", "bing", "google"] as const) expect(engineBlocked(engine, q("deepseek", "agent-browser"), true)).toEqual({ method: "browser", why: "disabled" });
  });

  it("工具说明、参数里能写的 engine：只有启用着、用得上的，Tavily 要配了 key", () => {
    expect(searchEngines(q("deepseek", "browser", "agent-browser"), true)).toEqual(["deepseek", "browser", "ddg", "bing", "google", "tavily"]);
    expect(searchEngines(q("browser", "deepseek"), false)).toEqual(["browser", "ddg", "bing", "google", "deepseek"]);
    expect(searchEngines(q("agent-browser"), false)).toEqual([]);
  });
});
