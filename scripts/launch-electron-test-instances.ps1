[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
  [string]$Executable,

  [ValidateRange(1, 5)]
  [int]$Count = 1,

  [ValidateRange(1, 99)]
  [int]$StartIndex = 1,

  [Alias('InstancePrefix')]
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$')]
  [string]$SessionId = 'dev',

  [string]$TestRoot = (Join-Path $env:LOCALAPPDATA 'TesseraTestInstances'),

  [string]$SeedDataDir,

  [switch]$RefreshSeed,

  [ValidateRange(1024, 65530)]
  [int]$CdpBasePort = 9337,

  [ValidateRange(1024, 65530)]
  [int]$ServerBasePort = 32124,

  [string]$WslDistro = 'Ubuntu-24.04',

  [switch]$PrepareOnly
)

$ErrorActionPreference = 'Stop'

function Copy-DatabaseSnapshot {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  for ($attempt = 1; $attempt -le 3; $attempt += 1) {
    $before = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
    $after = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash
    $copied = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash
    if ($before -eq $after -and $before -eq $copied) {
      return $copied.ToLowerInvariant()
    }
  }

  throw "The source database changed during all snapshot attempts: $Source"
}

function Initialize-TestData {
  param(
    [Parameter(Mandatory = $true)][string]$DataDir,
    [string]$SourceDataDir,
    [switch]$ForceRefresh
  )

  New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
  $targetDatabase = Join-Path $DataDir 'tessera.db'
  $databaseHash = $null

  if ($SourceDataDir) {
    $sourceDatabase = @(
      (Join-Path $SourceDataDir 'tessera-dev.db'),
      (Join-Path $SourceDataDir 'tessera.db')
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1

    if (-not $sourceDatabase) {
      throw "Seed data has neither tessera-dev.db nor tessera.db: $SourceDataDir"
    }

    if ($ForceRefresh -or -not (Test-Path -LiteralPath $targetDatabase -PathType Leaf)) {
      $databaseHash = Copy-DatabaseSnapshot -Source $sourceDatabase -Destination $targetDatabase
    } else {
      $databaseHash = (Get-FileHash -LiteralPath $targetDatabase -Algorithm SHA256).Hash.ToLowerInvariant()
    }

    $sourceSettings = Join-Path $SourceDataDir 'settings'
    $targetSettings = Join-Path $DataDir 'settings'
    if (Test-Path -LiteralPath $sourceSettings -PathType Container) {
      if ($ForceRefresh -and (Test-Path -LiteralPath $targetSettings)) {
        Remove-Item -LiteralPath $targetSettings -Recurse -Force
      }
      if (-not (Test-Path -LiteralPath $targetSettings -PathType Container)) {
        Copy-Item -LiteralPath $sourceSettings -Destination $targetSettings -Recurse -Force
      }
    }
  }

  return $databaseHash
}

function Test-TcpPortBindable {
  param([Parameter(Mandatory = $true)][int]$Port)

  $listener = [System.Net.Sockets.TcpListener]::new(
    [System.Net.IPAddress]::Loopback,
    $Port
  )
  try {
    # A connect probe cannot distinguish a free port from a Windows-excluded
    # port. Binding catches both a live listener and WSAEACCES exclusions.
    $listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    $listener.Stop()
  }
}

function Test-TcpPortClaimed {
  param([Parameter(Mandatory = $true)][int]$Port)

  if (-not (Test-TcpPortBindable -Port $Port)) {
    return $true
  }

  # Chromium can retain a live process with an assigned debugging port while
  # its endpoint is temporarily not listening. Reusing that command-line port
  # makes the new instance start without a CDP owner and leaves a failed test
  # process behind, so treat the live claim as occupied too.
  $argument = "--remote-debugging-port=$Port"
  try {
    return $null -ne (Get-CimInstance Win32_Process -ErrorAction Stop |
      Where-Object { $_.CommandLine -like "*$argument*" } |
      Select-Object -First 1)
  } catch {
    throw "Cannot verify whether TCP port $Port is claimed by a live Chromium process"
  }
}

function Find-AvailableTcpPort {
  param(
    [Parameter(Mandatory = $true)][int]$StartPort,
    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [System.Collections.Generic.HashSet[int]]$ReservedPorts
  )

  for ($candidate = $StartPort; $candidate -le 65535; $candidate += 1) {
    if (-not $ReservedPorts.Contains($candidate) -and -not (Test-TcpPortClaimed -Port $candidate)) {
      $ReservedPorts.Add($candidate) | Out-Null
      return $candidate
    }
  }
  throw "No free TCP port is available at or above $StartPort"
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

function Wait-CdpEndpoint {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [int]$TimeoutSeconds = 90
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $versionEndpoint = "http://127.0.0.1:$Port/json/version"
  $pagesEndpoint = "http://127.0.0.1:$Port/json/list"
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $version = Invoke-RestMethod -Uri $versionEndpoint -TimeoutSec 2
      if ($version.webSocketDebuggerUrl) {
        $pages = @(Invoke-RestMethod -Uri $pagesEndpoint -TimeoutSec 2)
        $page = $pages | Where-Object { $_.url -like 'http*' } | Select-Object -First 1
        if ($page -and $page.url) {
          $serverUrl = [string]$page.url
          return [pscustomobject]@{
            webSocketDebuggerUrl = [string]$version.webSocketDebuggerUrl
            serverUrl = $serverUrl
            serverPort = ([Uri]$serverUrl).Port
          }
        }
      }
    } catch {}
    Start-Sleep -Milliseconds 250
  }
  throw "Electron CDP endpoint did not become ready within ${TimeoutSeconds}s: $versionEndpoint"
}

