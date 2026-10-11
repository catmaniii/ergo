#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ticket_timing.py —— 统计二狗 v2 每张票做的过程中时间花在哪里（只读，只用 Python 标准库）。

用法（PowerShell 或 Git Bash 都行，路径按自己的改）：
  python ticket_timing.py \
      --subagents "C:/Users/<you>/.claude/projects/<proj>/<session>/subagents" \
      --main      "C:/Users/<you>/.claude/projects/<proj>/<session>.jsonl" \
      --repo      "D:/code/claudecode/my_personal_agent_ergou" \
      --shots-root "<scratchpad 目录>"          # 可选：数 tNN*/ 目录里的 png
      --out       "<输出目录>" \
      [--notes notes.md]                         # 可选：手写的分析，原样插进 report.md
      [--now 2026-10-11T22:00:00+08:00]          # 可选：进行中的票算到这个时间，默认取数据里最晚的时间戳
      [--samples]                                # 可选：每个类别抽样命令写到 samples.txt，用来核对分类

输出（都写进 --out）：
  per_ticket.csv   每票一行，各类别分钟数
  agents.csv       每个子 agent 一行（票号、角色、各类别分钟数），用来核对票号和角色认得对不对
  full_tests.csv   每一次全量测试（谁跑的、开始时间、时长、workers、同时在跑几个、结果）
  report.md        汇总报告
  samples.txt      （加 --samples 时）每个类别随机抽 25 条命令
以后有新票：直接重跑同一条命令即可（它每次从头流式解析所有记录，单进程，约 15 秒）。
Git Bash 里的例子（<…> 换成自己的路径）：
  P=~/.claude/projects/<项目目录>
  python .scratch/ergou-v2/tools/ticket_timing.py --subagents "$P/<会话 id>/subagents"       --main "$P/<会话 id>.jsonl" --repo . --shots-root "<scratchpad 目录>" --out "<输出目录>"
（Windows 控制台是 GBK 时先 export PYTHONIOENCODING=utf-8，进度信息才不乱码；输出文件都是 UTF-8。）

原理简述（详细口径见 report.md 的"分类规则与误差"一节）：
  * 每个子 agent 记录按时间排序成事件流，相邻两个事件之间的一小段时间按"当时的状态"归类：
      有前台工具在跑 → 归这个工具的类别（多个并行就平分；超过工具自身超时的部分算"会话中断/卡死"；要用户点允许的算"等用户批权限"）；
      没有前台工具、agent 在回合中 → 模型（思考 / 写字；读完图片后的那段算"看截图"）；紧挨着 compact_boundary 的那段 → 上下文压缩；
      撞了用量上限之后 → 撞用量上限停摆；回合里长时间没输出后被主会话叫"接着做" → 会话中断/卡死；
      agent 已经 end_turn → 有自己的后台命令在跑就归后台命令的类别，否则归"等主会话"（下一条是主会话发来的消息）。
  * 前台的"等待"（sleep / until 循环 / Monitor）跟自己的后台命令重叠时，算进后台命令的类别（空等就是在等那个测试）。
  * 后台命令（run_in_background、超时转后台、Monitor、后台子 agent）从发出到 <task-notification> 为止。
