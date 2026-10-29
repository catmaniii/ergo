// 模型输出的 JSON：去掉 ```json 围栏，取第一个 { 到最后一个 }，解析不了抛错（调用方记进 dropped）。
export function parseModelJson(content: string): Record<string, unknown> {
  let text = content.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  if (fence) text = fence[1]!;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型输出里没有 JSON 对象");
  const value: unknown = JSON.parse(text.slice(start, end + 1));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("模型输出的 JSON 不是对象");
  return value as Record<string, unknown>;
}

export const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