function Test-RecordedProcessAlive {
  param($ProcessId)

  if (-not $ProcessId) {
    return $false
  }
  return $null -ne (Get-Process -Id ([int]$ProcessId) -ErrorAction SilentlyContinue)
}

function Write-SessionManifest {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Id,
    [Parameter(Mandatory = $true)][string]$ExecutablePath,
    [Parameter(Mandatory = $true)][array]$Instances
  )

  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $manifest = [ordered]@{
    schemaVersion = 3
    sessionId = $Id
    executable = $ExecutablePath
    updatedAt = [DateTime]::UtcNow.ToString('o')
    instances = @($Instances)
  }
  $temporaryPath = "$Path.tmp-$PID"
  $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
  Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
}

function Initialize-WslFixtureOwnership {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$OwnerToken,
    [Parameter(Mandatory = $true)][string]$Distro
  )

  if ($Root -notmatch '^/home/[A-Za-z0-9._-]+/\.tessera/test-fixtures/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
    throw "WSL fixture root must be an isolated path below /home/<user>/.tessera/test-fixtures: $Root"
  }
  if ($OwnerToken -notmatch '^[A-Fa-f0-9]{32}$') {
    throw 'WSL fixture ownership requires an exact GUID-N token.'
  }
  # Every argument is constrained to a no-whitespace safe alphabet above. Keep
  # this script quote/escape-free: Windows PowerShell 5.1 removes embedded
  # quotes while binding native argv across wsl.exe.
  $script = 'set -eu; root=$1; token=$2; marker=$root/.tessera-owner; [ ${#token} -eq 32 ]; case $token in *[!A-Fa-f0-9]*) exit 46;; esac; [ -d $root ]; if [ -e $marker ]; then [ -f $marker ]; [ $(wc -c < $marker) -eq 33 ]; [ $(wc -l < $marker) -eq 1 ]; IFS= read -r recorded < $marker; [ ${#recorded} -eq 32 ]; case $recorded in *[!A-Fa-f0-9]*) exit 47;; esac; case $recorded in $token) ;; *) exit 48;; esac; else (set -C; umask 077; echo $token > $marker); fi'
  & wsl.exe --distribution $Distro --exec sh -c $script tessera-fixture $Root $OwnerToken
  if ($LASTEXITCODE -ne 0) {
    throw "Cannot establish ownership of WSL fixture root: $Root"
  }
}

function Get-WslTestStateRoot {
  param(
    [Parameter(Mandatory = $true)][string]$InstanceId,
    [Parameter(Mandatory = $true)][string]$Distro
  )

  $homeScript = 'set -eu; case $HOME in /home/*) ;; *) exit 45 ;; esac; echo $HOME'
  $wslHome = (& wsl.exe --distribution $Distro --exec sh -c $homeScript).Trim()
  if ($LASTEXITCODE -ne 0 -or $wslHome -notmatch '^/home/[A-Za-z0-9._-]+$') {
    throw "Cannot resolve the isolated WSL test state root for distro: $Distro"
  }
  return "$wslHome/.tessera/test-instances/$InstanceId"
}