"""
import argparse
import bisect
import csv
import datetime as dt
import glob
import json
import os
import re
import statistics
import subprocess
import sys
from collections import Counter, defaultdict

LOCAL_TZ = dt.timezone(dt.timedelta(hours=8))

# ---------------------------------------------------------------- 类别
C_MODEL = "模型(思考/写字)"
C_COMPACT = "上下文压缩"
C_FULL = "全量测试"
C_PART = "单个/部分测试"
C_TSC = "类型检查"
C_LINT = "lint"
C_BUILD = "构建"
C_INSTALL = "装依赖"
C_SHOT = "截图/浏览器脚本"
C_VIEW = "看截图"
C_IMG = "图片处理"
C_GIT = "git"
C_QUEUE = "排队等机器"
C_WAIT = "查进程/等待"
C_READ = "读代码文档"
C_EDIT = "改代码文档"
C_SERVE = "服务/curl"
C_WEB = "联网查资料"
C_AGENT = "子agent"
C_OTHERCMD = "其它命令"
C_OTHERTOOL = "其它工具"
C_WAITMAIN = "等主会话(含评审)"
C_IDLE = "空闲-其它"
C_LIMIT = "撞用量上限停摆"
C_BROKEN = "会话中断/卡死"
C_PERM = "等用户批权限"

WORK_CATS = [C_MODEL, C_COMPACT, C_FULL, C_PART, C_TSC, C_LINT, C_BUILD, C_INSTALL, C_SHOT, C_VIEW, C_IMG,
             C_GIT, C_QUEUE, C_WAIT, C_READ, C_EDIT, C_SERVE, C_WEB, C_AGENT, C_OTHERCMD, C_OTHERTOOL]
STOP_CATS = [C_LIMIT, C_BROKEN, C_PERM]
IDLE_CATS = [C_WAITMAIN, C_IDLE]
ALL_CATS = WORK_CATS + STOP_CATS + IDLE_CATS
WAIT_LIKE = {C_WAIT, C_QUEUE}
SHOT_CATS = {C_SHOT, C_VIEW, C_IMG}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}

ROLE_IMPL, ROLE_REVIEW, ROLE_RESEARCH, ROLE_TICKETS, ROLE_OTHER = "实现", "评审", "调研", "写票/定稿", "其它"


def parse_ts(s):
    if not s:
        return None
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def loc(t):
    return t.astimezone(LOCAL_TZ) if t else None


def fmt_t(t):
    return loc(t).strftime("%m-%d %H:%M") if t else ""


def mins(sec):
    return round(sec / 60.0, 1)


# ---------------------------------------------------------------- 命令分类
_HEREDOC = re.compile(r"<<-?\s*['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?")


def split_heredocs(cmd):
    """把 heredoc / PowerShell here-string 的正文拿出来：返回 (命令本身, 正文)。"""
    out, body = [], []
    term = None
    for ln in cmd.split("\n"):
        if term is not None:
            if ln.strip() == term or (term in ("'@", '"@') and ln.startswith(term)):
                term = None
            else:
                body.append(ln)
            continue
        out.append(ln)
        m = _HEREDOC.search(ln)
        if m:
            term = m.group(1)
        elif re.search(r"@['\"]\s*$", ln):
            term = "'@" if ln.rstrip().endswith("@'") else '"@'
    return "\n".join(out), "\n".join(body)


_COMMIT_MSG = re.compile(r"(-m|-F)\s+(\"(?:[^\"\\]|\\.)*\"|'[^']*')")
# 只认真正在跑 vitest 的写法（npx vitest run / node …/vitest.mjs run / vitest --run），不认 -match 'vitest' 这种查进程的字样
_VITEST = re.compile(r"(?:npx\s+vitest|node_modules[/\\]+(?:\.bin[/\\]+)?vitest(?:[/\\]+vitest\.mjs)?|(?:^|(?<=[\s;&|(]))vitest)\s+(?:run|--run)(?=\s|$)([^|;&>\n]*)")
_VITEST_VALUE_FLAGS = {"-t", "--testNamePattern", "--project", "-c", "--config", "--maxWorkers", "--minWorkers", "--reporter",
                       "--pool", "--dir", "--root", "--outputFile", "--shard", "--bail", "--retry", "--testTimeout", "--environment"}


def _vitest_scope(c):
    """None: 没跑 vitest；'full'：整个仓库；'part'：带了文件 / 目录 / -t / --project。"""
    scope = None
    for m in _VITEST.finditer(c):
        args = m.group(1).replace("2>&1", " ").split()
        positional, filtered = [], False
        skip = False
        for tok in args:
            if skip:
                skip = False
                continue
            if tok.startswith("-"):
                name = tok.split("=", 1)[0]
                if name in ("-t", "--testNamePattern", "--project"):
                    filtered = True
                if name in _VITEST_VALUE_FLAGS and "=" not in tok:
                    skip = True
                continue
            if tok in ("run", "watch", "2", "1"):
                continue
            positional.append(tok)
        prefix = c[:m.start()]
        in_pkg = re.search(r"cd\s+\S*packages[/\\][^\s/\\]+\S*\s*(&&|;)", prefix) is not None
        s = "part" if (positional or filtered or in_pkg) else "full"
        if scope != "full":
            scope = "full" if s == "full" else (scope or s)
    return scope


def _npm_test_scope(c):
    scope = None
    for m in re.finditer(r"npm\s+(?:run\s+)?(check|test)\b([^|;&\n]*)", c):
        rest = m.group(2)
        prefix = c[:m.start()]
        in_pkg = re.search(r"cd\s+\S*packages[/\\][^\s/\\]+\S*\s*(&&|;)", prefix) is not None
        if re.search(r"(^|\s)(-w|--workspace)(\s|=)", rest) or in_pkg or re.match(r":\S", rest):
            s = "part"
        else:
            s = "full"
        if scope != "full":
            scope = s if s == "full" else (scope or s)
    return scope


class ScriptProbe:
    """node xxx.mjs 是不是浏览器 / 截图脚本：能找到文件就看里面有没有 playwright / chromium。"""

    def __init__(self, roots):
        self.roots = [r for r in roots if r]
        self.cache = {}

    @staticmethod
    def _win(p):
        p = p.strip("\"'")
        m = re.match(r"^/([a-zA-Z])/(.*)$", p)
        if m:
            p = m.group(1).upper() + ":/" + m.group(2)
        return p

    def is_browser(self, script, cmd):
        key = script
        if key in self.cache:
            return self.cache[key]
        name = re.split(r"[/\\]", script)[-1].lower()
        cands = [self._win(script)]
        m = re.search(r"cd\s+(\"[^\"]+\"|'[^']+'|\S+)\s*(&&|;)", cmd)
        if m:
            cands.append(os.path.join(self._win(m.group(1)), self._win(script)))
        for r in self.roots:
            cands.append(os.path.join(r, self._win(script)))
            cands.append(os.path.join(r, name))
        verdict = None
        for p in cands:
            try:
                if os.path.isfile(p) and os.path.getsize(p) < 2_000_000:
                    with open(p, encoding="utf-8", errors="ignore") as fh:
                        txt = fh.read()
                    verdict = bool(re.search(r"playwright|chromium|puppeteer|\.screenshot\(|agent-browser", txt))
                    break
            except OSError:
                pass
        if verdict is None:
            verdict = bool(re.search(r"shot|shoot|crop|montage|wide|narrow|skel|dom|inspect|probe|design|compare|contrast|pick|attrs|record|box|fade|font|preview|matrix|slices|pc\.mjs|cr\.mjs", name))
        self.cache[key] = verdict
        return verdict


def classify_command(cmd, tur, probe):
    """Bash / PowerShell 命令 → 类别。tur 是 toolUseResult（用来认 bash 里改文件）。"""
    main, body = split_heredocs(cmd or "")
    c = _COMMIT_MSG.sub(" ", main)
    allc = c + "\n" + body
    vs = _vitest_scope(c)
    ns = _npm_test_scope(c)
    if vs == "full" or ns == "full":
        return C_FULL
    # 自己写的包装脚本（.ps1 / .sh）：按文件名认
    scr = " ".join(re.findall(r"[\w.-]+\.(?:ps1|sh)\b", c)).lower()
    if scr:
        if re.search(r"wait[-_]?(no[-_]?)?(full[-_]?)?vitest|wait[-_]?full", scr):
            return C_QUEUE
        if re.search(r"full[-_]?(run|test|check)", scr):
            return C_FULL
        if re.search(r"shot|shoot", scr):
            return C_SHOT
    if vs == "part" or ns == "part":
        return C_PART
    # 截图 / 浏览器
    if re.search(r"agent-browser|playwright|chromium|chrome(\.exe)?\s+--headless|msedge|--screenshot|\bscreenshot\b", c, re.I):
        return C_SHOT
    for m in re.finditer(r"\bnode\s+(?:--\S+\s+)*(\"[^\"]+\.m?[jt]s\"|'[^']+\.m?[jt]s'|[^\s|;&]+\.m?js)\b", c):
        scr = m.group(1)
        if re.search(r"vitest|oxlint|tsc|npm-cli", scr):
            continue
        if probe.is_browser(scr, c):
            return C_SHOT
    if re.search(r"\bnode\s+-e\b", c) and re.search(r"playwright|chromium", allc):
        return C_SHOT
    if re.search(r"build:web|build:harmony|vite\s+build|npm\s+run\s+build\b|hvigor|assembleHap", c):
        return C_BUILD
    if re.search(r"\btsc\b|typecheck|tsgo", c):
        return C_TSC
    if re.search(r"oxlint|npm\s+run\s+lint\b|eslint", c):
        return C_LINT
    if re.search(r"\bnpm\s+(ci|install|i|add)\b", c):
        return C_INSTALL
    if re.search(r"\bPIL\b|from PIL|Image\.open|ImageChops|ImageDraw|\bmagick\b|\bffmpeg\b|\bcv2\b|System\.Drawing|mkpng", allc):
        return C_IMG
    proc = re.search(r"tasklist|Get-CimInstance|Get-Process|Win32_Process|\bwmic\b|\bpgrep\b|\bps\s+(-|aux|ef)|Wait-Process", c)
    loop = re.search(r"\buntil\b|\bwhile\b|\$deadline", c)
    if proc and loop:
        return C_QUEUE
    if proc or re.search(r"\bsleep\s+\d|Start-Sleep|\btimeout\s+/t\b|\btail\s+(-n\s*\+?\d+\s+)?-[fF]\b|Get-Content\s.*-Wait", c) \
            or (loop and re.search(r"\bsleep\b|Start-Sleep", c)):
        return C_WAIT
    if re.search(r"\bgit\s+(-C\s+\S+\s+)?(rebase|commit|merge|cherry-pick|reset|checkout|switch|stash|add|rm|mv|worktree|am|apply|restore|tag|push|pull|fetch|clean)\b", c):
        return C_GIT
    edited = isinstance(tur, dict) and isinstance(tur.get("bashEditDiff"), dict) and tur["bashEditDiff"].get("files")
    if edited or re.search(r"\bsed\s+-i|\bperl\s+-p?i|\bcat\s*>|\btee\s|Set-Content|Out-File|Add-Content|\bcp\s|\bmv\s|\brm\s|\bmkdir\s|New-Item|Copy-Item|Move-Item|Remove-Item", c) \
            or re.search(r"\.write\(|write_text\(|write_bytes\(", body):
        return C_EDIT
    if re.search(r"\bcurl\b|Invoke-WebRequest|Invoke-RestMethod|\bwget\b|npm\s+run\s+(dev|serve|preview)|vite\s+preview|(?:^|[\s;&|(])lsm\s+\w|\bhdc\s|Start-Process", c):
        return C_SERVE
    if re.search(r"(^|[\s;&|(])(cat|sed|grep|rg|ls|head|tail|find|wc|diff|echo|tree|stat|file|jq|awk|cut|sort|uniq|less|type|dir|python3?|py|node\s+-e|git)\b|Get-Content|Select-String|Get-ChildItem|Test-Path|Get-Item|Resolve-Path|Format-", c):
        return C_READ
    return C_OTHERCMD


def classify_tool(name, inp, tur, probe):
    if name in ("Bash", "PowerShell"):
        return classify_command(inp.get("command", ""), tur, probe)
    if name == "Read":
        ext = os.path.splitext(str(inp.get("file_path", "")))[1].lower()
        return C_VIEW if ext in IMAGE_EXT else C_READ
    if name in ("Grep", "Glob", "LS", "NotebookRead"):
        return C_READ
    if name in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
        return C_EDIT
    if name in ("WebFetch", "WebSearch"):
        return C_WEB
    if name in ("Monitor", "TaskOutput"):
        cmd = inp.get("command", "") or ""
        if re.search(r"tasklist|Get-CimInstance|Get-Process|Win32_Process", cmd):
            return C_QUEUE
        return C_WAIT
    if name in ("Agent", "Task"):
        return C_AGENT
    if name.startswith("mcp__claude-in-chrome"):
        return C_SHOT
    return C_OTHERTOOL


def tool_cap(tc):
    """前台工具调用最长能跑多久（秒）。超过这个时间还没回结果，多出来的算"会话中断/卡死"（机器休眠、卡死）。"""
    if tc.name in ("Bash", "PowerShell"):
        try:
            t = float(tc.inp.get("timeout") or 120000) / 1000.0
        except (TypeError, ValueError):
            t = 120.0
        return min(max(t, 1.0), 600.0) + 120.0
    if tc.name in ("Read", "Edit", "Write", "Grep", "Glob", "MultiEdit", "NotebookEdit", "ToolSearch", "Skill", "TaskStop"):
        return 300.0
    if tc.name in ("WebFetch", "WebSearch"):
        return 600.0
    return None


def full_test_workers(cmd):
    m = re.search(r"ERGOU_TEST_WORKERS\s*=\s*(\d+)", cmd or "")
    if m:
        return m.group(1)
    m = re.search(r"--maxWorkers[= ](\d+)", cmd or "")
    if m:
        return m.group(1)
    return "默认"


# ---------------------------------------------------------------- 角色和票号
def classify_role(desc, prompt):
    d = (desc or "").lower()
    if re.search(r"write impl tickets|update impl tickets|update tickets|draft questions|resolve tickets|resolve \d|apply round-2 ticket", d):
        return ROLE_TICKETS
    if re.search(r"review|security check", d):
        return ROLE_REVIEW
    if re.match(r"(implement|resume ticket|fix |hold attachments)", d):
        return ROLE_IMPL
    if re.search(r"research|survey|deep-dive|inventory|analy[sz]e|audit|latency|internals|libraries|models|process model|fetch |"
                 r"pairing check|startup|behavior|ux|mapping|compaction|^pi |state", d):
        return ROLE_RESEARCH
    p = prompt or ""
    if re.search(r"你负责实现|请按 /implement", p):
        return ROLE_IMPL
    if re.search(r"评审员|reviewer", p, re.I):
        return ROLE_REVIEW
    return ROLE_OTHER


def find_ticket(desc, prompt, role):
    """只给实现和评审认票号。description 里写了 ticket NN 为准；没写的实现 agent（比如修录像测试）不归到票。"""
    if role not in (ROLE_IMPL, ROLE_REVIEW):
        return None
    m = re.search(r"ticket\s*:?\s*(\d{1,3})\b", desc or "", re.I)
    if m:
        return int(m.group(1))
    if desc and not re.match(r"(implement|resume|review|re-review|two-axis|spec|standards)", desc, re.I):
        return None
    p = prompt or ""
    m = re.search(r"(?:实现|负责|评审)[^\n]{0,40}?\*{0,2}(\d{1,3})\s*号票", p)
    if m:
        return int(m.group(1))
    return None


# ---------------------------------------------------------------- 一个记录（子 agent 或主会话）
_NOTIF = re.compile(r"<task-notification>(.*?)</task-notification>", re.S)


def parse_notifications(text):
    res = []
    for m in _NOTIF.finditer(text or ""):
        b = m.group(1)

        def g(tag):
            mm = re.search(r"<%s>(.*?)</%s>" % (tag, tag), b, re.S)
            return mm.group(1).strip() if mm else None
        res.append({"task": g("task-id"), "tool": g("tool-use-id"), "status": g("status"), "summary": g("summary") or ""})
    return res


DONE_STATUS = {"completed", "failed", "killed", "stopped", "error", "timeout", "timed_out", "expired", "cancelled", "canceled"}


class ToolCall:
    __slots__ = ("id", "name", "inp", "start", "end", "cat", "bg_task", "bg_end", "bg_status", "bg_summary", "cmd", "round", "result_head",
                 "orphan", "lost", "perm")

    def __init__(self, tid, name, inp, start, rnd):
        self.id, self.name, self.inp, self.start = tid, name, inp, start
        self.end = None
        self.cat = None
        self.bg_task = None
        self.bg_end = None
        self.bg_status = None
        self.bg_summary = ""
        self.cmd = inp.get("command", "") if isinstance(inp, dict) else ""
        self.round = rnd
        self.result_head = ""
        self.orphan = False
        self.lost = False
        self.perm = False


def trigger_kind(text):
    if re.search(r"评审|review", text, re.I):
        return "评审返修"
    if re.search(r"用户", text):
        return "用户改需求/补充"
    if re.search(r"合进\s*main|合并进\s*main|合进了|变基|rebase", text, re.I):
        return "变基/跟进 main"
    return "其它"


class Transcript:
    def __init__(self, path, aid, meta, probe, keep_calls=False):
        self.path, self.aid, self.meta = path, aid, meta or {}
        self.desc = self.meta.get("description", "")
        self.prompt = ""
        self.role = None
        self.ticket = None
        self.start = None
        self.last = None
        self.cat_sec = Counter()
        self.round_cat = defaultdict(Counter)        # round -> Counter(cat->sec)
        self.rounds = []                              # [{idx,start,kind,text}]
        self.slices = []                              # (t0, t1, cat)
        self.wait_main = []                           # (t0, t1)
        self.full_runs = []                           # dicts
        self.calls = []                               # all ToolCalls (if keep_calls)
        self.keep_calls = keep_calls
        self.shot_cmds = 0
        self.png_reads = 0
        self.png_paths = set()
        self.compactions = 0
        self.limit_hits = 0
        self.perm_hits = 0
        self.ev_times = []
        self.exit_marks = []
        self.broken = 0
        self.inline_msgs = 0
        self.vitest_summaries = []                    # (ts, files, seconds)
        self.live_state = None
        self.probe = probe

    # -------------------------------------------------- 读文件 → 事件
    def load_events(self):
        ev = []
        seq = 0
        first_user = True
        with open(self.path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                # 快速跳过大量无关的 attachment
                if line.startswith('{"parentUuid"') and '"type":"attachment"' in line and "queued_command" not in line:
                    continue
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                t = o.get("type")
                ts = parse_ts(o.get("timestamp"))
                seq += 1
                if t == "system":
                    if o.get("subtype") == "compact_boundary" and ts:
                        ev.append((ts, seq, "compact", None))
                    continue
                if ts is None:
                    continue
                if t == "attachment":
                    a = o.get("attachment") or {}
                    if a.get("type") == "queued_command":
                        p = a.get("prompt")
                        p = p if isinstance(p, str) else json.dumps(p, ensure_ascii=False)
                        ns = parse_notifications(p)
                        if ns:
                            for n in ns:
                                ev.append((ts, seq, "notif", n))
                        else:
                            ev.append((ts, seq, "coord", p))
                    continue
                msg = o.get("message") or {}
                content = msg.get("content")
                if t == "assistant":
                    if not isinstance(content, list):
                        continue
                    if o.get("isApiErrorMessage"):
                        txt = " ".join(x.get("text", "") for x in content if isinstance(x, dict))
                        if o.get("error") == "rate_limit" or re.search(r"hit your .*limit|usage limit|limit · resets", txt):
                            ev.append((ts, seq, "limit", txt[:80]))
                            continue
                    stop = msg.get("stop_reason")
                    has_tool = False
                    for x in content:
                        if x.get("type") == "tool_use":
                            has_tool = True
                            ev.append((ts, seq, "tool_use", x))
                    if not has_tool:
                        ev.append((ts, seq, "asst", stop in ("end_turn", "stop_sequence")))
                    continue
                if t != "user":
                    continue
                if isinstance(content, str):
                    if first_user and not o.get("isMeta"):
                        first_user = False
                        self.prompt = content
                        ev.append((ts, seq, "prompt", content))
                        continue
                    origin = o.get("origin") or {}
                    kind = origin.get("kind") if isinstance(origin, dict) else None
                    if content.startswith("This session is being continued"):
                        ev.append((ts, seq, "summary", None))
                    elif content.startswith("[Image") or content.startswith("[Request interrupted") and False:
                        pass
                    elif content.startswith("[Request interrupted"):
                        ev.append((ts, seq, "interrupt", None))
                    elif kind == "task-notification" or "<task-notification>" in content:
                        for n in parse_notifications(content) or [{"task": None, "tool": None, "status": None, "summary": ""}]:
                            ev.append((ts, seq, "notif", n))
                    elif kind == "coordinator" or content.startswith("The coordinator sent"):
                        ev.append((ts, seq, "coord", content.split(":", 1)[-1] if content.startswith("The coordinator") else content))
                    elif content.startswith("[Image"):
                        pass
                    else:
                        ev.append((ts, seq, "coord", content))
                    continue
                if isinstance(content, list):
                    tur = o.get("toolUseResult")
                    has_tr = False
                    for x in content:
                        if x.get("type") == "tool_result":
                            has_tr = True
                            c = x.get("content")
                            if isinstance(c, list):
                                c = " ".join(y.get("text", "") for y in c if isinstance(y, dict))
                            pdn = o.get("permissionDecision") or {}
                            perm_user = isinstance(pdn, dict) and str(pdn.get("source", "")).startswith("user")
                            ev.append((ts, seq, "tool_result", (x.get("tool_use_id"), tur, (c or "")[:4000], bool(x.get("is_error")), perm_user)))
                    if not has_tr:
                        txt = " ".join(y.get("text", "") for y in content if isinstance(y, dict) and y.get("type") == "text")
                        if first_user and txt and not o.get("isMeta"):
                            first_user = False
                            self.prompt = txt
                            ev.append((ts, seq, "prompt", txt))
                        elif txt.startswith("[Request interrupted"):
                            ev.append((ts, seq, "interrupt", None))
                        elif "<task-notification>" in txt:
                            for n in parse_notifications(txt):
                                ev.append((ts, seq, "notif", n))
        ev.sort(key=lambda e: (e[0], e[1]))
        return ev

    # -------------------------------------------------- 切段
    def run(self, now=None, extend_live=False):
        ev = self.load_events()
        if not ev:
            return
        self.ev_times = [e[0] for e in ev]
        self.role = classify_role(self.desc, self.prompt)
        self.ticket = find_ticket(self.desc, self.prompt, self.role)
        self.start = ev[0][0]
        # 预扫：哪些工具调用一直没回结果（会话中断丢了），哪些后台任务一直没有结束通知
        result_ids = {e[3][0] for e in ev if e[2] == "tool_result"}
        perm_ids = {e[3][0] for e in ev if e[2] == "tool_result" and e[3][4]}   # 要用户点"允许"才执行的调用
        notified = set()
        for e in ev:
            if e[2] == "notif":
                notified.add(e[3].get("task"))
                notified.add(e[3].get("tool"))
        notified.discard(None)
        fg = {}            # id -> ToolCall
        bg = {}            # task id -> ToolCall
        by_tool = {}       # tool id -> ToolCall (for notif lookups)
        st = {"in_turn": True, "limited": False, "rnd": 0}
        self.rounds.append({"idx": 0, "start": self.start, "kind": "首轮", "text": ""})
        prev = self.start

        def add(t0, t1, cat, weight=1.0):
            sec = (t1 - t0).total_seconds() * weight
            if sec <= 0:
                return
            self.cat_sec[cat] += sec
            self.round_cat[st["rnd"]][cat] += sec
            if weight >= 0.999:
                if self.slices and self.slices[-1][2] == cat and self.slices[-1][1] == t0:
                    self.slices[-1] = (self.slices[-1][0], t1, cat)
                else:
                    self.slices.append((t0, t1, cat))
            else:
                # 平分：时间线上按比例切小段（只用于并集计算，不影响总量）
                span = (t1 - t0) * weight
                self.slices.append((t0, t0 + span, cat))

        def live_bg(include_lost):
            return [b for b in bg.values() if include_lost or not getattr(b, "lost", False)]

        def assign(t0, t1, kind):
            if t1 <= t0:
                return
            if fg:
                if kind in ("coord", "prompt", "summary") and any(getattr(tc, "orphan", False) for tc in fg.values()):
                    add(t0, t1, C_BROKEN)          # 工具一直没回结果，下一条就是主会话"接着做" → 会话中断
                    return
                work_bg = [b for b in live_bg(True) if b.cat not in WAIT_LIKE]
                w = 1.0 / len(fg)
                for tc in fg.values():
                    c = tc.cat
                    if c == C_WAIT and work_bg:
                        c = work_bg[0].cat
                    if tc.perm:
                        add(t0, t1, C_PERM, w)        # 等用户批权限：整段都算等用户（实际执行通常只有几秒到几分钟）
                        continue
                    cap = tool_cap(tc)
                    lim = tc.start + dt.timedelta(seconds=cap) if cap else None
                    if lim is None or t1 <= lim:
                        add(t0, t1, c, w)
                    elif t0 >= lim:
                        add(t0, t1, C_BROKEN, w)
                    else:
                        add(t0, lim, c, w)
                        add(lim, t1, C_BROKEN, w)
                return
            if kind in ("compact", "summary"):
                # 压缩最多算 10 分钟；再往前的空档按平常的规则算（多半是空闲时来了消息才触发压缩）
                lim = t1 - dt.timedelta(minutes=10)
                if t0 < lim:
                    assign(t0, lim, "other")
                    t0 = lim
                add(t0, t1, C_COMPACT)
                return
            work_bg = [b for b in live_bg(False) if b.cat not in WAIT_LIKE]
            if st["limited"]:
                if work_bg:
                    w = 1.0 / len(work_bg)
                    for b in work_bg:
                        add(t0, t1, b.cat, w)
                else:
                    add(t0, t1, C_LIMIT)
                return
            if st["in_turn"]:
                gap = (t1 - t0).total_seconds()
                # 回合里很久没有任何输出，下一条是主会话"接着做"（或干脆超过 15 分钟）：会话中断 / 卡住，不算模型时间
                if (kind == "coord" and gap >= 300) or gap >= 900:
                    add(t0, t1, C_BROKEN)
                    if kind == "coord":
                        st["stall"] = True
                else:
                    add(t0, t1, C_VIEW if st.get("after_view") else C_MODEL)   # 读完截图后的那段思考算"看截图"
                return
            pool = work_bg or live_bg(False)
            if pool:
                w = 1.0 / len(pool)
                for b in pool:
                    add(t0, t1, b.cat, w)
                return
            if kind in ("coord", "live"):
                add(t0, t1, C_WAITMAIN)
                if self.wait_main and self.wait_main[-1][1] == t0:
                    self.wait_main[-1] = (self.wait_main[-1][0], t1)
                else:
                    self.wait_main.append((t0, t1))
            else:
                add(t0, t1, C_IDLE)

        def drop_bg(tc, ts, status, summary, record=True):
            bg.pop(tc.bg_task, None)
            tc.bg_end = ts
            tc.bg_status = status
            tc.bg_summary = summary
            if record and tc.cat == C_FULL:
                self._record_full(tc, ts, "后台", summary)

        for ts, _seq, kind, data in ev:
            if ts > prev:
                assign(prev, ts, kind)
                prev = ts
            if kind != "tool_result" and kind not in ("notif",):
                st["after_view"] = False
            if kind == "tool_use":
                st["in_turn"] = True
                st["limited"] = False
                inp = data.get("input") or {}
                tc = ToolCall(data.get("id"), data.get("name", ""), inp if isinstance(inp, dict) else {}, ts, st["rnd"])
                tc.cat = classify_tool(tc.name, tc.inp, None, self.probe)   # 先粗分，结果回来后再按 toolUseResult 细分
                tc.orphan = tc.id not in result_ids
                tc.perm = tc.id in perm_ids
                fg[tc.id] = tc
                by_tool[tc.id] = tc
                if self.keep_calls:
                    self.calls.append(tc)
            elif kind == "tool_result":
                tid, tur, text, _err, _perm = data
                if _perm and tid in fg:
                    self.perm_hits += 1
                tc = fg.pop(tid, None)
                if tc is None:
                    continue
                tc.end = ts
                tc.result_head = text[:600]
                if tc.name in ("Bash", "PowerShell"):
                    tc.cat = classify_tool(tc.name, tc.inp, tur, self.probe)
                    if tc.cat == C_SHOT and re.search(r"screenshot|shots?\.mjs|shoot|crop|montage|wide\.mjs|narrow\.mjs", tc.cmd):
                        self.shot_cmds += 1
                elif tc.name == "Read" and tc.cat == C_VIEW:
                    st["after_view"] = True
                    self.png_reads += 1
                    self.png_paths.add(str(tc.inp.get("file_path", "")).lower())
                elif tc.name.startswith("mcp__claude-in-chrome") and "screenshot" in json.dumps(tc.inp):
                    self.shot_cmds += 1
                elif tc.name == "TaskStop":
                    tid2 = tc.inp.get("task_id") or tc.inp.get("shell_id") or (tur.get("task_id") if isinstance(tur, dict) else None)
                    if tid2 in bg:
                        drop_bg(bg[tid2], ts, "stopped", "TaskStop")
                bgid = None
                if isinstance(tur, dict):
                    bgid = tur.get("backgroundTaskId") or (tur.get("taskId") if tc.name == "Monitor" else None)
                    if tc.name in ("Agent", "Task") and tur.get("isAsync"):
                        bgid = tur.get("agentId")
                if not bgid:
                    m = re.search(r"running in background with ID:\s*(\w+)|moved to the background \(ID:\s*(\w+)\)|Monitor started \(task (\w+)|agentId:\s*(\w+)", text)
                    if m and (tc.inp.get("run_in_background") or "background" in text or tc.name in ("Monitor", "Agent", "Task")):
                        bgid = next(g for g in m.groups() if g)
                if bgid:
                    tc.bg_task = bgid
                    tc.lost = bgid not in notified and tc.id not in notified
                    bg[bgid] = tc
                elif tc.cat == C_FULL and (ts - tc.start).total_seconds() >= 8:
                    self._record_full(tc, ts, "前台", text)      # 不到 8 秒的多半是 && 前面就失败了，没真跑
                for mm in re.finditer(r"(?:^|[\s>])exit[=: ]\s*(\d+)\b", text):
                    self.exit_marks.append((ts, int(mm.group(1))))
                if re.search(r"Test Files\s+\d+\s+failed", text):
                    self.exit_marks.append((ts, 1))
                m = re.search(r"Test Files\s+(?:\d+\s+failed\s*\|\s*)?(\d+)\s+passed\s*\((\d+)\)", text)
                d = re.search(r"Duration\s+([\d.]+)s", text)
                if m:
                    self.vitest_summaries.append((ts, int(m.group(2)), float(d.group(1)) if d else None))
            elif kind == "notif":
                n = data
                tc = None
                if n.get("task") and n["task"] in bg:
                    tc = bg[n["task"]]
                elif n.get("tool") and n["tool"] in by_tool and by_tool[n["tool"]].bg_task in bg:
                    tc = by_tool[n["tool"]]
                status = (n.get("status") or "").lower()
                if tc is not None and (status in DONE_STATUS or not status):
                    drop_bg(tc, ts, status, n.get("summary", ""))
                if not st["in_turn"] and not fg:
                    st["in_turn"] = True
            elif kind == "asst":
                st["in_turn"] = not data
                st["limited"] = False
            elif kind == "limit":
                st["limited"] = True
                st["in_turn"] = False
                self.limit_hits += 1
            elif kind in ("coord", "prompt", "summary"):
                orphans = [tc for tc in fg.values() if getattr(tc, "orphan", False)]
                if orphans or kind == "summary":
                    # 会话中断后被叫醒（或压缩后接着做）：丢掉一直没回结果的前台调用和一直没通知的后台任务
                    for tc in orphans:
                        fg.pop(tc.id, None)
                    for b in [b for b in bg.values() if getattr(b, "lost", False)]:
                        drop_bg(b, ts, "lost", "", record=False)
                if kind == "coord":
                    stalled = st.pop("stall", False)
                    if orphans or stalled:
                        self.broken += 1
                        orphans = orphans or [None]
                    if (not st["in_turn"] or st["limited"]) and not fg:
                        st["rnd"] += 1
                        k = "会话中断后接着做" if orphans else ("用量上限后接着做" if st["limited"] else trigger_kind(data or ""))
                        self.rounds.append({"idx": st["rnd"], "start": ts, "kind": k,
                                            "text": (data or "")[:120].replace("\n", " ")})
                    elif orphans:
                        st["rnd"] += 1
                        self.rounds.append({"idx": st["rnd"], "start": ts, "kind": "会话中断后接着做", "text": (data or "")[:120].replace("\n", " ")})
                    else:
                        self.inline_msgs += 1
                st["in_turn"] = True
                st["limited"] = False
            elif kind == "compact":
                self.compactions += 1
                st["in_turn"] = True
            elif kind == "interrupt":
                st["in_turn"] = False
        self.last = prev
        # 进行中：从最后一个事件算到 now
        if extend_live and now and now > prev:
            if fg or live_bg(False) or st["in_turn"]:
                state = "干活中"
            else:
                state = "等主会话"
            self.live_state = state
            assign(prev, now, "live")
            self.last = now
        # 没收到通知的后台全量测试（会话中断丢了、被杀了，或进行中还没跑完）
        for tc in list(by_tool.values()):
            if tc.cat == C_FULL and tc.bg_task and tc.bg_end is None:
                self._record_full(tc, None, "后台(没收到结束通知)", "")
            elif tc.cat == C_FULL and tc.bg_task and tc.bg_status == "lost":
                self._record_full(tc, None, "后台(没收到结束通知)", "")
        # 全量测试配上 vitest 自己报的 Test Files / Duration，以及命令自己 echo 的 exit=N
        for r in self.full_runs:
            if not r["end"]:
                continue
            if r["ok"] is None or r["echo"]:
                for ts, code in self.exit_marks:
                    if r["end"] - dt.timedelta(seconds=5) <= ts <= r["end"] + dt.timedelta(minutes=20):
                        r["ok"] = code == 0
                        break
            for ts, files, secs in self.vitest_summaries:
                if r["end"] - dt.timedelta(seconds=5) <= ts <= r["end"] + dt.timedelta(minutes=20) and files >= 50:
                    r["test_files"], r["vitest_sec"] = files, secs
                    break

    def _record_full(self, tc, end, mode, summary):
        ok = None
        m = re.search(r"exit code (\d+)", summary or "")
        if m:
            ok = m.group(1) == "0"
        elif re.search(r"exit=0|exit 0\b", summary or ""):
            ok = True
        if tc.bg_status in ("killed", "stopped"):
            ok = False
        echo = bool(re.search(r"echo\s+[\"']?exit", tc.cmd or ""))
        if echo and mode == "后台":
            ok = None          # 后台命令末尾 echo exit=$?：通知里的退出码是 echo 的，不算数，后面从输出里找 exit=N
        self.full_runs.append({"agent": self.aid, "start": tc.start, "end": end, "mode": mode, "echo": echo,
                               "sec": (end - tc.start).total_seconds() if end else None,
                               "workers": full_test_workers(tc.cmd), "status": tc.bg_status or ("" if end else "?"),
                               "ok": ok, "cmd": re.sub(r"\s+", " ", tc.cmd)[:160], "round": tc.round,
                               "test_files": None, "vitest_sec": None})

    def work_sec(self):
        return sum(v for k, v in self.cat_sec.items() if k in WORK_CATS)


# ---------------------------------------------------------------- 区间并集
def union(intervals):
    iv = sorted((a, b) for a, b in intervals if b > a)
    out = []
    for a, b in iv:
        if out and a <= out[-1][1]:
            if b > out[-1][1]:
                out[-1] = (out[-1][0], b)
        else:
            out.append((a, b))
    return out


def clip(intervals, lo, hi):
    return [(max(a, lo), min(b, hi)) for a, b in intervals if min(b, hi) > max(a, lo)]


def total(intervals):
    return sum((b - a).total_seconds() for a, b in intervals)


def subtract(a_iv, b_iv):
    """a − b，都已是并集。"""
    out = []
    b_iv = list(b_iv)
    for a0, a1 in a_iv:
        cur = a0
        for b0, b1 in b_iv:
            if b1 <= cur or b0 >= a1:
                continue
            if b0 > cur:
                out.append((cur, b0))
            cur = max(cur, b1)
            if cur >= a1:
                break
        if cur < a1:
            out.append((cur, a1))
    return out


# ---------------------------------------------------------------- git
def git_merges(repo):
    try:
        out = subprocess.run(["git", "-C", repo, "log", "main", "--format=%H%x1f%cI%x1f%s"], capture_output=True,
                             text=True, encoding="utf-8", errors="replace", check=True).stdout
    except (OSError, subprocess.CalledProcessError) as e:
        print("git log 失败：", e, file=sys.stderr)
        return {}, {}, {}
    merges, done_docs, subjects = defaultdict(list), {}, {}
    for line in out.splitlines():
        parts = line.split("\x1f")
        if len(parts) < 3:
            continue
        h, ci, subj = parts
        t = parse_ts(ci)
        m = re.search(r"(\d{1,3})\s*号票", subj)
        if not m:
            continue
        n = int(m.group(1))
        if re.match(r"(feat|fix|test|chore|refactor|perf|style)(\(.*?\))?:", subj):
            merges[n].append((t, subj, h[:8]))
        elif re.match(r"docs:\s*\d{1,3}\s*号票完成", subj):
            done_docs.setdefault(n, (t, subj, h[:8]))
    return merges, done_docs, subjects


def ticket_titles(repo):
    titles = {}
    for p in glob.glob(os.path.join(repo, ".scratch", "ergou-v2", "impl", "*.md")):
        m = re.match(r"(\d{1,3})-(.*)\.md$", os.path.basename(p))
        if not m:
            continue
        n = int(m.group(1))
        title = m.group(2)
        try:
            with open(p, encoding="utf-8") as fh:
                for ln in fh:
                    if ln.startswith("#"):
                        title = ln.lstrip("#").strip()
                        break
        except OSError:
            pass
        titles[n] = title
    return titles


def count_shot_pngs(root):
    res = Counter()
    if not root or not os.path.isdir(root):
        return res
    for name in os.listdir(root):
        m = re.match(r"^t(\d{1,3})(?!\d)", name)
        p = os.path.join(root, name)
        if not m or not os.path.isdir(p):
            continue
        n = int(m.group(1))
        for _dp, _dn, files in os.walk(p):
            res[n] += sum(1 for f in files if f.lower().endswith(".png"))
    return res


# ---------------------------------------------------------------- 主会话
def scan_main(path, probe):
    """主会话：每次工具调用（前台时长、类别、提到的 worktree），合并命令，发给子 agent 的消息。"""
    tr = Transcript(path, "main", {"description": "主会话"}, probe, keep_calls=True)
    tr.run()
    merges = defaultdict(list)
    sends = defaultdict(list)
    calls = []
    for tc in tr.calls:
        txt = json.dumps(tc.inp, ensure_ascii=False)
        ids = set(re.findall(r"agent-(a[0-9a-f]{16})", txt))
        if tc.name == "SendMessage":
            to = tc.inp.get("to")
            if to:
                sends[to].append(tc.start)
                ids.add(to)
        if tc.name in ("Bash", "PowerShell") and re.search(r"git\s+merge", tc.cmd):
            for aid in re.findall(r"worktree-agent-(a[0-9a-f]{16})", tc.cmd):
                if tc.end:
                    merges[aid].append(tc.end)
        calls.append((tc, ids))
    return tr, calls, merges, sends


# ---------------------------------------------------------------- 主流程
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--subagents", required=True)
    ap.add_argument("--main")
    ap.add_argument("--repo", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--shots-root")
    ap.add_argument("--notes")
    ap.add_argument("--now")
    ap.add_argument("--samples", action="store_true")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    probe = ScriptProbe([args.shots_root])

    # 1) 子 agent
    agents = []
    files = sorted(glob.glob(os.path.join(args.subagents, "agent-*.jsonl")))
    max_ts = None
    for i, p in enumerate(files, 1):
        aid = os.path.basename(p)[len("agent-"):-len(".jsonl")]
        meta = {}
        mp = p[:-len(".jsonl")] + ".meta.json"
        if os.path.exists(mp):
            try:
                with open(mp, encoding="utf-8") as fh:
                    meta = json.load(fh)
            except ValueError:
                pass
        tr = Transcript(p, aid, meta, probe, keep_calls=args.samples)
        tr.run()
        if tr.start is None:
            continue
        agents.append(tr)
        if tr.last and (max_ts is None or tr.last > max_ts):
            max_ts = tr.last
        if i % 40 == 0:
            print(f"  已解析 {i}/{len(files)} 个子 agent 记录", file=sys.stderr)

    # 2) 主会话
    main_tr, main_calls, main_merges, main_sends = (None, [], {}, {})
    if args.main and os.path.exists(args.main):
        print("  解析主会话 …", file=sys.stderr)
        main_tr, main_calls, main_merges, main_sends = scan_main(args.main, probe)
        if main_tr.last and (max_ts is None or main_tr.last > max_ts):
            max_ts = main_tr.last
    now = parse_ts(args.now) if args.now else max_ts

    # 全局停着的时段：所有记录（主会话 + 子 agent）都没有任何事件超过 15 分钟（夜里、用户不在、用量上限、机器卡死）
    all_t = sorted(t for a in agents for t in a.ev_times)
    if main_tr:
        all_t = sorted(all_t + main_tr.ev_times)
    global_idle = [(a, b) for a, b in zip(all_t, all_t[1:]) if (b - a).total_seconds() >= 15 * 60]

    # 3) git / 票
    merges, done_docs, _ = git_merges(args.repo)
    titles = ticket_titles(args.repo)
    pngs = count_shot_pngs(args.shots_root)

    by_ticket = defaultdict(lambda: defaultdict(list))
    for a in agents:
        if a.ticket is not None:
            by_ticket[a.ticket][a.role].append(a)
    aid2ticket = {a.aid: a.ticket for a in agents if a.ticket is not None and a.role == ROLE_IMPL}

    # 进行中的实现 agent：重算一遍，把最后一个事件到 now 也算上
    for n, roles in by_ticket.items():
        if ROLE_IMPL in roles and not merges.get(n) and n not in done_docs:
            for a in roles[ROLE_IMPL]:
                a2 = Transcript(a.path, a.aid, a.meta, probe)
                a2.run(now=now, extend_live=True)
                idx = agents.index(a)
                agents[idx] = a2
                roles[ROLE_IMPL][roles[ROLE_IMPL].index(a)] = a2

    # 主会话的工具调用归到票
    main_by_ticket = defaultdict(Counter)
    main_full_by_ticket = defaultdict(list)
    for tc, ids in main_calls:
        tks = {aid2ticket[i] for i in ids if i in aid2ticket}
        if len(tks) != 1 or not tc.end:
            continue
        n = tks.pop()
        sec = (tc.end - tc.start).total_seconds()
        main_by_ticket[n][tc.cat] += sec
        if tc.cat == C_FULL:
            main_full_by_ticket[n].append(sec)

    # 4) 每票汇总
    rows = []
    impl_tickets = sorted(n for n, r in by_ticket.items() if ROLE_IMPL in r)
    for n in impl_tickets:
        roles = by_ticket[n]
        impls = sorted(roles[ROLE_IMPL], key=lambda a: a.start)
        revs = roles.get(ROLE_REVIEW, [])
        ress = roles.get(ROLE_RESEARCH, [])
        start = min(a.start for a in impls)
        merge_t, merge_src = None, ""
        if merges.get(n):
            merge_t = max(t for t, _s, _h in merges[n])
            merge_src = "git"
        elif n in done_docs:
            merge_t = done_docs[n][0]
            merge_src = "git(完成)"
        else:
            mm = [t for a in impls for t in main_merges.get(a.aid, [])]
            if mm:
                merge_t, merge_src = max(mm), "主会话 merge"
        status = "已合并" if merge_t else "进行中"
        end = merge_t or now
        wall = (end - start).total_seconds()
        cat = Counter()
        for a in impls:
            cat.update(a.cat_sec)
        work = sum(v for k, v in cat.items() if k in WORK_CATS)
        full_runs = [r for a in impls for r in a.full_runs]
        full_sec = cat[C_FULL]
        rounds = [r for a in impls for r in a.rounds if r["idx"] > 0]
        rework_kinds = Counter(r["kind"] for r in rounds)
        rework_work = sum(sum(v for k, v in rc.items() if k in WORK_CATS) for a in impls for i, rc in a.round_cat.items() if i > 0)
        rev_work = sum(a.work_sec() for a in revs)
        res_work = sum(a.work_sec() for a in ress)
        # 墙钟分解
        impl_iv = union([s[:2] for a in impls for s in a.slices if s[2] in WORK_CATS])
        impl_iv = clip(impl_iv, start, end)
        rev_iv = clip(union([s[:2] for a in revs for s in a.slices if s[2] in WORK_CATS]), start, end)
        rev_only_iv = subtract(rev_iv, impl_iv)
        rev_only = total(rev_only_iv)
        impl_active = total(impl_iv)
        stop_iv = clip(union([s[:2] for a in impls for s in a.slices if s[2] in STOP_CATS]), start, end)
        stop_only = total(subtract(subtract(stop_iv, impl_iv), union(rev_only_iv)))
        rest_iv = subtract(subtract(subtract([(start, end)], impl_iv), union(rev_only_iv)), union(subtract(stop_iv, impl_iv)))
        rest_global = total(subtract(rest_iv, subtract(rest_iv, clip(global_idle, start, end))))
        last_impl = max(a.last for a in impls)
        after_last = (end - last_impl).total_seconds() if merge_t and end > last_impl else 0.0
        shot_sec = sum(cat[c] for c in SHOT_CATS)
        row = {
            "票号": n, "标题": titles.get(n, ""), "状态": status,
            "实现agent数": len(impls), "开始": fmt_t(start), "合并": fmt_t(merge_t) if merge_t else "(进行中)", "合并来源": merge_src,
            "墙钟_分": mins(wall), "实现干活_分": mins(work), "墙钟里实现在干活_分": mins(impl_active),
            "墙钟里只有评审在跑_分": mins(rev_only), "墙钟里停摆(上限/中断/批权限)_分": mins(stop_only),
            "墙钟里全局都停着_分": mins(rest_global),
            "墙钟里其余(主会话/用户/排队)_分": mins(max(0.0, wall - impl_active - rev_only - stop_only - rest_global)),
            "实现结束到合并_分": mins(after_last),
            "等主会话_分": mins(cat[C_WAITMAIN]), "停摆_分": mins(cat[C_LIMIT] + cat[C_BROKEN] + cat[C_PERM]),
            "等用户批权限_分": mins(cat[C_PERM]), "等用户批权限次数": sum(a.perm_hits for a in impls),
            "撞用量上限次数": sum(a.limit_hits for a in impls), "会话中断次数": sum(a.broken for a in impls),
            "全量测试次数": len(full_runs), "全量测试总时长_分": mins(full_sec),
            "全量测试单次中位_分": mins(statistics.median([r["sec"] for r in full_runs if r["sec"]])) if any(r["sec"] for r in full_runs) else 0,
            "全量测试失败或中止次数": sum(1 for r in full_runs if r["ok"] is False),
            "截图相关_分": mins(shot_sec), "截图命令次数": sum(a.shot_cmds for a in impls),
            "看截图张数": sum(a.png_reads for a in impls), "截图目录png数": pngs.get(n, 0),
            "返修轮数": len(rounds), "返修轮_评审": rework_kinds.get("评审返修", 0), "返修轮_会话中断": rework_kinds.get("会话中断后接着做", 0),
            "返修轮_用户": rework_kinds.get("用户改需求/补充", 0), "返修轮_变基": rework_kinds.get("变基/跟进 main", 0),
            "返修干活_分": mins(rework_work), "插话次数": sum(a.inline_msgs for a in impls),
            "评审agent数": len(revs), "评审用时_分": mins(rev_work), "调研agent数": len(ress), "调研用时_分": mins(res_work),
            "主会话核对_分": mins(sum(main_by_ticket[n].values())), "主会话全量测试次数": len(main_full_by_ticket[n]),
            "上下文压缩次数": sum(a.compactions for a in impls),
            "进行中状态": "; ".join(a.live_state for a in impls if a.live_state) if status == "进行中" else "",
        }
        for c in ALL_CATS:
            row["实现_" + c + "_分"] = mins(cat[c])
        rows.append(row)

    # 5) 写 CSV
    if rows:
        with open(os.path.join(args.out, "per_ticket.csv"), "w", encoding="utf-8-sig", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
    with open(os.path.join(args.out, "agents.csv"), "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["agent", "描述", "角色", "票号", "开始", "结束", "干活_分", "轮数", "全量测试次数", "压缩次数"] + [c + "_分" for c in ALL_CATS])
        for a in sorted(agents, key=lambda a: a.start):
            w.writerow([a.aid, a.desc, a.role, a.ticket if a.ticket is not None else "", fmt_t(a.start), fmt_t(a.last),
                        mins(a.work_sec()), len(a.rounds), len(a.full_runs), a.compactions] + [mins(a.cat_sec[c]) for c in ALL_CATS])
    # 全量测试：所有记录（含评审和主会话）
    all_runs = []
    for a in agents:
        for r in a.full_runs:
            all_runs.append(dict(r, who=f"{a.role}:{a.ticket if a.ticket is not None else '-'}", ticket=a.ticket))
    if main_tr:
        for r in main_tr.full_runs:
            all_runs.append(dict(r, who="主会话", ticket=None))
    done_runs = [r for r in all_runs if r["sec"]]
    for r in done_runs:
        r["concurrent"] = sum(1 for o in done_runs if o is not r and o["start"] < r["end"] and o["end"] > r["start"])
    all_runs.sort(key=lambda r: r["start"])
    with open(os.path.join(args.out, "full_tests.csv"), "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["开始", "谁", "agent", "方式", "时长_分", "workers", "同时在跑的其它全量测试", "结果", "测试文件数", "vitest自报_秒", "第几轮", "命令"])
        for r in all_runs:
            w.writerow([fmt_t(r["start"]), r["who"], r["agent"], r["mode"], mins(r["sec"]) if r["sec"] else "", r["workers"],
                        r.get("concurrent", ""), {True: "通过", False: "失败/中止", None: ""}[r["ok"]], r["test_files"] or "",
                        r["vitest_sec"] or "", r["round"], r["cmd"]])

    if args.samples:
        write_samples(agents, os.path.join(args.out, "samples.txt"))

    notes = ""
    if args.notes and os.path.exists(args.notes):
        with open(args.notes, encoding="utf-8") as fh:
            notes = fh.read()
    write_report(args.out, rows, agents, all_runs, main_by_ticket, now, notes, by_ticket, global_idle, main_tr)
    print(f"完成：{len(agents)} 个子 agent，{len(rows)} 张票。输出在 {args.out}", file=sys.stderr)


def write_samples(agents, path):
    per = defaultdict(list)
    for a in agents:
        for tc in a.calls:
            if tc.name in ("Bash", "PowerShell"):
                per[tc.cat].append(re.sub(r"\s+", " ", tc.cmd)[:220])
    import random
    random.seed(1)
    with open(path, "w", encoding="utf-8") as fh:
        for c, lst in sorted(per.items(), key=lambda x: -len(x[1])):
            fh.write(f"===== {c}  ({len(lst)} 条)\n")
            for s in random.sample(lst, min(25, len(lst))):
                fh.write("  " + s + "\n")


# ---------------------------------------------------------------- 报告
def pct(a, b):
    return f"{100.0 * a / b:.0f}%" if b else "-"


def write_report(out, rows, agents, all_runs, main_by_ticket, now, notes, by_ticket, global_idle=(), main_tr=None):
    L = []
    impl_agents = [a for a in agents if a.role == ROLE_IMPL and a.ticket is not None]
    rev_agents = [a for a in agents if a.role == ROLE_REVIEW]
    res_agents = [a for a in agents if a.role == ROLE_RESEARCH]
    oth_agents = [a for a in agents if a not in impl_agents and a not in rev_agents and a not in res_agents]
    n_merged = sum(1 for r in rows if r["状态"] == "已合并")
    L.append("# 二狗 v2：每张票的时间耗在哪里\n")
    L.append(f"数据截至 {fmt_t(now)}（东八区）。子 agent 记录 {len(agents)} 个：实现 {len(impl_agents)}、评审 {len(rev_agents)}、"
             f"调研 {len(res_agents)}、其它 {len(oth_agents)}；有实现 agent 的票 {len(rows)} 张"
             f"（已合并 {n_merged}，进行中 {len(rows) - n_merged}）。"
             "由 `ticket_timing.py` 生成，重跑会覆盖本文件；明细在 `per_ticket.csv`、`agents.csv`、`full_tests.csv`。\n")
    if notes:
        L.append(notes.rstrip() + "\n")

    # 一、总排行
    tot = Counter()
    for a in impl_agents:
        tot.update(a.cat_sec)
    work = sum(v for k, v in tot.items() if k in WORK_CATS)
    L.append("## 一、实现 agent 的时间总排行\n")
    L.append(f"所有实现 agent 合计干活 **{work / 3600:.1f} 小时**；另有停摆（用量上限、会话中断/卡死、等用户批权限）"
             f"{(tot[C_LIMIT] + tot[C_BROKEN] + tot[C_PERM]) / 3600:.1f} 小时、等主会话 {tot[C_WAITMAIN] / 3600:.1f} 小时，都不算干活。"
             f"评审 agent 合计干活 {sum(a.work_sec() for a in rev_agents) / 3600:.1f} 小时，调研 agent {sum(a.work_sec() for a in res_agents) / 3600:.1f} 小时。\n")
    L.append("| 类别 | 小时 | 占实现干活 |")
    L.append("|---|---:|---:|")
    for c, v in sorted(((c, tot[c]) for c in WORK_CATS), key=lambda x: -x[1]):
        if v >= 36:
            L.append(f"| {c} | {v / 3600:.1f} | {pct(v, work)} |")
    small = [c for c in WORK_CATS if 0 < tot[c] < 36]
    if small:
        L.append(f"| 其余（{'、'.join(small)}） | {sum(tot[c] for c in small) / 3600:.2f} | {pct(sum(tot[c] for c in small), work)} |")
    for c in STOP_CATS + [C_WAITMAIN]:
        L.append(f"| *(不算干活)* {c} | {tot[c] / 3600:.1f} | — |")
    L.append("")
    grp = [
        ("测试：全量", [C_FULL]),
        ("测试：部分+类型检查+lint+构建+装依赖", [C_PART, C_TSC, C_LINT, C_BUILD, C_INSTALL]),
        ("截图：截图脚本+看截图（含读图后的思考）+图片处理", [C_SHOT, C_VIEW, C_IMG]),
        ("模型思考/写字 + 上下文压缩", [C_MODEL, C_COMPACT]),
        ("读写代码文档 + git", [C_READ, C_EDIT, C_GIT]),
        ("等待：排队等机器+查进程/等待", [C_QUEUE, C_WAIT]),
        ("其它", [C_SERVE, C_WEB, C_AGENT, C_OTHERCMD, C_OTHERTOOL]),
    ]
    L.append("按大块合并：\n")
    L.append("| 大块 | 小时 | 占实现干活 |")
    L.append("|---|---:|---:|")
    for g, cs in grp:
        v = sum(tot[c] for c in cs)
        L.append(f"| {g} | {v / 3600:.1f} | {pct(v, work)} |")
    L.append("")
    # 墙钟合计分解
    keys = [("实现在干活", "墙钟里实现在干活_分"), ("只有评审在跑", "墙钟里只有评审在跑_分"),
            ("实现停摆（用量上限、会话中断/卡死、等用户批权限）", "墙钟里停摆(上限/中断/批权限)_分"),
            ("全局都停着（夜里、用户不在、所有记录都没动静）", "墙钟里全局都停着_分"),
            ("其余（主会话在核对/合并/忙别的票、问用户）", "墙钟里其余(主会话/用户/排队)_分")]
    wall_sum = sum(r["墙钟_分"] for r in rows)
    L.append(f"所有票的墙钟（实现开始→合并）合计 {wall_sum / 60:.1f} 小时（票之间并行，所以比日历时间长），拆开是：\n")
    L.append("| 部分 | 小时 | 占墙钟 |")
    L.append("|---|---:|---:|")
    for name, k in keys:
        v = sum(r[k] for r in rows)
        L.append(f"| {name} | {v / 60:.1f} | {pct(v, wall_sum)} |")
    L.append("")

    # 二、每票一行
    L.append("## 二、每张票一行\n")
    L.append("单位：分钟。墙钟 = 实现 agent 开始 → main 上的合并提交（进行中的票算到数据截至时间）。实现干活 = 实现 agent 所有非等待、非停摆段之和"
             "（后台全量测试时 agent 空等也算在全量测试里）。截图 = 截图脚本 + 看截图（含读图后的思考）+ 图片处理。停摆 = 撞用量上限 + 会话中断/卡死 + 等用户批权限。"
             "等主会话 = 实现 agent 交了活之后、主会话下一条消息之前（里面有评审在跑、主会话在核对、问用户、夜里）。\n")
    L.append("| 票 | 标题 | 状态 | 墙钟 | 实现干活 | 模型 | 全量测试 次/分 | 部分测试 | 截图 | 返修轮 | 等主会话 | 停摆 | 评审 | 实现后到合并 |")
    L.append("|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for r in sorted(rows, key=lambda r: r["票号"]):
        title = re.sub(r"^\d+\s*[—-]\s*", "", r["标题"])[:20]
        L.append(f"| {r['票号']} | {title} | {r['状态']} | {r['墙钟_分']:.0f} | {r['实现干活_分']:.0f} | {r['实现_' + C_MODEL + '_分']:.0f} | "
                 f"{r['全量测试次数']}/{r['全量测试总时长_分']:.0f} | {r['实现_' + C_PART + '_分']:.0f} | {r['截图相关_分']:.0f} | {r['返修轮数']} | "
                 f"{r['等主会话_分']:.0f} | {r['停摆_分']:.0f} | {r['评审用时_分']:.0f} | {r['实现结束到合并_分']:.0f} |")
    L.append("")

    def ticket_block(r, head="###"):
        cats = sorted(((c, r["实现_" + c + "_分"]) for c in WORK_CATS), key=lambda x: -x[1])
        top = "、".join(f"{c} {v:.0f}" for c, v in cats[:6] if v >= 1)
        title = re.sub(r"^\d+\s*[—-]\s*", "", r["标题"])[:40]
        B = [f"{head} {r['票号']} 号票 {title}（{r['状态']}{'，' + r['进行中状态'] if r['进行中状态'] else ''}）\n"]
        B.append(f"- 墙钟 {r['墙钟_分']:.0f} 分（{r['开始']} → {r['合并']}）= 实现在干活 {r['墙钟里实现在干活_分']:.0f} + 只有评审在跑 {r['墙钟里只有评审在跑_分']:.0f} + "
                 f"停摆 {r['墙钟里停摆(上限/中断/批权限)_分']:.0f} + 全局都停着 {r['墙钟里全局都停着_分']:.0f} + 其余（主会话核对/问用户/排队合并）{r['墙钟里其余(主会话/用户/排队)_分']:.0f}；"
                 f"实现做完到合并 {r['实现结束到合并_分']:.0f} 分。")
        B.append(f"- 实现干活 {r['实现干活_分']:.0f} 分，前几项：{top}。")
        B.append(f"- 全量测试 {r['全量测试次数']} 次共 {r['全量测试总时长_分']:.0f} 分（单次中位 {r['全量测试单次中位_分']:.0f} 分，失败/中止 {r['全量测试失败或中止次数']} 次）；"
                 f"截图相关 {r['截图相关_分']:.0f} 分（截图命令 {r['截图命令次数']} 次、看截图 {r['看截图张数']} 张、截图目录 png {r['截图目录png数']} 个）。")
        B.append(f"- 返修 {r['返修轮数']} 轮（评审 {r['返修轮_评审']}、用户 {r['返修轮_用户']}、变基 {r['返修轮_变基']}、会话中断后接着做 {r['返修轮_会话中断']}），返修干活 {r['返修干活_分']:.0f} 分；"
                 f"等主会话 {r['等主会话_分']:.0f} 分；停摆 {r['停摆_分']:.0f} 分（撞用量上限 {r['撞用量上限次数']} 次、会话中断/卡死 {r['会话中断次数']} 次、等用户批权限 {r['等用户批权限次数']} 次 {r['等用户批权限_分']:.0f} 分）；"
                 f"评审 agent {r['评审agent数']} 个共 {r['评审用时_分']:.0f} 分；上下文压缩 {r['上下文压缩次数']} 次。\n")
        return B

    # 三、最慢 10 张
    L.append("## 三、墙钟最长的 10 张票，时间耗在哪\n")
    for r in sorted(rows, key=lambda r: -r["墙钟_分"])[:10]:
        L.extend(ticket_block(r))
    L.append("## 四、实现干活最多的 10 张票\n")
    L.append("| 票 | 实现干活 | 模型 | 全量测试 | 部分测试 | 截图 | 其它前三 |")
    L.append("|---:|---:|---:|---:|---:|---:|---|")
    for r in sorted(rows, key=lambda r: -r["实现干活_分"])[:10]:
        rest = sorted(((c, r["实现_" + c + "_分"]) for c in WORK_CATS if c not in (C_MODEL, C_FULL, C_PART) and c not in SHOT_CATS), key=lambda x: -x[1])[:3]
        L.append(f"| {r['票号']} | {r['实现干活_分']:.0f} | {r['实现_' + C_MODEL + '_分']:.0f} | {r['全量测试总时长_分']:.0f} | {r['实现_' + C_PART + '_分']:.0f} | "
                 f"{r['截图相关_分']:.0f} | {'、'.join(f'{c} {v:.0f}' for c, v in rest if v >= 1)} |")
    L.append("")

    # 最近的票
    L.append("## 五、最近开工的 3 张票\n")
    for r in sorted(rows, key=lambda r: r["开始"])[-3:]:
        L.extend(ticket_block(r))

    # 六、全量测试随时间
    L.append("## 六、全量测试单次时长随时间的变化\n")
    runs = [r for r in all_runs if r["sec"] and r["sec"] > 0]
    lost = [r for r in all_runs if not r["sec"]]
    L.append(f"共 {len(all_runs)} 次全量测试（实现、评审、主会话都算；`npm run check` 含类型检查和 lint），有起止时间的 {len(runs)} 次，"
             f"另有 {len(lost)} 次没收到结束通知（会话中断时丢了，或还在跑）。时长 = 发命令 → 结束通知（墙钟，含排队和机器争用）。"
             "\"同时在跑\" = 和它时间上重叠的其它全量测试个数。\n")
    by_day = defaultdict(list)
    for r in runs:
        lt = loc(r["start"])
        half = "0-12 点" if lt.hour < 12 else "12-24 点"
        by_day[(lt.strftime("%m-%d"), half)].append(r)
    L.append("| 日期 | 时段 | 次数 | 中位(分) | 最长(分) | 测试文件数(中位) | 同时在跑(中位) | 失败/中止 |")
    L.append("|---|---|---:|---:|---:|---:|---:|---:|")
    for (d, h), lst in sorted(by_day.items()):
        secs = [r["sec"] for r in lst]
        tf = [r["test_files"] for r in lst if r["test_files"]]
        cc = [r.get("concurrent", 0) for r in lst]
        L.append(f"| {d} | {h} | {len(lst)} | {statistics.median(secs) / 60:.1f} | {max(secs) / 60:.1f} | "
                 f"{statistics.median(tf) if tf else '-'} | {statistics.median(cc):.0f} | {sum(1 for r in lst if r['ok'] is False)} |")
    L.append("")
    L.append("按 workers 和同时在跑的个数看：\n")
    L.append("| ERGOU_TEST_WORKERS | 次数 | 中位(分) |")
    L.append("|---|---:|---:|")
    by_w = defaultdict(list)
    for r in runs:
        by_w[r["workers"]].append(r["sec"])
    for w_, lst in sorted(by_w.items(), key=lambda x: -len(x[1])):
        L.append(f"| {w_} | {len(lst)} | {statistics.median(lst) / 60:.1f} |")
    L.append("")
    L.append("| 同时在跑的其它全量测试 | 次数 | 中位(分) | 只看 10-09 之后(中位) |")
    L.append("|---|---:|---:|---:|")
    by_c = defaultdict(list)
    for r in runs:
        by_c[min(r.get("concurrent", 0), 4)].append(r)
    for k, lst in sorted(by_c.items()):
        late = [r["sec"] for r in lst if loc(r["start"]).strftime("%m-%d") >= "10-09"]
        L.append(f"| {k if k < 4 else '4+'} | {len(lst)} | {statistics.median([r['sec'] for r in lst]) / 60:.1f} | "
                 f"{(statistics.median(late) / 60) if late else 0:.1f} |")
    L.append("")

    # 七、全局停着的时段
    L.append("## 七、所有记录都没动静的时段（≥ 60 分钟）\n")
    L.append("主会话和所有子 agent 都没有任何事件。多半是夜里、用户不在、撞了用量上限或机器卡死。\n")
    L.append("| 从 | 到 | 分钟 |")
    L.append("|---|---|---:|")
    for a, b in global_idle:
        m = (b - a).total_seconds() / 60
        if m >= 60:
            L.append(f"| {fmt_t(a)} | {fmt_t(b)} | {m:.0f} |")
    L.append("")

    # 八、自动算出的几个数
    L.append("## 八、几个关键数字（脚本自动算）\n")
    merged = [r for r in rows if r["状态"] == "已合并"]
    full_n = sum(r["全量测试次数"] for r in rows)
    fail_n = sum(r["全量测试失败或中止次数"] for r in rows)
    shot = sum(r["截图相关_分"] for r in rows)
    L.append(f"- 实现 agent 跑全量测试共 {full_n} 次，平均每票 {full_n / max(1, len(rows)):.1f} 次，其中失败/中止 {fail_n} 次；"
             f"每票 ≥5 次的有 {sum(1 for r in rows if r['全量测试次数'] >= 5)} 张；实现 agent 的全量测试合计 {sum(r['全量测试总时长_分'] for r in rows) / 60:.1f} 小时。")
    L.append(f"- 截图相关合计 {shot / 60:.1f} 小时，占实现干活 {pct(shot * 60, work)}；有截图的票 {sum(1 for r in rows if r['截图相关_分'] >= 1)} 张；"
             f"截图最多的 5 张：{'、'.join(str(r['票号']) + ' 号 ' + format(r['截图相关_分'], '.0f') + ' 分' for r in sorted(rows, key=lambda r: -r['截图相关_分'])[:5])}。")
    L.append(f"- 返修合计 {sum(r['返修轮数'] for r in rows)} 轮（评审 {sum(r['返修轮_评审'] for r in rows)}、用户 {sum(r['返修轮_用户'] for r in rows)}、"
             f"变基 {sum(r['返修轮_变基'] for r in rows)}、会话中断后接着做 {sum(r['返修轮_会话中断'] for r in rows)}），返修干活 {sum(r['返修干活_分'] for r in rows) / 60:.1f} 小时。")
    L.append(f"- 已合并的票：墙钟中位 {statistics.median([r['墙钟_分'] for r in merged]) if merged else 0:.0f} 分，"
             f"实现干活中位 {statistics.median([r['实现干活_分'] for r in merged]) if merged else 0:.0f} 分，"
             f"实现做完到合并中位 {statistics.median([r['实现结束到合并_分'] for r in merged]) if merged else 0:.0f} 分。")
    L.append(f"- 撞用量上限 {sum(r['撞用量上限次数'] for r in rows)} 次、会话中断/卡死 {sum(r['会话中断次数'] for r in rows)} 次、"
             f"等用户批权限 {sum(r['等用户批权限次数'] for r in rows)} 次（{sum(r['等用户批权限_分'] for r in rows):.0f} 分），"
             f"实现 agent 停摆合计 {sum(r['停摆_分'] for r in rows) / 60:.1f} 小时。")
    L.append("")

    if main_tr is not None and main_tr.start:
        mt = main_tr.cat_sec
        span = (main_tr.last - main_tr.start).total_seconds()
        L.append("## 九、主会话自己的时间\n")
        L.append(f"主会话从 {fmt_t(main_tr.start)} 到 {fmt_t(main_tr.last)}，共 {span / 3600:.1f} 小时。主会话用 Agent 派出的后台子 agent 在跑、它自己空着时，"
                 "算在\"子agent\"里；\"等用户批权限\"在主会话里基本都是 AskUserQuestion 等用户回答。\n")
        L.append("| 类别 | 小时 |")
        L.append("|---|---:|")
        for c, v in mt.most_common():
            if v >= 360:
                L.append(f"| {c} | {v / 3600:.1f} |")
        L.append(f"\n主会话上下文压缩 {main_tr.compactions} 次，问用户/等批准 {main_tr.perm_hits} 次，撞用量上限 {main_tr.limit_hits} 次。"
                 f"主会话里提到某张票 worktree 的工具调用（核对 diff、跑测试、合并）合计 {sum(sum(c.values()) for c in main_by_ticket.values()) / 3600:.1f} 小时，"
                 "按票见 `per_ticket.csv` 的\"主会话核对_分\"。\n")
    L.append(RULES)
    with open(os.path.join(out, "report.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(L) + "\n")


RULES = """## 分类规则与误差

