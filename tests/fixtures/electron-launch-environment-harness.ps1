[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Launcher,

  [ValidateSet('Success', 'Failure')]
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
$global:tesseraShouldFail = $Mode -eq 'Failure'

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
  return [pscustomobject]@{ Id = $PID }
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
    OwningProcess = $PID
  }
}

$launchError = $null
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
      -SessionId 'env-contract' `
      -TestRoot $testRoot `
      -CdpBasePort 48371 `
      -ServerBasePort 49371 `
      -WslDistro 'Ubuntu-24.04' | Out-Null
  } catch {
    $launchError = $_.Exception.Message
  }

  $restoredEnvironment = [ordered]@{}
  foreach ($name in $observedEnvironmentNames) {
    $restoredEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }

  [pscustomobject]@{
    mode = $Mode
    launchError = $launchError
    launches = @($global:tesseraCapturedLaunches)
    hostileEnvironment = $hostileEnvironment
    restoredEnvironment = $restoredEnvironment
  } | ConvertTo-Json -Depth 8
} finally {
  foreach ($name in $observedEnvironmentNames) {
    [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], 'Process')
  }
  if (Test-Path -LiteralPath $testRoot) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  }
  Remove-Variable -Name tesseraCapturedLaunches -Scope Global -ErrorAction SilentlyContinue
  Remove-Variable -Name tesseraShouldFail -Scope Global -ErrorAction SilentlyContinue
}
