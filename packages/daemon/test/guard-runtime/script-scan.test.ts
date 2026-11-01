// 脚本执行前的扫描（"不能联网"的尽力而为）：读脚本，找出用到的联网库或函数，作为环境事实交给守卫判定。
// 扫不出来的写法挡不住（没有系统级沙箱），这里只保证常见写法都认得、不用联网的脚本不被误伤。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NETWORK_PROGRAMS } from "../../src/guard/index.ts";
import { scanScript } from "../../src/guard-runtime/script-scan.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

function script(name: string, text: string): string {
  const file = path.join(makeTempDir("ergo-scan-"), name);
  fs.writeFileSync(file, text);
  return file;
}

describe("Python 脚本", () => {
  const NETWORKED: [string, string][] = [
    ["import requests\nrequests.get('https://example.com')", "requests"],
    ["from urllib.request import urlopen\n", "urllib.request"],
    ["import urllib.request as r\n", "urllib.request"],
    ["from urllib import request\n", "urllib.request"],
    ["import http.client\n", "http.client"],
    ["import socket\ns = socket.socket()", "socket"],
    ["import httpx, json\n", "httpx"],
    ["async def f():\n    import aiohttp\n", "aiohttp"],
    ["import smtplib\n", "smtplib"],
    ["import subprocess\nsubprocess.run(['curl', 'https://example.com'])", "curl"],
  ];
  for (const [text, hit] of NETWORKED) {
    it(`认出 ${hit}`, () => {
      expect(scanScript(script("fetch.py", text))?.networkUsage).toContain(hit);
    });
  }

  it("不用联网的脚本：空", () => {
    const text = "import json, math\nfrom pathlib import Path\nprint(sum(range(101)))\n# 注释里说 requests 不算\n";
    expect(scanScript(script("calc.py", text))).toEqual({ networkUsage: [] });
  });
});

describe("只连本机", () => {
  const LOCAL: [string, string, string][] = [
    ["smoke.py", "import urllib.request\nprint(urllib.request.urlopen('http://127.0.0.1:8765/health').read())\n", "urllib.request"],
    ["server.py", "from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler\nHOST = '127.0.0.1'\nThreadingHTTPServer((HOST, 8765), BaseHTTPRequestHandler).serve_forever()\n", "http.server"],
    ["sock.py", "import socket\ns = socket.create_connection(('localhost', 8765))\n", "socket"],
    ["six.py", "import socket\ns = socket.socket(socket.AF_INET6)\ns.connect(('::1', 8765))\n", "socket"],
    ["smoke.mjs", "const r = await fetch('http://127.0.0.1:8765/health');\n", "fetch"],
    ["serve.js", "const http = require('http');\nhttp.createServer(() => {}).listen(8765, '127.0.0.1');\n", "http"],
    ["curl.py", "import subprocess\nsubprocess.run(['curl', 'http://localhost:8765/health'])\n", "curl"],
    ["fstring.py", "import urllib.request\nHOST = '127.0.0.1'\nurllib.request.urlopen(f'http://{HOST}:8765/health')\n", "urllib.request"],
  ];
  for (const [name, text, hit] of LOCAL) {
    it(`${name} 写的都是本机地址：不算联网，单独列着`, () => {
      expect(scanScript(script(name, text))).toMatchObject({ networkUsage: [], localOnly: expect.arrayContaining([hit]) });
    });
  }

  const OUTSIDE: [string, string, string][] = [
    ["mixed.py", "import urllib.request\nurllib.request.urlopen('http://127.0.0.1:1/')\nurllib.request.urlopen('https://example.com/')\n", "urllib.request"],
    ["no-host.py", "import urllib.request, os\nurllib.request.urlopen(os.environ['URL'])\n", "urllib.request"],
    ["ip.py", "import socket\nsocket.create_connection(('203.0.113.1', 80))\n# 127.0.0.1 写在注释里不算\n", "socket"],
    ["host.py", "import http.client\nc = http.client.HTTPSConnection('example.com')\nb = '127.0.0.1'\n", "http.client"],
    ["all.py", "import socket\ns = socket.socket()\ns.bind(('0.0.0.0', 80))\nc = '127.0.0.1'\n", "socket"],
    ["empty.py", "from http.server import HTTPServer, BaseHTTPRequestHandler\nHTTPServer(('', 80), BaseHTTPRequestHandler)\nc = '127.0.0.1'\n", "http.server"],
    ["mail.py", "import smtplib\nsmtplib.SMTP('127.0.0.1')\n", "smtplib"],
    ["both.py", "import socket, boto3\nsocket.create_connection(('127.0.0.1', 1))\n", "boto3"],
    ["out.mjs", "await fetch('http://127.0.0.1:1/');\nawait fetch('https://api.example.com/');\n", "fetch"],
    ["localhost-lookalike.py", "import urllib.request\nurllib.request.urlopen('http://localhost.example.com/')\n", "urllib.request"],
  ];
  for (const [name, text, hit] of OUTSIDE) {
    it(`${name} 不只连本机：照旧算联网`, () => {
      const fact = scanScript(script(name, text));
      expect(fact?.networkUsage).toContain(hit);
      expect(fact?.localOnly).toBeUndefined();
    });
  }
});