function Initialize-WslTestStateOwnership {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$OwnerToken,
    [Parameter(Mandatory = $true)][string]$Distro
  )

  if ($Root -notmatch '^/home/[A-Za-z0-9._-]+/\.tessera/test-instances/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
    throw "WSL test state root must be an isolated test-instance path: $Root"
  }
  if ($OwnerToken -notmatch '^[A-Fa-f0-9]{32}$') {
    throw 'WSL test state ownership requires an exact GUID-N token.'
  }
  $script = 'set -eu; root=$1; token=$2; marker=$root/.tessera-owner; [ ${#token} -eq 32 ]; case $token in *[!A-Fa-f0-9]*) exit 46;; esac; parent=${root%/*}; mkdir -p $parent; if [ -e $root ]; then [ -d $root ]; [ -f $marker ]; [ $(wc -c < $marker) -eq 33 ]; [ $(wc -l < $marker) -eq 1 ]; IFS= read -r recorded < $marker; [ ${#recorded} -eq 32 ]; case $recorded in *[!A-Fa-f0-9]*) exit 47;; esac; case $recorded in $token) ;; *) exit 48;; esac; else mkdir $root; (set -C; umask 077; echo $token > $marker); fi'
  & wsl.exe --distribution $Distro --exec sh -c $script tessera-state $Root $OwnerToken
  if ($LASTEXITCODE -ne 0) {
    throw "Cannot establish ownership of WSL test state root: $Root"
  }
}

$providerAuthorityEnvironmentNames = @(
  'CODEX_HOME',
  'TESSERA_CODEX_HOME',
  'TESSERA_CLI_COMMAND',
  'TESSERA_PROJECT_ID',
  'TESSERA_WORKTREE_ID',
  'TESSERA_SESSION_ID',
  'TESSERA_PANE_TOKEN',
  'TESSERA_HOOK_PORT',
  'CLAUDE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME'
)
$launchScrubEnvironmentNames = @(
  'ELECTRON_RUN_AS_NODE',
  'TESSERA_DEV_PORT',
  'TESSERA_APP_ROOT',
  'TESSERA_PRODUCTION_DB',
  'TESSERA_ELECTRON_SERVER',
  'ELECTRON_CHILD'
) + $providerAuthorityEnvironmentNames + @(
  'NODE_ENV'
)
$wslPropagationBlockedNames = @() + $providerAuthorityEnvironmentNames + @(
  'ZDOTDIR'
  'TESSERA_ELECTRON_TEST_WSL_FIXTURE_ROOT'
)

function Get-IsolatedWslEnvironment {
  param(
    [AllowNull()][string]$Existing,
    [AllowNull()][string]$FixtureRoot
  )

  $entries = @($Existing -split ':' | Where-Object {
    $_ -and (($_ -split '/', 2)[0] -notin $wslPropagationBlockedNames)
  })
  if ($FixtureRoot) {
    $entries += @('ZDOTDIR', 'TESSERA_ELECTRON_TEST_WSL_FIXTURE_ROOT')
  }
  return ($entries | Select-Object -Unique) -join ':'
}

function Get-TestInstanceId {
  param(
    [Parameter(Mandatory = $true)][string]$Id,
    [Parameter(Mandatory = $true)][int]$InstanceCount,
    [Parameter(Mandatory = $true)][int]$FirstIndex,
    [Parameter(Mandatory = $true)][int]$Offset
  )

  if ($InstanceCount -eq 1 -and $FirstIndex -eq 1) {
    return $Id
  }
  return "$Id-$($FirstIndex + $Offset)"
}

