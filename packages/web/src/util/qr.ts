// 二维码的方阵和路径（设备配对页）：qrcode-generator 算出黑白方块。不碰 React，frontend/test、测试都能直接用；画成 SVG 在 ui/qr-code.tsx。
import createQr from "qrcode-generator";

/** 静区：规范要求至少 4 格 */
export const QR_QUIET_MODULES = 4;

/** 文字（网址）编成 true 是黑块的方阵。纠错 M 档：屏幕上的码够用，方块也不至于太密。按 UTF-8 编，非 ASCII 也不会读错 */
export function qrMatrix(text: string): boolean[][] {
  const qr = createQr(0, "M");
  // 这个库默认把每个字符当一个字节（Latin-1），所以先把 UTF-8 的字节摊成字符交给它
  qr.addData(String.fromCharCode(...new TextEncoder().encode(text)), "Byte");
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_row, r) => Array.from({ length: size }, (_col, c) => qr.isDark(r, c)));
}

/** 黑块画成一条路径（一行里连着的并成一段，放大时不会有细缝），坐标按格子算，留出静区 */
export function qrPath(matrix: readonly (readonly boolean[])[]): string {
  const parts: string[] = [];
  matrix.forEach((row, r) => {
    let c = 0;
    while (c < row.length) {
      if (!row[c]) {
        c += 1;
        continue;
      }
      let end = c;
      while (end < row.length && row[end]) end += 1;
      parts.push(`M${c + QR_QUIET_MODULES} ${r + QR_QUIET_MODULES}h${end - c}v1h${c - end}z`);
      c = end;
    }
  });
  return parts.join("");
}
