[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Launcher,

  [Parameter(Mandatory = $true)]
  [string]$Stopper,

  [ValidateSet('Success', 'Failure', 'MismatchedOwner')]
  [string]$Mode = 'Success'
)

$ErrorActionPreference = 'Stop'

$hostileEnvironment = [ordered]@{
  CODEX_HOME = '/home/work/.tessera/codex-overlay/session-hostile'
  CODEX_THREAD_ID = 'caller-codex-thread'
  CODEX_CI = '1'
  CODEX_FUTURE_SESSION_SECRET = 'future-codex-secret'
  TESSERA_CODEX_HOME = '/home/work/.tessera/codex-overlay/session-hostile'
  CLAUDE_CONFIG_DIR = '/home/work/.claude/session-hostile'
  CLAUDECODE = '1'
  CLAUDE_CODE_ENTRYPOINT = 'caller-claude-entrypoint'
  OPENCODE_CONFIG_DIR = '/home/work/.tessera/opencode-overlay/session-hostile'
  OPENCODE_FUTURE_SESSION_SECRET = 'future-opencode-secret'
  XDG_DATA_HOME = '/home/work/.local/share/session-hostile'
  TESSERA_ENV = '1'
  TESSERA_CLI_COMMAND = '/home/work/.tessera/runtime/control'
  TESSERA_PROJECT_ID = 'caller-project'
  TESSERA_WORKTREE_ID = 'caller-worktree'
  TESSERA_PANE_TOKEN = 'caller-pane-token'
  TESSERA_SESSION_ID = 'caller-session'
  TESSERA_HOOK_PORT = '32123'
  TESSERA_CONTROL_DESCRIPTOR = '/home/work/.tessera/runtime/control.json'
  TESSERA_CONTROL_DESCRIPTOR_PATH = '/home/work/.tessera/runtime/control.json'
  TESSERA_CLI_CWD = '/home/work/Source/tessera-dev'
  TESSERA_CLI_WSL_DISTRO = 'Caller-Distro'
  TESSERA_AGENT_ENVIRONMENT = 'wsl'
  TESSERA_OPENCODE_RESUME_ID = 'caller-opencode-session'
  TESSERA_FUTURE_SESSION_SECRET = 'future-tessera-secret'
  WSLENV = 'CODEX_HOME/p:TESSERA_CODEX_HOME/p:TESSERA_PANE_TOKEN'
  ELECTRON_RUN_AS_NODE = '1'
  ELECTRON_CHILD = '1'
  NODE_ENV = 'production'
}

$explicitEnvironment = @(
  'TESSERA_ELECTRON_TEST_INSTANCE',
  'TESSERA_ELECTRON_TEST_ROOT',
  'TESSERA_ELECTRON_TEST_SERVER_PORT',
  'WSL_DISTRO_NAME'
)
$observedEnvironmentNames = @($hostileEnvironment.Keys) + $explicitEnvironment
$originalEnvironment = [ordered]@{}
foreach ($name in $observedEnvironmentNames) {
  $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

$global:tesseraCapturedLaunches = [System.Collections.Generic.List[object]]::new()
$testRoot = Join-Path ([IO.Path]::GetTempPath()) "tessera-launch-env-$([Guid]::NewGuid().ToString('N'))"
$testRootOwnerToken = [Guid]::NewGuid().ToString('N')
$testRootOwnerMarker = Join-Path $testRoot '.tessera-harness-owner'
$sessionId = "env-contract-t355-$PID-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$manifestPath = Join-Path (Join-Path $testRoot 'sessions') "$sessionId.json"
$global:tesseraShouldFail = $Mode -eq 'Failure'
$global:tesseraSyntheticProcessId = 2147483000

New-Item -ItemType Directory -Path $testRoot | Out-Null
[IO.File]::WriteAllText(
  $testRootOwnerMarker,
  $testRootOwnerToken,
  [Text.Encoding]::ASCII
)

function Remove-OwnedHarnessTestRoot {
  if (-not (Test-Path -LiteralPath $testRoot)) {
    return
  }
  if (
    -not (Test-Path -LiteralPath $testRootOwnerMarker -PathType Leaf) -or
    [IO.File]::ReadAllText($testRootOwnerMarker, [Text.Encoding]::ASCII) -cne $testRootOwnerToken
  ) {
    throw "Refusing to remove a harness test root without its exact owner marker: $testRoot"
  }
  Remove-Item -LiteralPath $testRoot -Recurse -Force
}

function Get-ManifestInstances {
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    return @()
  }
  return @((Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json).instances)
}

