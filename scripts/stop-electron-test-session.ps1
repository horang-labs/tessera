[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$')]
  [string]$SessionId,

  [string]$TestRoot = (Join-Path $env:LOCALAPPDATA 'TesseraTestInstances'),

  [switch]$RemoveData
)

$ErrorActionPreference = 'Stop'

function Get-RecordedProcess {
  param($ProcessId)

  if (-not $ProcessId) {
    return $null
  }
  return Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$ProcessId)" -ErrorAction SilentlyContinue
}

function Get-CdpOwnerProcessId {
  param([Parameter(Mandatory = $true)][int]$Port)

  $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -in @('127.0.0.1', '::1') } |
    Select-Object -First 1
  if (-not $listener) {
    return $null
  }
  return [int]$listener.OwningProcess
}

function Test-PathWithinRoot {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Root
  )

  $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  return $fullPath.StartsWith("$fullRoot\", [StringComparison]::OrdinalIgnoreCase)
}

function Wait-RecordedProcessesExit {
  param(
    [AllowNull()]
    [AllowEmptyCollection()]
    [AllowNull()]
    [Parameter(Mandatory = $true)][array]$ProcessIds,
    [int]$TimeoutSeconds = 15
  )

  $ids = @($ProcessIds | Where-Object { $_ } | ForEach-Object { [int]$_ } | Select-Object -Unique)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $alive = @($ids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if ($alive.Count -eq 0) {
      return
    }
    Start-Sleep -Milliseconds 200
  }
  throw "Recorded test processes did not exit in time: $($alive -join ', ')"
}

function Remove-TestRootWithRetry {
  param([Parameter(Mandatory = $true)][string]$Path)

  for ($attempt = 1; $attempt -le 20; $attempt += 1) {
    if (-not (Test-Path -LiteralPath $Path)) {
      return
    }
    try {
      Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
    } catch {
      if ($attempt -eq 20) {
        throw
      }
      Start-Sleep -Milliseconds 250
    }
  }
}

function Stop-RecordedProcessTree {
  param([Parameter(Mandatory = $true)][int]$ProcessId)

  $savedErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'SilentlyContinue'
    & taskkill.exe /PID $ProcessId /T /F 2>&1 | Out-Null
  } finally {
    $ErrorActionPreference = $savedErrorActionPreference
  }
}

function Remove-OwnedWslFixture {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$OwnerToken,
    [Parameter(Mandatory = $true)][string]$Distro
  )

  if ($Root -notmatch '^/home/[A-Za-z0-9._-]+/\.tessera/(?:test-fixtures|test-instances)/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
    throw "Refusing to remove non-owned WSL fixture root: $Root"
  }
  if ($OwnerToken -notmatch '^[A-Fa-f0-9]{32}$') {
    throw 'Refusing WSL cleanup without an exact GUID-N ownership token.'
  }
  # Keep the native-process argument on one line. PowerShell does not reliably
  # preserve a multiline `sh -c` argv value when crossing wsl.exe, and WSL does
  # not reliably consume piped PowerShell text as the `sh -s` program.
  # Root and token are validated to a no-whitespace safe alphabet before this
  # crosses the PowerShell 5.1 native-argv binder.
  $script = 'set -eu; root=$1; token=$2; marker=$root/.tessera-owner; [ ${#token} -eq 32 ]; case $token in *[!A-Fa-f0-9]*) exit 46;; esac; [ -f $marker ]; [ $(wc -c < $marker) -eq 33 ]; [ $(wc -l < $marker) -eq 1 ]; IFS= read -r recorded < $marker; [ ${#recorded} -eq 32 ]; case $recorded in *[!A-Fa-f0-9]*) exit 47;; esac; case $recorded in $token) ;; *) exit 48;; esac; case $root in /home/*/.tessera/test-fixtures/*|/home/*/.tessera/test-instances/*) ;; *) exit 43 ;; esac; rm -rf -- $root'
  & wsl.exe --distribution $Distro --exec sh -c $script tessera-fixture $Root $OwnerToken
  if ($LASTEXITCODE -ne 0) {
    throw "Refusing to remove non-owned WSL fixture root: $Root"
  }
}

