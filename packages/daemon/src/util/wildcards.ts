// 带通配符的路径展开成现在存在的路径（和 bash 一样）：删除项目时找读过它的调用（projects/outside-reads.ts，66 号票），
// 守卫判定前现取环境事实（guard-runtime/facts.ts，101 号票评审后定：通配符写的路径展开后逐个比受保护区域、密钥区）共用。
import fs from "node:fs";
import path from "node:path";

/** bash 的通配符：* ? [...] */
const WILDCARD = /[*?[]/;
/** 一个通配符最多展开成几个路径，再多就按通配符之前的那段目录算 */
const MAX_EXPANDED = 1000;

/**
 * 带通配符的路径展开成现在存在的路径（和 bash 一样）；展不开的（`**`、没有匹配、读不了目录、展开得太多）退回通配符之前的那段目录
 * （和项目目录比包含关系时，它是任何一个展开结果的上级，宁可多算）。名字里本来就有 [ ] 的现有文件照原样
 */
export function expandWildcards(p: string): string[] {
  const { root } = path.win32.parse(p);
  const segments = p.slice(root.length).split(/[\\/]+/).filter((s) => s !== "");
  const first = segments.findIndex((s) => WILDCARD.test(s));
  if (first < 0 || fs.existsSync(p)) return [p];
  const prefix = path.win32.join(root, ...segments.slice(0, first));
  let current = [prefix];
  for (const segment of segments.slice(first)) {
    if (!WILDCARD.test(segment)) {
      current = current.map((dir) => path.win32.join(dir, segment));
      continue;
    }
    if (segment.includes("**")) return [prefix];
    const pattern = wildcardPattern(segment);
    // 拼不成正则的（[s,a] 这种区间顺序不对的方括号，常见于被当成路径的内联脚本）：当展不开（守卫判定曾因此抛错、把命令拦下）
    if (!pattern) return [prefix];
    current = current.flatMap((dir) => {
      try {
        return fs
          .readdirSync(dir)
          .filter((name) => pattern.test(name))
          .map((name) => path.win32.join(dir, name));
      } catch {
        return [];
      }
    });
    if (current.length === 0 || current.length > MAX_EXPANDED) return [prefix];
  }
  // 和 bash 一样只展开成现有的（通配符后面的那几段也要在）
  const existing = current.filter((q) => fs.existsSync(q));
  return existing.length > 0 ? existing : [prefix];
}

/** 一段带通配符的名字换成正则：* 任意几个字符，? 一个字符，[...] 其中一个（[!...]、[^...] 不是其中的）；不分大小写（Windows）。拼不成正则的回 undefined */
function wildcardPattern(segment: string): RegExp | undefined {
  let source = "";
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (c === "*") source += ".*";
    else if (c === "?") source += ".";
    else if (c === "[" && segment.indexOf("]", i + 1) > i + 1) {
      const close = segment.indexOf("]", i + 1);
      const body = segment.slice(i + 1, close);
      const negated = body.startsWith("!") || body.startsWith("^");
      source += `[${negated ? "^" : ""}${(negated ? body.slice(1) : body).replaceAll("\\", "\\\\")}]`;
      i = close;
    } else source += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  try {
    return new RegExp(`^${source}$`, "i");
  } catch {
    return undefined;
  }
}
