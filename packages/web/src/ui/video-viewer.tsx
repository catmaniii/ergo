// 聊天里的视频点开的大播放器：外壳和图片查看器共用（ui/media-viewer.tsx：深色底、×、点空白、返回手势、Esc 关，
// 下面一行文件名和"下载"），里面是浏览器自带控件的 <video>，按视频的比例放到最大（铺满放图的那块框）。
// - 打开就放（有声音）：点气泡那一下算用户点过，浏览器让带声音自动放；万一不让（play() 被拒），停在开头，点播放键放。
// - 全屏用浏览器自带的（控件上的全屏按钮，标准 Fullscreen API）：浏览器里本来就是真全屏；新版 App 接住了全屏
//   （原生桥有 videoFullscreen，票 407），也是真全屏，横竖屏由 App 按视频宽高定；旧版 App 没接，按钮点了没反应，
//   藏掉，只用铺满页面的这一层（app/page-native.ts 的 pageVideoFullscreen）：controlsList="nofullscreen" 让播放器不进全屏
//   （双击也不进），Chromium 只把按钮置灰，再用样式把它拿掉（styles/pages.css 的 .no-fullscreen）。
// - 关掉时停下、把地址拿掉再 load()：播放器放掉解码器和连接，不在后台接着下载。地址在 effect 里挂上、拿掉（不写成 src 属性），
//   开发时 StrictMode 把 effect 跑两遍也能再挂回来。
// - 放的时候报错（网断了、文件坏了）：换成和报告页同一句"浏览器放不了，下载后用播放器看"，下面一行的"下载"照样在。
import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";
import { pageVideoFullscreen } from "../app/page-native.ts";
import { t } from "../state/index.ts";
import { MediaViewer } from "./media-viewer.tsx";

/** 还没读到画面宽高时先按这个比例占位 */
const DEFAULT_RATIO = 16 / 9;

export function VideoViewer({ src, name, download, ratio, onClose }: { src: string; name: string; download: string | undefined; ratio?: number | undefined; onClose(): void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  /** 画面的宽高比：气泡里取第一帧时已经知道的先用上，播放器自己读到了再换 */
  const [shape, setShape] = useState(ratio ?? DEFAULT_RATIO);
  const [fullscreen] = useState(pageVideoFullscreen);

  // 挂上就放；关掉（卸下）时停下、放掉。用 layout effect：点气泡那一下的同一轮里调 play()，App 的 WebView 也认得是用户点的
  useLayoutEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.src = src;
    video.play().catch(() => {
      // 浏览器不让自动放（带声音）或者放不了：停在开头，用户点播放键；放不了的由 error 事件换成提示
    });
    return () => {
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [src]);

  return (
    <MediaViewer className="video-viewer" name={name} download={download} onClose={onClose}>
      {failed ? (
        <div className="video-viewer-failed" role="alert">
          {t("pages.report.mediaFailed")}
        </div>
      ) : (
        <video
          ref={videoRef}
          controls
          playsInline
          preload="auto"
          {...(fullscreen ? {} : { controlsList: "nofullscreen", className: "no-fullscreen" })}
          style={{ "--video-ratio": String(shape) } as CSSProperties}
          onLoadedMetadata={(e) => {
            const { videoWidth: w, videoHeight: h } = e.currentTarget;
            if (w > 0 && h > 0) setShape(w / h);
          }}
          onError={() => setFailed(true)}
          aria-label={name}
        />
      )}
    </MediaViewer>
  );
}
