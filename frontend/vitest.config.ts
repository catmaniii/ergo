import { defineConfig } from "vitest/config";

// frontend/ 的测试（62 号票）：只有构建脚本和"签名材料不进仓库"的检查。
// 鸿蒙工程本身（frontend/harmony 下的 ArkTS、oh_modules、build）不归 vitest 管。
export default defineConfig({
  test: {
    name: "frontend",
    include: ["test/**/*.test.ts"],
  },
});