$manifestPath = Join-Path (Join-Path $TestRoot 'sessions') "$SessionId.json"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "No launcher-owned Electron test session manifest exists: $SessionId ($manifestPath)"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -notin @(2, 3) -or $manifest.sessionId -ne $SessionId) {
  throw "Session manifest identity mismatch: $manifestPath"
}

$stopped = @()
$recordedProcessIds = @()
foreach ($instance in @($manifest.instances)) {
  $launcher = Get-RecordedProcess -ProcessId $instance.launcherProcessId
  $electron = Get-RecordedProcess -ProcessId $instance.electronProcessId
  $cdpOwner = Get-CdpOwnerProcessId -Port ([int]$instance.cdpPort)

  $launcherOwned = $false
  if ($launcher) {
    $launcherOwned =
      $launcher.ExecutablePath -eq $manifest.executable -and
      $launcher.CommandLine -like "*--remote-debugging-port=$($instance.cdpPort)*" -and
      $launcher.CommandLine -like "*--tessera-test-owner=$($instance.ownerToken)*"
  }

  $electronOwned = $false
  if ($electron) {
    $electronOwned =
      $cdpOwner -eq [int]$instance.electronProcessId -and
      $electron.CommandLine -like "*--remote-debugging-port=$($instance.cdpPort)*" -and
      $electron.CommandLine -like "*--tessera-test-owner=$($instance.ownerToken)*"
  }

  if ($launcher -and -not $launcherOwned) {
    throw "Refusing to stop reused or non-owned launcher PID $($instance.launcherProcessId)"
  }
  if ($electron -and -not $electronOwned) {
    throw "Refusing to stop reused or non-owned Electron PID $($instance.electronProcessId)"
  }

  if ($launcherOwned) {
    Stop-RecordedProcessTree -ProcessId ([int]$instance.launcherProcessId)
    $stopped += [int]$instance.launcherProcessId
  } elseif ($electronOwned) {
    Stop-RecordedProcessTree -ProcessId ([int]$instance.electronProcessId)
    $stopped += [int]$instance.electronProcessId
  }

  $recordedProcessIds += @($instance.launcherProcessId, $instance.electronProcessId)
}

Wait-RecordedProcessesExit -ProcessIds $recordedProcessIds

foreach ($instance in @($manifest.instances)) {
  if ($RemoveData) {
    if (-not (Test-PathWithinRoot -Path $instance.instanceRoot -Root $TestRoot)) {
      throw "Refusing to remove data outside the test root: $($instance.instanceRoot)"
    }
    if ($instance.wslStateRoot) {
      if (-not $instance.wslStateOwnerToken -or -not $instance.wslDistro) {
        throw "Refusing to remove non-owned WSL test state root: $($instance.wslStateRoot)"
      }
      Remove-OwnedWslFixture `
        -Root ([string]$instance.wslStateRoot) `
        -OwnerToken ([string]$instance.wslStateOwnerToken) `
        -Distro ([string]$instance.wslDistro)
    }
    if ($instance.wslFixtureRoot) {
      if (-not $instance.wslFixtureOwnerToken -or -not $instance.wslDistro) {
        throw "Refusing to remove non-owned WSL fixture root: $($instance.wslFixtureRoot)"
      }
      Remove-OwnedWslFixture `
        -Root ([string]$instance.wslFixtureRoot) `
        -OwnerToken ([string]$instance.wslFixtureOwnerToken) `
        -Distro ([string]$instance.wslDistro)
    }
    if (Test-Path -LiteralPath $instance.instanceRoot) {
      Remove-TestRootWithRetry -Path $instance.instanceRoot
    }
  }
}

if ($RemoveData) {
  Remove-Item -LiteralPath $manifestPath -Force
}
[pscustomobject]@{
  sessionId = $SessionId
  stoppedProcessIds = $stopped
  removedData = [bool]$RemoveData
  manifestRemoved = -not (Test-Path -LiteralPath $manifestPath)
} | ConvertTo-Json -Depth 4