function Assert-SafeWslStateIdentity {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Token
  )

  if ($Root -notmatch '^/home/[A-Za-z0-9._-]+/\.tessera/test-instances/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
    throw "Unsafe WSL state root in contract manifest: $Root"
  }
  if ($Token -notmatch '^[A-Fa-f0-9]{32}$') {
    throw 'Unsafe WSL owner token in contract manifest.'
  }
}

function Set-ExactWslOwnerMarker {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$ExpectedToken,
    [Parameter(Mandatory = $true)][string]$ReplacementToken
  )

  Assert-SafeWslStateIdentity -Root $Root -Token $ExpectedToken
  if ($ReplacementToken -notmatch '^[A-Fa-f0-9]{32}$') {
    throw 'Unsafe replacement WSL owner token in contract harness.'
  }
  $script = 'set -eu; root=$1; expected=$2; replacement=$3; marker=$root/.tessera-owner; [ -f $marker ]; [ $(wc -c < $marker) -eq 33 ]; [ $(wc -l < $marker) -eq 1 ]; IFS= read -r recorded < $marker; [ ${#recorded} -eq 32 ]; case $recorded in $expected) ;; *) exit 48;; esac; echo $replacement > $marker'
  & wsl.exe --distribution Ubuntu-24.04 --exec sh -c $script tessera-harness $Root $ExpectedToken $ReplacementToken
  if ($LASTEXITCODE -ne 0) {
    throw "Cannot replace an unexpected WSL owner marker: $Root"
  }
}

function Test-ExactWslOwnerMarker {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$ExpectedToken
  )

  Assert-SafeWslStateIdentity -Root $Root -Token $ExpectedToken
  $script = 'set -eu; root=$1; expected=$2; marker=$root/.tessera-owner; [ -f $marker ]; [ $(wc -c < $marker) -eq 33 ]; [ $(wc -l < $marker) -eq 1 ]; IFS= read -r recorded < $marker; [ ${#recorded} -eq 32 ]; case $recorded in $expected) exit 0;; *) exit 48;; esac'
  & wsl.exe --distribution Ubuntu-24.04 --exec sh -c $script tessera-harness $Root $ExpectedToken
  return $LASTEXITCODE -eq 0
}

function Test-WslStateRootExists {
  param([Parameter(Mandatory = $true)][string]$Root)

  if ($Root -notmatch '^/home/[A-Za-z0-9._-]+/\.tessera/test-instances/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
    throw "Unsafe WSL state root in residue check: $Root"
  }
  $script = 'test -e $1'
  & wsl.exe --distribution Ubuntu-24.04 --exec sh -c $script tessera-harness $Root
  return $LASTEXITCODE -eq 0
}

function Invoke-ManifestCleanup {
  & $Stopper -SessionId $sessionId -TestRoot $testRoot -RemoveData | Out-Null
}

function global:Start-Process {
  param(
    [string]$FilePath,
    [object[]]$ArgumentList,
    [switch]$PassThru
  )

  $environment = [ordered]@{}
  foreach ($name in $observedEnvironmentNames) {
    $environment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }
  $global:tesseraCapturedLaunches.Add([pscustomobject]@{
    filePath = $FilePath
    argumentList = @($ArgumentList)
    environment = $environment
  })
  if ($global:tesseraShouldFail) {
    throw 'Synthetic Start-Process failure'
  }
  return [pscustomobject]@{ Id = $global:tesseraSyntheticProcessId }
}

function global:Get-CimInstance { return $null }

function global:Invoke-RestMethod {
  param([string]$Uri, [int]$TimeoutSec)

  if ($Uri.EndsWith('/json/version')) {
    return [pscustomobject]@{ webSocketDebuggerUrl = 'ws://127.0.0.1/devtools/browser/test' }
  }
  $serverPort = [Environment]::GetEnvironmentVariable(
    'TESSERA_ELECTRON_TEST_SERVER_PORT',
    'Process'
  )
  return @([pscustomobject]@{ url = "http://127.0.0.1:$serverPort/chat" })
}