$sessionDirectory = Join-Path $TestRoot 'sessions'
$sessionManifestPath = Join-Path $sessionDirectory "$SessionId.json"
$restartManifest = $null
if (-not $PrepareOnly -and (Test-Path -LiteralPath $sessionManifestPath -PathType Leaf)) {
  $existingManifest = Get-Content -LiteralPath $sessionManifestPath -Raw | ConvertFrom-Json
  $activeInstances = @($existingManifest.instances | Where-Object {
    (Test-RecordedProcessAlive -ProcessId $_.launcherProcessId) -or
    (Test-RecordedProcessAlive -ProcessId $_.electronProcessId)
  })
  if ($activeInstances.Count -gt 0) {
    throw "Electron test session is already active: $SessionId ($sessionManifestPath)"
  }
  if (
    $existingManifest.schemaVersion -eq 3 -and
    $existingManifest.sessionId -eq $SessionId -and
    $existingManifest.executable -eq $Executable
  ) {
    # A stop without -RemoveData deliberately retains the manifest and ownership
    # token so the same isolated app/data namespace can be restarted safely.
    $restartManifest = $existingManifest
    $requestedInstanceIds = @(for ($offset = 0; $offset -lt $Count; $offset += 1) {
      Get-TestInstanceId -Id $SessionId -InstanceCount $Count -FirstIndex $StartIndex -Offset $offset
    })
    $retainedInstanceIds = @($existingManifest.instances | ForEach-Object { [string]$_.instanceId })
    if (
      $requestedInstanceIds.Count -ne $retainedInstanceIds.Count -or
      @($requestedInstanceIds | Where-Object { $_ -notin $retainedInstanceIds }).Count -gt 0
    ) {
      throw "Restart must reuse the exact retained Electron test instance set: $sessionManifestPath"
    }
  } else {
    throw "A stale Electron test manifest cannot be safely reused: $sessionManifestPath"
  }
}

$wslFixtureRoot = [Environment]::GetEnvironmentVariable(
  'TESSERA_ELECTRON_TEST_WSL_FIXTURE_ROOT',
  'Process'
)
if ($wslFixtureRoot -and $Count -ne 1) {
  throw 'An isolated WSL provider fixture may be attached only to one Electron test instance'
}

