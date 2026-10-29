import { abilityAccessCtrl, bundleManager, common, Permissions } from '@kit.AbilityKit';
import { BusinessError, deviceInfo } from '@kit.BasicServicesKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { DOMAIN, TAG } from '../common/AppSettings';
import { t } from '../common/AppTexts';

/**
 * 读本机几个文件共用的（299、300 号票）：这台设备的名字、权限给没给、要授权（拒过的只有用户自己点才拉起二次授权）、出错的说法。
 */

/** 出错的说法（带错误码） */
export function errorText(err: BusinessError): string {
  return typeof err.code === 'number' ? t('harmony.common.errorWithCode', { 'message': `${err.message}`, 'code': String(err.code) }) : `${err.message}`;
}

/** 这台设备给人看的名字（"HUAWEI Pura 90"）；取不到是空串 */
export function deviceName(): string {
  try {
    const name = deviceInfo.marketName;
    return typeof name === 'string' ? name.trim() : '';
  } catch (e) {
    return '';
  }
}

/** 关掉一个打开的文件；关不掉只记日志 */
export function closeQuietly(file: fs.File | undefined): void {
  if (file === undefined) {
    return;
  }
  try {
    fs.closeSync(file);
  } catch (e) {
    hilog.warn(DOMAIN, TAG, 'close file failed: %{public}s', JSON.stringify(e));
  }
}

/** 这个权限给了没有 */
export function permissionGranted(permission: Permissions): boolean {
  try {
    const atManager = abilityAccessCtrl.createAtManager();
    const flags = bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION;
    const tokenId = bundleManager.getBundleInfoForSelfSync(flags).appInfo.accessTokenId;
    return atManager.checkAccessTokenSync(tokenId, permission) === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED;
  } catch (e) {
    hilog.error(DOMAIN, TAG, 'check permission %{public}s failed: %{public}s', permission, JSON.stringify(e));
    return false;
  }
}

/**
 * 要这几个权限（系统的授权框，一次弹）：第一个没给、userAction 为真、系统没再弹框（用户拒过）时拉起二次授权（设置里的那一页）。
 * 出错只记日志；回之后第一个给没给
 */
export async function requestPermissions(context: common.UIAbilityContext, permissions: Permissions[], userAction: boolean): Promise<boolean> {
  try {
    const atManager = abilityAccessCtrl.createAtManager();
    const asked = await atManager.requestPermissionsFromUser(context, permissions);
    const granted = asked.authResults.length > 0 && asked.authResults[0] === 0;
    const shownList = asked.dialogShownResults;
    const shown = shownList === undefined || shownList.length === 0 || shownList[0];
    if (!granted && userAction && !shown) {
      // 二次授权一次只拉一组权限：要第一个（读相册、定位）
      await atManager.requestPermissionOnSetting(context, [permissions[0]]);
    }
  } catch (e) {
    hilog.error(DOMAIN, TAG, 'request permissions %{public}s failed: %{public}s', permissions.join(','), JSON.stringify(e));
  }
  return permissions.length > 0 && permissionGranted(permissions[0]);
}