**怎么认票和角色**：看子 agent 旁边 `.meta.json` 的 description（`Implement ticket NN …`、`Resume ticket NN`、`… review of ticket NN`、`Research …`），
没写票号时从第一条提示词里找"实现/负责/评审 … NN 号票"。一张票可能有几个实现 agent（中途断了再派 `Resume ticket`），合在一起算。
没有票号的实现类 agent（修录像测试、语音长按菜单、附件等说完再发）和调研、写票的 agent 不进每票表，只进总数和 `agents.csv`。

**时间怎么切**（每个记录内部）：所有事件按时间戳排序，相邻事件之间那一段按当时状态归类——
1. 有前台工具调用没回结果（tool_use → tool_result）：归这个工具的类别；一条消息里并行发了几个就平分。
2. 前台是"等待"类（sleep、until 循环、`tail -f`、Monitor）而自己有后台命令（如后台全量测试）在跑：算进后台命令的类别。
3. 前台工具超过它自己的超时（Bash/PowerShell 取 timeout 参数，默认 2 分钟，最多 10 分钟，再加 2 分钟余量；读写文件 5 分钟）还没回结果：
   多出来的算"会话中断/卡死"（机器卡死或休眠，工具本该早就超时返回）。结果里 `permissionDecision.source` 是 user 的调用（要用户点"允许"才执行），整段算"等用户批权限"。
