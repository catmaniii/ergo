import { defineConfig } from "vitest/config";
import { oldNameOf } from "../protocol/src/old-names.ts";

/**
 * 契约测试同时跑几个文件。每条用例都真的拉起 pi 子进程（光是加载 pi 就要约 1 秒 CPU，一条用例里常常依次拉起好几个），
 * 瓶颈是 CPU 不是超时：vitest 默认开"逻辑核数 − 1"个 worker（这台 20 逻辑核就是 19 个），子进程一起冷启动把 CPU 挤满，
 * 单跑 2–6 秒的用例被拖过 30 秒（2026-10-26 实测：19 个 worker 每次 7 条超时）。同一批量下：19 个 100 秒 7 条超时，
 * 8 个 96 秒、最慢一条 26.6 秒，6 个 89 秒、最慢 19.5 秒，4 个 111 秒、最慢 11.7 秒——过了 6 个总时长不再变短，
 * 只是每条更慢。取 4：多花二十来秒，最慢的离 30 秒还有两倍多的余量（别的槽同时在跑测试时也站得住），超时不放宽，
 * 照旧用来发现真卡住。ERGO_TEST_WORKERS 给得更小时照它（全量用 2 个 worker；312 号票：兼容期旧的变量名 ERGOU_TEST_WORKERS 也认）
 */
const CONTRACT_MAX_WORKERS = 4;

// pi 契约测试（规格 Testing Decisions 切面 3）：升级 pi 前先跑 `npm run test:contract`。
// 每条用例单独拉起一个 agent 子进程、接 faux provider，只验二狗依赖的 pi 行为。
export default defineConfig({
  test: {
    name: "pi-contract",
    include: ["test/contract/**/*.test.ts"],
    // 168 号票：每个测试文件开始前装上自带的中文（t() 查得到句子）
    setupFiles: ["test/setup-locales.ts", "../../vitest.setup-no-network.mjs"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers: Math.min(Number(process.env.ERGO_TEST_WORKERS || process.env[oldNameOf("ERGO_TEST_WORKERS")]) || CONTRACT_MAX_WORKERS, CONTRACT_MAX_WORKERS),
    // 根目录全量（`npm test`）里各 project 的 maxWorkers 不一样时，vitest 要求它们分在不同的组：契约测试在别的 project 跑完之后单独一组
    sequence: { groupOrder: 1 },
    // 244 号票：转译缓存
    fsModuleCache: true,
  },
});
