// 二维码（364 号票，设备配对页）：util/qr.ts 算出黑白方块，这里画成一张 SVG。
// 永远白底黑块，四周留 4 格白边（QR 规范的静区），不跟十一套风格的颜色走：深色主题下反色或者没白边的码，手机相机读不出来。
// 这是全仓库少有的写死颜色的地方，别换成 token。
import { useMemo } from "react";
import { QR_QUIET_MODULES, qrMatrix, qrPath } from "../util/qr.ts";

export function QrCode({ text, label }: { text: string; label: string }) {
  // 页面每秒都在重画（请求的倒计时）：网址不变就不重算
  const { side, path } = useMemo(() => {
    const matrix = qrMatrix(text);
    return { side: matrix.length + QR_QUIET_MODULES * 2, path: qrPath(matrix) };
  }, [text]);
  return (
    <svg className="qr-code" role="img" aria-label={label} viewBox={`0 0 ${side} ${side}`} shapeRendering="crispEdges" data-qr-text={text}>
      <rect width={side} height={side} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