4. 没有前台工具、agent 在回合里：模型（思考和写字，也包括 API 排队/重试）。读完截图（Read 了图片）之后的那段思考算"看截图"。
   紧接着 `compact_boundary` / 压缩摘要的那段（最多 10 分钟）算上下文压缩。
5. 回合里超过 15 分钟没有任何输出、或超过 5 分钟没输出然后来的是主会话"接着做"；或者有工具调用一直没回结果、下一条就是主会话的消息：都算"会话中断/卡死"，
   这之后算"会话中断后接着做"一轮。一直没收到结束通知的后台任务（会话中断时丢了），在下一次被叫醒时作废，不再占时间。
6. 撞了用量上限（`error: rate_limit`，"You've hit your weekly limit"）之后、下一条真正的输出之前：算"撞用量上限停摆"（期间自己的后台测试还在跑就先算测试）。
7. agent 已经 end_turn：自己有后台命令在跑 → 归后台命令；没有 → 下一条是主会话 SendMessage 来的消息就算"等主会话(含评审)"，不算干活，
   这条消息之后算返修第 N 轮（按消息内容分：提到评审 → 评审返修；提到用户 → 用户改需求；提到合进 main / 变基 → 变基跟进）。
   agent 干活时插进来的消息只算"插话"，不算新一轮。
