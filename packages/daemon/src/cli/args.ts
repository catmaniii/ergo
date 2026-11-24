// ergo 命令的参数：<命令> [位置参数…] [--开关] [--名字 值] [--名字=值] [-n 值]
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

/**
 * 拿出 --dir <文件夹>（--dir=<文件夹>）：每条命令都认，放在命令前后都行（-- 之后的不算）。回剩下的参数和它的值（写了几次取最后一次）。
 * 原样转给别的程序的命令（svc、backup、restore）也先拿掉它，免得转过去
 */
export function takeDirFlag(argv: readonly string[]): { dir?: string; argv: string[] } {
  const rest: string[] = [];
  let dir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    if (a === "--dir") {
      if (i + 1 < argv.length) dir = argv[++i]!;
      else dir = "";
      continue;
    }
    if (a.startsWith("--dir=")) {
      dir = a.slice("--dir=".length);
      continue;
    }
    rest.push(a);
  }
  return dir === undefined ? { argv: rest } : { dir, argv: rest };
}
