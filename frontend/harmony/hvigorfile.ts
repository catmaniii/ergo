// @ts-nocheck – DevEco 工程的构建脚本，由 hvigor 加载（根目录的 tsc、oxlint 不扫 frontend/harmony）
import { appTasks } from '@ohos/hvigor-ohos-plugin';

export default {
  system: appTasks, /* Built-in plugin of Hvigor. It cannot be modified. */
  plugins: []       /* Custom plugin to extend the functionality of Hvigor. */
}