8. 后台命令（`run_in_background`、前台超时转后台、Monitor、后台子 agent）从发出到对得上 task-id / tool-use-id 的 `<task-notification>` 为止；TaskStop 也算结束。
9. 进行中的票：最后一个事件到数据截至时间那段，agent 还在回合里就算干活（归当时在跑的工具），已 end_turn 就算等主会话。

**Bash / PowerShell 命令分类**（先剥掉 heredoc 正文和 commit 信息，按下面顺序第一条命中为准）：
全量测试（`npm run check` / `npm test` 不带 `-w`、不在 packages/ 子目录；`vitest run` 不带文件、目录、`-t`、`--project`；名字像 full-run 的包装脚本）→
单个/部分测试（`vitest run` 带文件或目录、`-t`、`--project`；`npm test -w`）→ 截图/浏览器脚本（agent-browser、playwright、
`node xxx.mjs` 且脚本里有 playwright/chromium，找不到脚本时按文件名猜；名字带 shot 的 .ps1/.sh）→ 构建（build:web、vite build、hvigor）→
类型检查（tsc、typecheck）→ lint（oxlint）→ 装依赖（npm ci / install）→ 图片处理（PIL、magick、ffmpeg、System.Drawing）→
排队等机器（循环里查进程，等别的 worktree 的全量测试跑完；wait-vitest 一类脚本）→ 查进程/等待（tasklist、Get-CimInstance、sleep、tail -f）→
git（rebase、commit、merge 等会改东西的）→ 改代码文档（bash 里 python/sed -i/cat > 改了文件，以 toolUseResult 里的 bashEditDiff 为准）→
服务/curl → 读代码文档（cat、sed -n、grep、ls、git diff/log/status 等）→ 其它命令。
非 Bash 工具：Read 图片 = 看截图；Read 其它、Grep、Glob = 读代码文档；Edit、Write = 改代码文档；WebFetch、WebSearch = 联网查资料；Agent = 子 agent；其余 = 其它工具。

