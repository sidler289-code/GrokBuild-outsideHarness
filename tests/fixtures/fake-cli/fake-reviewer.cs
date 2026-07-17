using System;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;

internal static class FakeReviewer
{
    private static string Env(string name, string fallback)
    {
        var value = Environment.GetEnvironmentVariable(name);
        return string.IsNullOrEmpty(value) ? fallback : value;
    }

    private static bool Has(string[] args, string value)
    {
        foreach (var arg in args) if (arg == value) return true;
        return false;
    }

    private static string WindowsToLinux(string value)
    {
        value = value.Replace('\\', '/');
        if (value.Length >= 3 && char.IsLetter(value[0]) && value[1] == ':' && value[2] == '/')
            return "/mnt/" + char.ToLowerInvariant(value[0]) + value.Substring(2);
        return value;
    }

    private static string LinuxToWindows(string value)
    {
        if (value.StartsWith("/mnt/", StringComparison.Ordinal) && value.Length > 7 && value[6] == '/')
            return char.ToUpperInvariant(value[5]) + ":\\" + value.Substring(7).Replace('/', '\\');
        return value;
    }

    public static int Main(string[] args)
    {
        var location = Assembly.GetExecutingAssembly().Location;
        var isWsl = string.Equals(Path.GetFileName(location), "wsl.exe", StringComparison.OrdinalIgnoreCase);
        if (isWsl)
        {
            var separator = Array.IndexOf(args, "--");
            if (separator < 0 || separator + 1 >= args.Length) return 64;
            var inner = new string[args.Length - separator - 1];
            Array.Copy(args, separator + 1, inner, 0, inner.Length);
            if (inner[0] == "sh")
            {
                var kind = inner[inner.Length - 1].IndexOf("claude", StringComparison.Ordinal) >= 0 ? "claude" : "codex";
                Console.WriteLine(Env("FAKE_WSL_DISTRO", "fake-distro"));
                Console.WriteLine("/usr/local/bin/" + kind);
                return 0;
            }
            if (inner[0] == "wslpath")
            {
                Console.WriteLine(WindowsToLinux(inner[inner.Length - 1]));
                return 0;
            }
            args = new string[inner.Length - 1];
            Array.Copy(inner, 1, args, 0, args.Length);
        }

        var version = Env("FAKE_CLI_VERSION", "9.0.0");
        if (location.IndexOf("path-old", StringComparison.OrdinalIgnoreCase) >= 0) version = "2.9.0";
        if (location.IndexOf("path-new", StringComparison.OrdinalIgnoreCase) >= 0) version = "10.1.0";
        var mode = Env("FAKE_CLI_MODE", "success");
        if (location.IndexOf("path-bad", StringComparison.OrdinalIgnoreCase) >= 0) mode = "version-fail";
        var reviewer = Env("FAKE_CLI_REVIEWER", "codex");
        var task = Env("FAKE_CLI_TASK", "code");

        if (Has(args, "--version"))
        {
            if (mode == "version-fail") { Console.Error.WriteLine("broken executable"); return 7; }
            if (mode == "version-invalid") { Console.WriteLine("version unknown"); return 0; }
            if (mode == "version-timeout") Thread.Sleep(8000);
            Console.WriteLine(reviewer + "-cli " + version);
            return 0;
        }

        var input = Console.In.ReadToEnd();
        var argsFile = Environment.GetEnvironmentVariable("FAKE_CLI_ARGS_FILE");
        var stdinFile = Environment.GetEnvironmentVariable("FAKE_CLI_STDIN_FILE");
        if (!string.IsNullOrEmpty(argsFile)) File.WriteAllLines(argsFile, args, new UTF8Encoding(false));
        if (!string.IsNullOrEmpty(stdinFile)) File.WriteAllText(stdinFile, input, new UTF8Encoding(false));
        if (mode == "timeout") { Thread.Sleep(8000); return 0; }
        if (mode == "quota") { Console.Error.WriteLine("Quota exhausted: usage limit reached."); return 1; }
        if (mode == "auth") { Console.Error.WriteLine("Authentication failed: login required."); return 1; }
        if (mode == "permission") { Console.Error.WriteLine("Permission denied by read-only sandbox."); return 1; }
        if (mode == "process-fail") { Console.Error.WriteLine("unexpected process failure"); return 9; }
        if (mode == "oversized-stderr") Console.Error.Write(new string('x', 40000));

        string outputPath = null;
        for (var i = 0; i + 1 < args.Length; i++) if (args[i] == "-o") outputPath = args[i + 1];
        string payload;
        if (mode == "invalid-output")
        {
            payload = "this is not json";
        }
        else if (mode == "out-of-scope-finding")
        {
            payload = "{\"schemaVersion\":1,\"task\":\"" + task + "\",\"reviewer\":\"" + reviewer +
              "\",\"status\":\"success\",\"capability\":{\"version\":\"" + version +
              "\",\"runtime\":null,\"source\":\"fixture\",\"reason\":null},\"summary\":\"Fake reviewer completed with an out-of-scope finding.\",\"findings\":[{\"severity\":\"high\",\"category\":\"correctness\",\"title\":\"Out of scope finding\",\"evidence\":{\"file\":\"definitely-not-in-scope-zzz.txt\",\"line\":1,\"symbol\":null,\"reason\":\"Invented whole-repo issue.\"},\"recommendation\":\"Ignore unless host gate fails.\",\"confidence\":0.9,\"verification\":\"candidate\"}],\"diagnostics\":{\"durationMs\":1,\"stdoutTruncated\":false,\"stderrTruncated\":false,\"rawOutput\":null}}";
        }
        else
        {
            payload = "{\"schemaVersion\":1,\"task\":\"" + task + "\",\"reviewer\":\"" + reviewer +
              "\",\"status\":\"success\",\"capability\":{\"version\":\"" + version +
              "\",\"runtime\":null,\"source\":\"fixture\",\"reason\":null},\"summary\":\"Fake reviewer completed.\",\"findings\":[],\"diagnostics\":{\"durationMs\":1,\"stdoutTruncated\":false,\"stderrTruncated\":false,\"rawOutput\":null}}";
        }

        if (reviewer == "codex")
        {
            if (isWsl && !string.IsNullOrEmpty(outputPath)) outputPath = LinuxToWindows(outputPath);
            if (mode != "missing-output" && !string.IsNullOrEmpty(outputPath))
                File.WriteAllText(outputPath, payload, new UTF8Encoding(false));
        }
        else
        {
            var escaped = payload.Replace("\\", "\\\\").Replace("\"", "\\\"");
            Console.WriteLine("{\"is_error\":false,\"result\":\"" + escaped + "\"}");
        }
        return 0;
    }
}
