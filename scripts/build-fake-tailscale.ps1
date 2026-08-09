[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('\.exe$')]
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $resolvedOutput
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
if (Test-Path -LiteralPath $resolvedOutput) {
  throw "Refusing to overwrite an existing fake Tailscale executable: $resolvedOutput"
}

$source = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;

public static class FakeTailscale {
  private const string DnsName = "localhost";
  private const string HarnessMarker = "tessera.issue-308.fake-tailscale.v1";

  private static string Root {
    get { return AppDomain.CurrentDomain.BaseDirectory; }
  }

  private static string StatePath {
    get { return Path.Combine(Root, "fake-tailscale-owned-endpoint.txt"); }
  }

  private static string LogPath {
    get { return Path.Combine(Root, "fake-tailscale-invocations.tsv"); }
  }

  private static string JsonEscape(string value) {
    return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
  }

  private static void Log(string[] args) {
    string separator = "\u001f";
    string line = String.Join("\t", new string[] {
      DateTime.UtcNow.ToString("o"),
      Process.GetCurrentProcess().Id.ToString(),
      Environment.OSVersion.ToString().Replace("\t", " "),
      Assembly.GetExecutingAssembly().Location.Replace("\t", " "),
      String.Join(separator, args).Replace("\t", " ")
    });
    File.AppendAllText(LogPath, line + Environment.NewLine, new UTF8Encoding(false));
  }

  private static string ServeStatus() {
    string port = null;
    string target = null;
    if (File.Exists(StatePath)) {
      string[] state = File.ReadAllLines(StatePath);
      if (state.Length != 2) throw new InvalidDataException("Invalid fake owned endpoint state");
      port = state[0];
      target = JsonEscape(state[1]);
    }

    string tcp = "\"TCP\":{\"443\":{\"HTTPS\":true},\"8080\":{\"HTTP\":true}"
      + (port == null ? "" : ",\"" + port + "\":{\"HTTPS\":true}") + "},";
    string web = "\"Web\":{"
      + "\"" + DnsName + ":443\":{\"Handlers\":{\"/\":{\"Text\":\"keep-background\"}}},"
      + "\"" + DnsName + ":8080\":{\"Handlers\":{\"/\":{\"Proxy\":\"http://127.0.0.1:8080\"}}}"
      + (port == null ? "" : ",\"" + DnsName + ":" + port
        + "\":{\"Handlers\":{\"/\":{\"Proxy\":\"" + target + "\"}}}") + "},";
    return "{" + tcp + web
      + "\"AllowFunnel\":{\"" + DnsName + ":8080\":true},"
      + "\"Foreground\":{\"debug-session\":{"
      + "\"TCP\":{\"9000\":{\"TCPForward\":\"127.0.0.1:9000\"}}}},"
      + "\"Services\":{\"svc:demo\":{"
      + "\"TCP\":{\"8443\":{\"HTTPS\":true}},"
      + "\"Web\":{\"svc:demo:8443\":{\"Handlers\":{\"/\":{\"Text\":\"keep-service\"}}}},"
      + "\"Tun\":true}}}";
  }

  private static string FindArgument(string[] args, string prefix) {
    foreach (string arg in args) {
      if (arg.StartsWith(prefix, StringComparison.Ordinal)) return arg.Substring(prefix.Length);
    }
    return null;
  }

  public static int Main(string[] args) {
    Log(args);
    if (args.Length == 1 && args[0] == "--tessera-test-marker") {
      Console.WriteLine(HarnessMarker);
      return 0;
    }
    if (args.Length == 2 && args[0] == "status" && args[1] == "--json") {
      Console.WriteLine("{\"BackendState\":\"Running\",\"Self\":{\"DNSName\":\""
        + DnsName + ".\"},\"CertDomains\":[\"" + DnsName + "\"]}");
      return 0;
    }
    if (args.Length == 3 && args[0] == "serve" && args[1] == "status" && args[2] == "--json") {
      Console.WriteLine(ServeStatus());
      return 0;
    }
    if (args.Length >= 6 && args[0] == "serve") {
      string port = FindArgument(args, "--https=");
      string mountPath = FindArgument(args, "--set-path=");
      string value = args[args.Length - 1];
      if (port == null || mountPath != "/") return 2;
      if (value == "off") {
        if (File.Exists(StatePath)) File.Delete(StatePath);
      } else {
        File.WriteAllText(StatePath, port + Environment.NewLine + value, new UTF8Encoding(false));
      }
      return 0;
    }
    Console.Error.WriteLine("Unsupported fake Tailscale command: " + String.Join(" ", args));
    return 2;
  }
}
'@

Add-Type `
  -TypeDefinition $source `
  -Language CSharp `
  -OutputAssembly $resolvedOutput `
  -OutputType ConsoleApplication

[pscustomobject]@{
  executable = $resolvedOutput
  sha256 = (Get-FileHash -LiteralPath $resolvedOutput -Algorithm SHA256).Hash.ToLowerInvariant()
} | ConvertTo-Json -Compress
