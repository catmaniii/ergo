// ergo.exe：ergo 命令的小启动器（318 号票）。只做一件事：找到安装里的 node，跑命令行 app\packages\daemon\src\cli\main.js，
// 参数原样交过去，退出码原样交回。用 Windows 自带的 C# 编译器编（packages/daemon/build/launcher.ts）；编不了、或者被杀毒软件拦了，
// 用同目录的 ergo.cmd（同样的事，批处理写的）。
//
// 它在哪儿都认：
//   <安装目录>\bin\ergo.exe        → 读 <安装目录>\current（一行文本，写着在用的版本目录的名字）找到版本目录
//   <版本目录>\ergo.exe            → 用这个版本目录本身
// 版本目录里：node\node.exe（安装包自带的 Node）；用系统 Node 装的（-UseSystemNode）没有 node\，改看 node.path 里写的路径。
using System;
using System.Diagnostics;
using System.IO;
using System.Text;

static class ErgoLauncher
{
    static int Main(string[] args)
    {
        string exe = Process.GetCurrentProcess().MainModule.FileName;
        string dir = Path.GetDirectoryName(exe);
        string home = FindHome(dir);
        if (home == null)
        {
            Console.Error.WriteLine("ergo: 找不到安装的版本目录（" + dir + "\\..\\current 写的版本没装好）。重新装一遍试试。");
            Console.Error.WriteLine("ergo: cannot find the installed version (" + dir + "\\..\\current does not point at an installed version). Please reinstall.");
            return 1;
        }
        string node = FindNode(home);
        if (node == null)
        {
            Console.Error.WriteLine("ergo: 版本目录 " + home + " 里没有 node\\node.exe，也没有 node.path。重新装一遍试试。");
            Console.Error.WriteLine("ergo: no node\\node.exe or node.path in " + home + ". Please reinstall.");
            return 1;
        }
        string main = Path.Combine(home, "app", "packages", "daemon", "src", "cli", "main.js");
        var line = new StringBuilder();
        line.Append(Quote(main));
        foreach (string a in args) { line.Append(' '); line.Append(Quote(a)); }

        var psi = new ProcessStartInfo(node, line.ToString());
        psi.UseShellExecute = false;
        psi.EnvironmentVariables["ERGO_LAUNCHER"] = exe;
        psi.EnvironmentVariables["ERGO_HOME"] = home;
        // Ctrl+C 两个进程都收到：启动器自己不退，等 node 处理完、按它的退出码退
        Console.CancelKeyPress += (s, e) => { e.Cancel = true; };
        try
        {
            using (Process p = Process.Start(psi))
            {
                p.WaitForExit();
                return p.ExitCode;
            }
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("ergo: 起不来 " + node + "：" + e.Message);
            return 1;
        }
    }

    static string FindHome(string dir)
    {
        // <版本目录>\ergo.exe：自己就在版本目录里
        if (File.Exists(Path.Combine(dir, "ergo.json"))) return dir;
        string root = Path.GetDirectoryName(dir) ?? dir;
        string pointer = Path.Combine(root, "current");
        // 装好的：<安装目录>\current 是一行文本，写着在用的版本目录的名字
        if (File.Exists(pointer))
        {
            string name = File.ReadAllText(pointer).Trim();
            if (name.Length == 0) return null;
            string version = Path.Combine(Path.Combine(root, "versions"), name);
            return File.Exists(Path.Combine(version, "ergo.json")) ? version : null;
        }
        // 老安装：current 是指向版本目录的目录联接
        if (Directory.Exists(pointer) && File.Exists(Path.Combine(pointer, "ergo.json"))) return pointer;
        return null;
    }

    static string FindNode(string home)
    {
        string bundled = Path.Combine(home, "node", "node.exe");
        if (File.Exists(bundled)) return bundled;
        string pointer = Path.Combine(home, "node.path");
        if (File.Exists(pointer))
        {
            string p = File.ReadAllText(pointer).Trim();
            if (p.Length > 0 && File.Exists(p)) return p;
        }
        return null;
    }

    // 按 CommandLineToArgvW 的规矩给一个参数加引号（Node 按同样的规矩拆）
    static string Quote(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
        var sb = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in arg)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { sb.Append('\\', slashes * 2 + 1); sb.Append('"'); slashes = 0; continue; }
            sb.Append('\\', slashes); slashes = 0; sb.Append(c);
        }
        sb.Append('\\', slashes * 2);
        sb.Append('"');
        return sb.ToString();
    }
}