describe("Node 脚本", () => {
  const NETWORKED: [string, string, string][] = [
    ["sync.js", "const r = await fetch('https://example.com');", "fetch"],
    ["a.js", "const https = require('https');", "https"],
    ["b.mjs", "import http from 'node:http';", "http"],
    ["c.cjs", "const net = require(\"net\")", "net"],
    ["d.js", "import axios from 'axios';", "axios"],
    ["e.ts", "const ws = new WebSocket('wss://x');", "WebSocket"],
    ["f.js", "require('child_process').execSync('wget https://x')", "wget"],
  ];
  for (const [name, text, hit] of NETWORKED) {
    it(`${name} 认出 ${hit}`, () => {
      expect(scanScript(script(name, text))?.networkUsage).toContain(hit);
    });
  }

  it("不用联网的脚本：空", () => {
    const text = "const fs = require('fs');\nconst total = [1, 2, 3].reduce((a, b) => a + b, 0);\nconsole.log(total); // prefetch(x) 不算\n";
    expect(scanScript(script("calc.js", text))).toEqual({ networkUsage: [] });
  });
});

describe("别的", () => {
  it("shell 脚本里的 curl", () => {
    expect(scanScript(script("get.sh", "#!/bin/bash\ncurl -s https://example.com > out.txt\n"))?.networkUsage).toContain("curl");
  });

  it("联网程序名单和守卫拆 bash 用的是同一份（guard/shell/programs.ts 的 NETWORK_PROGRAMS）", () => {
    for (const program of NETWORK_PROGRAMS) {
      expect({ program, hits: scanScript(script("net.sh", `echo start\n${program} example.com\n`))?.networkUsage }).toEqual({ program, hits: [program] });
    }
    expect(scanScript(script("ps.py", "import subprocess\nsubprocess.run(['powershell', 'Invoke-WebRequest https://x -OutFile a.zip'])\n"))?.networkUsage).toContain("Invoke-WebRequest");
  });

  it("普通字符串里出现程序名不算：字典的键、取值的参数", () => {
    const text = "import json\nconfig = json.load(open('c.json'))\nprint(config['host'], config.get(\"http\"), {'ssh': 1})\n";
    expect(scanScript(script("conf.py", text))).toEqual({ networkUsage: [] });
  });

  it("看不出语言的：按解释器，或者按第一行的 #!", () => {
    expect(scanScript(script("tool", "#!/usr/bin/env python3\nimport requests\n"))?.networkUsage).toContain("requests");
    expect(scanScript(script("tool2", "import requests\n"), "python")?.networkUsage).toContain("requests");
  });

  it("文件不存在、读不了：没有事实（判定里不知道）", () => {
    expect(scanScript(path.join(makeTempDir("ergo-scan-"), "missing.py"))).toBeUndefined();
    expect(scanScript(makeTempDir("ergo-scan-"))).toBeUndefined();
  });
});

describe("脚本里写着的绝对路径（写着受保护区域路径的脚本，守卫判永不）", () => {
  it("认出写死的盘符路径、转义过的反斜杠、Git Bash 的写法；没有就不带这一项", () => {
    const text = [
      "const fs = require('fs');",
      "fs.writeFileSync('D:\\\\ergo-data\\\\config\\\\watch-categories.json', '{}');",
      'fs.readFileSync("C:/Users/me/notes.txt");',
      "// 另一处：/e/work/out.log",
    ].join("\n");
    expect(scanScript(script("w.js", text))?.mentionedPaths?.toSorted()).toEqual(["C:\\Users\\me\\notes.txt", "D:\\ergo-data\\config\\watch-categories.json", "E:\\work\\out.log"]);
    expect(scanScript(script("calc.js", "console.log(1 + 2);\n"))).toEqual({ networkUsage: [] });
  });
});