$environmentNames = @(
  'TESSERA_ELECTRON_TEST_INSTANCE',
  'TESSERA_ELECTRON_TEST_ROOT',
  'TESSERA_ELECTRON_TEST_SERVER_PORT',
  'TESSERA_ELECTRON_TEST_WSL_FIXTURE_ROOT',
  'WSL_DISTRO_NAME',
  'WSLENV',
  'ZDOTDIR'
) + $launchScrubEnvironmentNames
$savedEnvironment = @{}
foreach ($name in $environmentNames) {
  $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

$results = @()
$reservedPorts = [System.Collections.Generic.HashSet[int]]::new()
$portAllocationMutex = [System.Threading.Mutex]::new(
  $false,
  'Local\TesseraElectronTestPortAllocation'
)
$portAllocationMutexHeld = $false
try {
  if (-not $PrepareOnly) {
    try {
      $portAllocationMutexHeld = $portAllocationMutex.WaitOne(600000)
    } catch [System.Threading.AbandonedMutexException] {
      # The abandoned mutex is acquired by this thread when the exception is raised.
      $portAllocationMutexHeld = $true
    }
    if (-not $portAllocationMutexHeld) {
      throw 'Timed out waiting for concurrent Electron test port allocation'
    }
  }

  for ($offset = 0; $offset -lt $Count; $offset += 1) {
    $instanceId = Get-TestInstanceId `
      -Id $SessionId `
      -InstanceCount $Count `
      -FirstIndex $StartIndex `
      -Offset $offset
    $instanceRoot = Join-Path $TestRoot $instanceId
    $dataDir = Join-Path $instanceRoot 'data'
    $userDataDir = Join-Path $instanceRoot 'user-data'
    if ($PrepareOnly) {
      $cdpPort = $CdpBasePort + $offset
      $testServerPort = $ServerBasePort + $offset
    } else {
      $cdpPort = Find-AvailableTcpPort -StartPort ($CdpBasePort + $offset) -ReservedPorts $reservedPorts
      $testServerPort = Find-AvailableTcpPort -StartPort ($ServerBasePort + $offset) -ReservedPorts $reservedPorts
    }

    if ($instanceId.Length -gt 64) {
      throw "Generated test instance id is too long: $instanceId"
    }
    New-Item -ItemType Directory -Path $userDataDir -Force | Out-Null
    $databaseHash = Initialize-TestData `
      -DataDir $dataDir `
      -SourceDataDir $SeedDataDir `
      -ForceRefresh:$RefreshSeed

    $env:TESSERA_ELECTRON_TEST_INSTANCE = $instanceId
    $env:TESSERA_ELECTRON_TEST_ROOT = $TestRoot
    $env:TESSERA_ELECTRON_TEST_SERVER_PORT = [string]$testServerPort
    $env:WSL_DISTRO_NAME = $WslDistro
    foreach ($name in $launchScrubEnvironmentNames) {
      Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
    }
    $env:WSLENV = Get-IsolatedWslEnvironment `
      -Existing $savedEnvironment['WSLENV'] `
      -FixtureRoot $wslFixtureRoot
    if ($wslFixtureRoot) {
      $env:TESSERA_ELECTRON_TEST_WSL_FIXTURE_ROOT = $wslFixtureRoot
      $env:ZDOTDIR = "$wslFixtureRoot/shell"
    }

    $restartInstance = @($restartManifest.instances | Where-Object {
      $_.instanceId -eq $instanceId
    }) | Select-Object -First 1
    if ($restartInstance) {
      if (
        $restartInstance.instanceRoot -ne $instanceRoot -or
        $restartInstance.dataDir -ne $dataDir -or
        $restartInstance.userDataDir -ne $userDataDir -or
        $restartInstance.wslDistro -ne $WslDistro
      ) {
        throw "Restart manifest paths do not match the requested isolated instance: $instanceId"
      }
      $ownerToken = [string]$restartInstance.ownerToken
    } else {
      $ownerToken = [Guid]::NewGuid().ToString('N')
    }

    $result = [pscustomobject]@{
      sessionId = $SessionId
      instanceId = $instanceId
      ownerToken = $ownerToken
      instanceRoot = $instanceRoot
      dataDir = $dataDir
      userDataDir = $userDataDir
      databaseSha256 = $databaseHash
      cdpUrl = "http://127.0.0.1:$cdpPort"
      cdpPort = $cdpPort
      serverUrl = $null
      serverPort = $testServerPort
      launcherProcessId = $null
      electronProcessId = $null
      wslDistro = $WslDistro
      wslStateRoot = Get-WslTestStateRoot -InstanceId $instanceId -Distro $WslDistro
      wslStateOwnerToken = $null
      wslFixtureRoot = $wslFixtureRoot
      wslFixtureOwnerToken = $null
      ready = $false
    }
    if ($restartInstance) {
      if (
        $restartInstance.wslStateRoot -ne $result.wslStateRoot -or
        $restartInstance.wslStateOwnerToken -ne $ownerToken -or
        $restartInstance.wslFixtureRoot -ne $wslFixtureRoot -or
        ($wslFixtureRoot -and $restartInstance.wslFixtureOwnerToken -ne $ownerToken)
      ) {
        throw "Restart manifest ownership does not match the requested isolated instance: $instanceId"
      }
    }
    $results += $result

    if (-not $PrepareOnly) {
      Initialize-WslTestStateOwnership `
        -Root $result.wslStateRoot `
        -OwnerToken $result.ownerToken `
        -Distro $WslDistro
      $result.wslStateOwnerToken = $result.ownerToken
      if ($wslFixtureRoot) {
        Initialize-WslFixtureOwnership `
          -Root $wslFixtureRoot `
          -OwnerToken $result.ownerToken `
          -Distro $WslDistro
        $result.wslFixtureOwnerToken = $result.ownerToken
      }
      Write-SessionManifest `
        -Path $sessionManifestPath `
        -Id $SessionId `
        -ExecutablePath $Executable `
        -Instances $results
      $process = Start-Process `
        -FilePath $Executable `
        -ArgumentList @(
          "--remote-debugging-port=$cdpPort",
          "--tessera-test-owner=$($result.ownerToken)"
        ) `
        -PassThru
      $result.launcherProcessId = $process.Id
      Write-SessionManifest `
        -Path $sessionManifestPath `
        -Id $SessionId `
        -ExecutablePath $Executable `
        -Instances $results

      $cdp = Wait-CdpEndpoint -Port $cdpPort
      if ($cdp.serverPort -ne $testServerPort) {
        throw "Electron test server used unexpected port $($cdp.serverPort); expected $testServerPort"
      }
      $result.electronProcessId = Get-CdpOwnerProcessId -Port $cdpPort
      $result.serverUrl = $cdp.serverUrl
      $result.ready = $true
      Write-SessionManifest `
        -Path $sessionManifestPath `
        -Id $SessionId `
        -ExecutablePath $Executable `
        -Instances $results
    }
  }
} finally {
  if ($portAllocationMutexHeld) {
    $portAllocationMutex.ReleaseMutex()
  }
  $portAllocationMutex.Dispose()
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
  }
}

$results | ConvertTo-Json -Depth 5
