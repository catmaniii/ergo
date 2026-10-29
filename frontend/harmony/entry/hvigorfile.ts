// @ts-nocheck – DevEco 工程的构建脚本，由 hvigor 加载（根目录的 tsc、oxlint 不扫 frontend/harmony）
import { hapTasks, OhosPluginId } from '@ohos/hvigor-ohos-plugin';
import { getNode, hvigor } from '@ohos/hvigor';

// WebView 调试默认关（62 号票评审）：开着的话，接上 USB 的人能用 hdc 经 DevTools 取到设备凭证 cookie。
// 只有构建时显式要（`npm run build:harmony -- --webview-debug`，即 hvigor 的 `-p webviewDebug=true`）才打开。
// 结果写进生成的 BuildProfile（BuildProfile.WEBVIEW_DEBUG），pages/Index.ets 据此决定开不开。
const entryNode = getNode(__filename);
entryNode.afterNodeEvaluate((node) => {
  const hapContext = node.getContext(OhosPluginId.OHOS_HAP_PLUGIN);
  const buildProfileOpt = hapContext.getBuildProfileOpt();
  if (!buildProfileOpt.buildOption) {
    buildProfileOpt.buildOption = {};
  }
  if (!buildProfileOpt.buildOption.arkOptions) {
    buildProfileOpt.buildOption.arkOptions = {};
  }
  const fields = buildProfileOpt.buildOption.arkOptions.buildProfileFields || {};
  fields.WEBVIEW_DEBUG = hvigor.getParameter().getExtParam('webviewDebug') === 'true';
  buildProfileOpt.buildOption.arkOptions.buildProfileFields = fields;
  hapContext.setBuildProfileOpt(buildProfileOpt);
});

export default {
  system: hapTasks, /* Built-in plugin of Hvigor. It cannot be modified. */
  plugins: []       /* Custom plugin to extend the functionality of Hvigor. */
}