**全量测试的一次**：每条被分成全量测试的命令算一次（不到 8 秒就回来的前台命令不算，多半是 `&&` 前面就失败了）。成功/失败看命令输出里的
`exit=N`、vitest 的 `Test Files … failed`，或通知里的退出码（命令末尾 `echo exit=$?` 时通知里的退出码不算数）。"同时在跑" = 和它时间重叠的其它全量测试数。

**墙钟分解**：[实现开始, 合并提交] 这段里，实现 agent 干活段的并集 = "实现在干活"；评审 agent 干活段减去前者 = "只有评审在跑"；
实现 agent 的停摆段再减去前两者 = "停摆"；剩下的时间里，所有记录（主会话 + 全部子 agent）都超过 15 分钟没有任何事件的部分 = "全局都停着"
（夜里、用户不在、撞上限）；最后剩下的 = "其余"（主会话在核对/合并/忙别的票、在问用户）。"实现结束到合并" = 实现 agent 最后一个事件到合并提交。

**合并时间**：main 上主题里第一个"NN 号票"是这张票、类型是 feat/fix/test/chore 的提交里最晚的提交时间（committer date）；没有就用"docs: NN 号票完成"；
再没有就用主会话里 `git merge worktree-agent-…` 命令的时间；都没有 = 进行中。个别票合并后实现 agent 还做了点收尾，所以实现干活可能略大于墙钟。

