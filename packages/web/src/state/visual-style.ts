// 视觉风格（纯函数，39 号票）：设置里选一套风格（经典、净白格栅……），按设备记住，和浅色 / 深色 / 跟随系统正交。
// 不是个人数据，也不经协议。这里只算记住的值（风格、119 号票起还有经典的主色）认不认识；有哪几套风格、各自的 token 在 src/visual-styles/（风格清单），
// 读写浏览器存储、给页面挂标记、加载字体在 app/theme.ts。

/** 没选过、或者记住的那套已经不在清单里时用的风格：现有的样子 */
export const DEFAULT_VISUAL_STYLE = "classic";

/** 记住的值：风格清单里有就用；没选过、清单里没有了（删掉的风格、旧版本留下的、被改过的）都按经典 */
export function visualStyleOf(raw: string | null, known: readonly string[]): string {
  return known.find((id) => id === raw) ?? DEFAULT_VISUAL_STYLE;
}

/**
 * 记住的主色（119 号票，现在只有经典能换）：按这套风格可选的主色认（accents 是它们的 id，第一个是默认的），认识就用，
 * 没选过、不认识的用默认的；这套风格不能换主色（没给、空的）就没有主色。记住的值只有一个，换了风格也留着，换回来照用
 */
export function accentOf(raw: string | null, accents: readonly string[] | undefined): string | undefined {
  if (!accents?.length) return undefined;
  return accents.find((id) => id === raw) ?? accents[0];
}
