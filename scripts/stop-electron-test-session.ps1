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

$manifestPath = Join-Path (Join-Path $TestRoot 'sessions') "$SessionId.json"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "No launcher-owned Electron test session manifest exists: $SessionId ($manifestPath)"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 2 -or $manifest.sessionId -ne $SessionId) {
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
    if (Test-Path -LiteralPath $instance.instanceRoot) {
      Remove-TestRootWithRetry -Path $instance.instanceRoot
    }
  }
}

Remove-Item -LiteralPath $manifestPath -Force
[pscustomobject]@{
  sessionId = $SessionId
  stoppedProcessIds = $stopped
  removedData = [bool]$RemoveData
  manifestRemoved = -not (Test-Path -LiteralPath $manifestPath)
} | ConvertTo-Json -Depth 4
