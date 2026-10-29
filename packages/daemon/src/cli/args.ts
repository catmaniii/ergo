// ergo 命令的参数（318 号票）：<命令> [位置参数…] [--开关] [--名字 值] [--名字=值] [-n 值]
export interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Map<string, string | true>;
}

/** valueFlags：后面跟一个值的开关（不带 --） */
export function parseArgs(argv: readonly string[], valueFlags: ReadonlySet<string>): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    const long = /^--([^=]+)(?:=(.*))?$/.exec(a);
    const short = /^-([A-Za-z])$/.exec(a);
    const name = long?.[1] ?? short?.[1];
    if (name === undefined) {
      positional.push(a);
      continue;
    }
    if (long?.[2] !== undefined) flags.set(name, long[2]);
    else if (valueFlags.has(name) && i + 1 < argv.length) flags.set(name, argv[++i]!);
    else flags.set(name, true);
  }
  const [command, ...rest] = positional;
  return { command, positional: rest, flags };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

export function flagOn(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}
