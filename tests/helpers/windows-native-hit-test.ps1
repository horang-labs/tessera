param(
  [Parameter(Mandatory = $true)]
  [int]$ProcessId,

  [int[]]$ClientX = @(20, 50, 80, 110, 140, 170, 200, 220, 240, 260, 300, 350, 450, 550, 650, 750, 900),

  [int[]]$ClientY = @(20, 30),

  [switch]$Scan,

  [switch]$RestoreNoActivate
)

$nativeMethods = @'
using System;
using System.Runtime.InteropServices;

public static class TesseraNativeHitTest
{
    [StructLayout(LayoutKind.Sequential)]
    public struct Point
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(
        IntPtr window,
        uint message,
        IntPtr wordParameter,
        IntPtr longParameter
    );

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ClientToScreen(IntPtr window, ref Point point);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetClientRect(IntPtr window, out Rect rect);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowRect(IntPtr window, out Rect rect);

    [DllImport("user32.dll")]
    public static extern uint GetDpiForWindow(IntPtr window);

    [DllImport("user32.dll")]
    public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsIconic(IntPtr window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ShowWindowAsync(IntPtr window, int command);

    [DllImport("user32.dll")]
    public static extern IntPtr WindowFromPoint(Point point);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr window, System.Text.StringBuilder className, int maxCount);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}
'@

Add-Type -TypeDefinition $nativeMethods

# Match Electron's per-monitor-v2 coordinate space. Without this, User32
# virtualizes coordinates when the target window sits on a scaled monitor.
$previousDpiContext = [TesseraNativeHitTest]::SetThreadDpiAwarenessContext([IntPtr](-4))

$process = Get-Process -Id $ProcessId -ErrorAction Stop
$window = $process.MainWindowHandle
if ($window -eq [IntPtr]::Zero) {
  throw "Process $ProcessId has no main window"
}

if ($RestoreNoActivate -and [TesseraNativeHitTest]::IsIconic($window)) {
  # SW_SHOWNOACTIVATE: restore the isolated test window without taking focus or
  # moving the user's pointer.
  [void][TesseraNativeHitTest]::ShowWindowAsync($window, 4)
  Start-Sleep -Milliseconds 300
}

$clientRect = New-Object TesseraNativeHitTest+Rect
if (-not [TesseraNativeHitTest]::GetClientRect($window, [ref]$clientRect)) {
  throw "GetClientRect failed for process $ProcessId"
}

$windowRect = New-Object TesseraNativeHitTest+Rect
if (-not [TesseraNativeHitTest]::GetWindowRect($window, [ref]$windowRect)) {
  throw "GetWindowRect failed for process $ProcessId"
}

if ($Scan) {
  $ClientX = 0..($clientRect.Right - $clientRect.Left - 1)
}

$results = foreach ($y in $ClientY) {
  foreach ($x in $ClientX) {
    $point = New-Object TesseraNativeHitTest+Point
    $point.X = $x
    $point.Y = $y
    if (-not [TesseraNativeHitTest]::ClientToScreen($window, [ref]$point)) {
      throw "ClientToScreen failed for ($x, $y)"
    }

    $packedPoint = [int64](
      (($point.Y -band 0xffff) -shl 16) -bor
      ($point.X -band 0xffff)
    )
    $hit = [TesseraNativeHitTest]::SendMessage(
      $window,
      0x0084,
      [IntPtr]::Zero,
      [IntPtr]$packedPoint
    ).ToInt64()

    $windowAtPoint = [TesseraNativeHitTest]::WindowFromPoint($point)
    $windowAtPointProcessId = [uint32]0
    [void][TesseraNativeHitTest]::GetWindowThreadProcessId(
      $windowAtPoint,
      [ref]$windowAtPointProcessId
    )
    $windowClass = New-Object System.Text.StringBuilder 256
    [void][TesseraNativeHitTest]::GetClassName($windowAtPoint, $windowClass, $windowClass.Capacity)
    $hitOnWindowAtPoint = [TesseraNativeHitTest]::SendMessage(
      $windowAtPoint,
      0x0084,
      [IntPtr]::Zero,
      [IntPtr]$packedPoint
    ).ToInt64()

    [pscustomobject]@{
      clientX = $x
      clientY = $y
      screenX = $point.X
      screenY = $point.Y
      hit = $hit
      draggable = $hit -eq 2
      windowAtPoint = $windowAtPoint.ToInt64()
      windowAtPointProcessId = $windowAtPointProcessId
      windowClass = $windowClass.ToString()
      hitOnWindowAtPoint = $hitOnWindowAtPoint
    }
  }
}

$segments = if ($Scan) {
  foreach ($y in $ClientY) {
    $row = @($results | Where-Object { $_.clientY -eq $y })
    if ($row.Count -eq 0) { continue }
    $segmentStart = $row[0].clientX
    $segmentHit = $row[0].hit
    for ($index = 1; $index -le $row.Count; $index++) {
      $atEnd = $index -eq $row.Count
      $nextHit = if ($atEnd) { $null } else { $row[$index].hit }
      if ($atEnd -or $nextHit -ne $segmentHit) {
        [pscustomobject]@{
          clientY = $y
          startX = $segmentStart
          endX = $row[$index - 1].clientX
          hit = $segmentHit
          draggable = $segmentHit -eq 2
        }
        if (-not $atEnd) {
          $segmentStart = $row[$index].clientX
          $segmentHit = $nextHit
        }
      }
    }
  }
}

[pscustomobject]@{
  processId = $ProcessId
  windowHandle = $window.ToInt64()
  foregroundWindow = [TesseraNativeHitTest]::GetForegroundWindow().ToInt64()
  isForeground = [TesseraNativeHitTest]::GetForegroundWindow() -eq $window
  isMinimized = [TesseraNativeHitTest]::IsIconic($window)
  isVisible = [TesseraNativeHitTest]::IsWindowVisible($window)
  clientWidth = $clientRect.Right - $clientRect.Left
  clientHeight = $clientRect.Bottom - $clientRect.Top
  windowRect = [pscustomobject]@{
    left = $windowRect.Left
    top = $windowRect.Top
    right = $windowRect.Right
    bottom = $windowRect.Bottom
  }
  dpi = [TesseraNativeHitTest]::GetDpiForWindow($window)
  points = if ($Scan) { @() } else { @($results) }
  segments = if ($Scan) { @($segments) } else { @() }
} | ConvertTo-Json -Depth 4

if ($previousDpiContext -ne [IntPtr]::Zero) {
  [void][TesseraNativeHitTest]::SetThreadDpiAwarenessContext($previousDpiContext)
}