**误差在哪**：
- 时间戳是每条记录写入的时间，模型一边流式输出一边可能已经开始跑工具，"模型"和"工具"的分界有秒级误差；并行工具平分是近似。
- 一条命令里串了几件事（如 `npm ci && npm run check`、`build:web && node shots.mjs`）只归优先级最高的那一类，装依赖、构建会被低估。
- `npm run check` 含类型检查和 lint（约 1 分钟），全部算进全量测试。全量测试时长是墙钟，含和别的 worktree 争 CPU 的时间。
- 后台全量测试跑着时 agent 若在前台干别的，那段算前台的类别，所以"实现_全量测试_分"小于 `full_tests.csv` 里各次时长之和。
- "看截图"= Read 图片本身（几乎是 0）+ 之后那段思考；看完图紧接着写代码的思考也被算进看截图，会略高估；截图脚本里顺带的构建算进截图。
- 截图目录 png 数只数 scratchpad 下 `tNN*` 命名的目录，别处存的截图没数到；"截图命令次数"只数文件名像截图的脚本和 `screenshot` 命令。
- "会话中断/卡死"靠规则推断（超时还没回、长时间无输出后被叫醒），实际原因可能是机器卡死、休眠或 Claude Code 重启，分不开；等用户批权限的那几次把命令本身执行的几分钟也算进去了。
- "等主会话"里混着评审在跑、主会话在核对、主会话在问用户、用户还没回、夜里，单从子 agent 记录分不开；墙钟分解里用评审 agent 的时间段和"全局都停着"扣出了一部分。
- 主会话自己（核对 diff、跑测试、合并、部署）的时间只粗算了提到该 worktree 的工具调用（`主会话核对_分`），主会话的模型时间没有归到票上。
- 子 agent 在两轮之间被主会话的消息叫醒才算新一轮；评审意见在 agent 还在干活时插进来的，算"插话"不算新一轮。
"""


if __name__ == "__main__":
    main()