function global:Get-NetTCPConnection {
  return [pscustomobject]@{
    LocalAddress = '127.0.0.1'
    OwningProcess = $global:tesseraSyntheticProcessId
  }
}

$launchError = $null
$cleanupError = $null
$finalCleanupError = $null
$mismatchedMarkerPreserved = $null
$wslStateRoots = @()
try {
  foreach ($entry in $hostileEnvironment.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
  }
  [Environment]::SetEnvironmentVariable(
    'TESSERA_ELECTRON_TEST_INSTANCE',
    'caller-test-instance',
    'Process'
  )
  [Environment]::SetEnvironmentVariable(
    'TESSERA_ELECTRON_TEST_ROOT',
    'C:\caller-test-root',
    'Process'
  )
  [Environment]::SetEnvironmentVariable(
    'TESSERA_ELECTRON_TEST_SERVER_PORT',
    '39999',
    'Process'
  )
  [Environment]::SetEnvironmentVariable('WSL_DISTRO_NAME', 'Caller-Distro', 'Process')

  try {
    & $Launcher `
      -Executable "$env:SystemRoot\System32\cmd.exe" `
      -Count $(if ($Mode -eq 'Success') { 2 } else { 1 }) `
      -SessionId $sessionId `
      -TestRoot $testRoot `
      -CdpBasePort 48371 `
      -ServerBasePort 49371 `
      -WslDistro 'Ubuntu-24.04' | Out-Null
  } catch {
    $launchError = $_.Exception.Message
  }

  $instances = @(Get-ManifestInstances)
  $wslStateRoots = @($instances | ForEach-Object { [string]$_.wslStateRoot })

  if ($Mode -eq 'MismatchedOwner' -and $instances.Count -eq 1) {
    $instance = $instances[0]
    $mismatchedToken = [Guid]::NewGuid().ToString('N')
    Set-ExactWslOwnerMarker `
      -Root ([string]$instance.wslStateRoot) `
      -ExpectedToken ([string]$instance.wslStateOwnerToken) `
      -ReplacementToken $mismatchedToken
    try {
      Invoke-ManifestCleanup
    } catch {
      $cleanupError = $_.Exception.Message
    }
    $mismatchedMarkerPreserved = Test-ExactWslOwnerMarker `
      -Root ([string]$instance.wslStateRoot) `
      -ExpectedToken $mismatchedToken
    Set-ExactWslOwnerMarker `
      -Root ([string]$instance.wslStateRoot) `
      -ExpectedToken $mismatchedToken `
      -ReplacementToken ([string]$instance.wslStateOwnerToken)
    try {
      Invoke-ManifestCleanup
    } catch {
      $finalCleanupError = $_.Exception.Message
    }
  } elseif (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    try {
      Invoke-ManifestCleanup
    } catch {
      $cleanupError = $_.Exception.Message
    }
  }

  $restoredEnvironment = [ordered]@{}
  foreach ($name in $observedEnvironmentNames) {
    $restoredEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }

  $remainingWslStateRoots = @($wslStateRoots | Where-Object {
    Test-WslStateRootExists -Root $_
  })

  [pscustomobject]@{
    mode = $Mode
    sessionId = $sessionId
    launchError = $launchError
    cleanupError = $cleanupError
    finalCleanupError = $finalCleanupError
    mismatchedMarkerPreserved = $mismatchedMarkerPreserved
    wslStateRoots = $wslStateRoots
    remainingWslStateRoots = $remainingWslStateRoots
    launches = @($global:tesseraCapturedLaunches)
    hostileEnvironment = $hostileEnvironment
    restoredEnvironment = $restoredEnvironment
  } | ConvertTo-Json -Depth 8
} finally {
  foreach ($name in $observedEnvironmentNames) {
    [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], 'Process')
  }
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    Remove-OwnedHarnessTestRoot
  }
  Remove-Variable -Name tesseraCapturedLaunches -Scope Global -ErrorAction SilentlyContinue
  Remove-Variable -Name tesseraShouldFail -Scope Global -ErrorAction SilentlyContinue
  Remove-Variable -Name tesseraSyntheticProcessId -Scope Global -ErrorAction SilentlyContinue
}
