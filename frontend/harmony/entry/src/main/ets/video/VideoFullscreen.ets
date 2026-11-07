import { window } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { DOMAIN, TAG } from '../common/AppSettings';

/**
 * 转不转横屏（和安卓 video/FullscreenChecks.kt 的 wantsLandscape 一样）：横视频（宽 > 高）转，横屏的两个方向都行；
 * 竖的、方的保持原来的方向（跟系统走，不锁竖屏：平板、阔折叠本来就是横着拿的）；全屏的不是视频（ArkWeb 给 0）、没给宽高的也不动
 */
export function wantsLandscape(width: number | undefined, height: number | undefined): boolean {
  const w = width === undefined ? 0 : width;
  const h = height === undefined ? 0 : height;
  return w > 0 && h > 0 && w > h;
}

/** 进全屏之前窗口的样子，退出时照着恢复 */
class SavedWindow {
  win: window.Window;
  orientation: window.Orientation;
  keepScreenOn: boolean;
  rotated: boolean;

  constructor(win: window.Window, orientation: window.Orientation, keepScreenOn: boolean, rotated: boolean) {
    this.win = win;
    this.orientation = orientation;
    this.keepScreenOn = keepScreenOn;
    this.rotated = rotated;
  }
}

/**
 * 网页视频真全屏（票 407，对应安卓 video/VideoFullscreen.kt）：ArkWeb 的全屏只撑满 Web 组件那一块（状态栏还在），
 * Web 组件接 onFullScreenEnter / onFullScreenExit，这里把主窗口的状态栏、三键导航条、手势条藏掉、屏幕常亮，
 * 横视频转横屏（AUTO_ROTATION_LANDSCAPE：横屏的两个方向都行）。退出（网页自己退、返回手势、切到后台、换地址）时
 * 一样样恢复成进去之前的样子：方向回到进去之前的（平常就是跟着系统走），常亮回到进去之前的。
 * 只接主界面那个 Web：浏览侧边栏没接（它在宽屏上只占右边一块）。
 */
export class VideoFullscreen {
  /** 网页给的退出全屏的句柄；不在全屏是 undefined */
  private handler: FullScreenExitHandler | undefined = undefined;
  private saved: SavedWindow | undefined = undefined;
  /** 主窗口（Index.ets 开场取到的那个）；还没取到时不动窗口，只有 Web 组件那一块全屏 */
  private mainWindow: () => window.Window | undefined;
  /** 进、出全屏（Index.ets 据此在全屏时藏起盖在网页上面的内置浏览器、侧边栏） */
  private changed: (showing: boolean) => void;

  constructor(mainWindow: () => window.Window | undefined, changed: (showing: boolean) => void) {
    this.mainWindow = mainWindow;
    this.changed = changed;
  }

  get showing(): boolean {
    return this.handler !== undefined;
  }

  /** Web 组件的 onFullScreenEnter */
  enter(event: FullScreenEnterEvent): void {
    const already = this.handler !== undefined;
    this.handler = event.handler;
    if (already) {
      // 全屏着又换了一个元素全屏：窗口已经设好了，只换句柄
      return;
    }
    this.changed(true);
    const landscape = wantsLandscape(event.videoWidth, event.videoHeight);
    hilog.info(DOMAIN, TAG, 'video fullscreen entered: %{public}dx%{public}d, landscape %{public}s',
      event.videoWidth === undefined ? 0 : event.videoWidth, event.videoHeight === undefined ? 0 : event.videoHeight,
      String(landscape));
    const win = this.mainWindow();
    if (win === undefined) {
      hilog.warn(DOMAIN, TAG, 'video fullscreen: no main window yet, system bars stay');
      return;
    }
    let orientation = window.Orientation.UNSPECIFIED;
    let keepScreenOn = false;
    try {
      orientation = win.getPreferredOrientation();
      keepScreenOn = win.getWindowProperties().isKeepScreenOn;
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'video fullscreen: read window state failed: %{public}s', JSON.stringify(e));
    }
    this.saved = new SavedWindow(win, orientation, keepScreenOn, landscape);
    this.windowCall('hide status bar', () => win.setSpecificSystemBarEnabled('status', false));
    this.windowCall('hide navigation bar', () => win.setSpecificSystemBarEnabled('navigation', false));
    this.windowCall('hide navigation indicator', () => win.setSpecificSystemBarEnabled('navigationIndicator', false));
    this.windowCall('keep screen on', () => win.setWindowKeepScreenOn(true));
    if (landscape) {
      this.windowCall('rotate to landscape', () => win.setPreferredOrientation(window.Orientation.AUTO_ROTATION_LANDSCAPE));
    }
  }

  /** Web 组件的 onFullScreenExit：网页退出了全屏（控件上的按钮、页面自己退、App 让它退之后） */
  exited(): void {
    if (this.handler === undefined) {
      return;
    }
    this.restore();
  }

  /**
   * App 让网页退出全屏（返回手势、切到后台、换地址）：先恢复窗口，再让网页退出（它随后的 onFullScreenExit 到这里已经没事做）。
   * 不在全屏回 false
   */
  exit(): boolean {
    const handler = this.handler;
    if (handler === undefined) {
      return false;
    }
    this.restore();
    try {
      handler.exitFullScreen();
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'video fullscreen: exitFullScreen failed: %{public}s', JSON.stringify(e));
    }
    return true;
  }

  private restore(): void {
    this.handler = undefined;
    const saved = this.saved;
    this.saved = undefined;
    this.changed(false);
    hilog.info(DOMAIN, TAG, 'video fullscreen exited');
    if (saved === undefined) {
      return;
    }
    const win = saved.win;
    this.windowCall('show status bar', () => win.setSpecificSystemBarEnabled('status', true));
    this.windowCall('show navigation bar', () => win.setSpecificSystemBarEnabled('navigation', true));
    this.windowCall('show navigation indicator', () => win.setSpecificSystemBarEnabled('navigationIndicator', true));
    if (!saved.keepScreenOn) {
      this.windowCall('stop keeping screen on', () => win.setWindowKeepScreenOn(false));
    }
    if (saved.rotated) {
      this.windowCall('restore orientation', () => win.setPreferredOrientation(saved.orientation));
    }
  }

  /** 窗口的一次设置：同步抛的、异步失败的都只记日志（窗口已经拆了时会这样） */
  private windowCall(what: string, run: () => Promise<void>): void {
    try {
      run().catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'video fullscreen: %{public}s failed: %{public}d', what, err.code);
      });
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'video fullscreen: %{public}s failed: %{public}s', what, JSON.stringify(e));
    }
  }
}
