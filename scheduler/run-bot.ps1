<#
.SYNOPSIS
  Runs one Agent Army bot unattended (used by the \AgentArmy\ scheduled tasks), then puts the PC
  back to sleep if nobody is using it.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File run-bot.ps1 -Bot tutor -Prompt "Write today's drill"
  powershell -ExecutionPolicy Bypass -File run-bot.ps1 -Bot tutor -Prompt "..." -NoSleep   # manual test, never sleeps

  Steps: keep awake -> wait for network -> start Agent Army (and Dossier if the bot needs it) ->
  send the prompt (prefixed with [scheduled]) -> wait (20 min max) -> write data\runs\<file>.md,
  append data\runs\runs.log, show a toast -> release keep-awake -> sleep if idle. Never shuts down.
#>
param(
  [Parameter(ParameterSetName = 'Direct', Mandatory)][ValidatePattern('^[a-z0-9-]+$')][string]$Bot,
  [Parameter(ParameterSetName = 'Direct', Mandatory)][string]$Prompt,
  # A task id from tasks.json (what the scheduled tasks pass).
  [Parameter(ParameterSetName = 'Task', Mandatory)][ValidatePattern('^[a-z0-9-]+$')][string]$Task,
  [int]$TimeoutMin = 20,
  [switch]$NoSleep,
  # Testing aids: probe another host for "network up" (e.g. one that can't resolve), wait less,
  # and log the sleep decision instead of sleeping.
  [string]$NetworkProbeHost = 'api.anthropic.com',
  [int]$NetworkWaitSec = 120,
  [switch]$DryRunSleep
)
$ErrorActionPreference = 'Stop'
if ($Task) {
  $def = (Get-Content (Join-Path $PSScriptRoot 'tasks.json') -Raw -Encoding UTF8 | ConvertFrom-Json) | Where-Object id -eq $Task
  if (-not $def) { throw "no task '$Task' in tasks.json" }
  $Bot = $def.bot; $Prompt = $def.prompt
}
$Root = Split-Path $PSScriptRoot -Parent                          # agent-army
$Runs = Join-Path $Root 'data\runs'
$Base = 'http://localhost:4777'
$DossierDir = Join-Path (Split-Path $Root -Parent) 'jobfy-qa\dossier'
New-Item -ItemType Directory -Force $Runs | Out-Null
$started = Get-Date

Add-Type -Namespace AgentArmy -Name Native -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);
[StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
[DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
[DllImport("powrprof.dll", SetLastError = true)] public static extern bool SetSuspendState(bool hibernate, bool forceCritical, bool disableWakeEvent);
[DllImport("kernel32.dll")] public static extern uint GetTickCount();
/// Milliseconds since the last keyboard/mouse input. Unsigned math, so it stays right after the
/// 32-bit tick counter wraps (every 49.7 days of uptime; Environment.TickCount goes negative at 24.9).
public static uint IdleMs() { var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i); GetLastInputInfo(ref i); return unchecked(GetTickCount() - i.dwTime); }
'@
$ES_CONTINUOUS = [uint32]'0x80000000'; $ES_SYSTEM_REQUIRED = [uint32]'0x00000001'

# Appends a line to a log shared by several runs: retries while another process holds the file,
# and never lets logging fail a run.
function Add-LogLine([string]$file, [string]$line) {
  for ($i = 0; $i -lt 40; $i++) {
    try {
      $fs = [IO.File]::Open($file, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
      try { $b = [Text.Encoding]::UTF8.GetBytes($line + "`r`n"); $fs.Write($b, 0, $b.Length) } finally { $fs.Dispose() }
      return
    } catch { Start-Sleep -Milliseconds 150 }
  }
}

function Write-Line([string]$msg) {
  $line = "{0}  [{1}] {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Bot, $msg
  Add-LogLine (Join-Path $Runs 'run-bot.log') $line
  Write-Host $line
}

function Show-Toast([string]$title, [string]$text) {
  try {
    [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
    $esc = { param($s) [Security.SecurityElement]::Escape($s) }
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$(& $esc $title)</text><text>$(& $esc $text)</text></binding></visual></toast>")
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
  } catch { Write-Line "toast failed: $($_.Exception.Message)" }
}

function Wait-Until([scriptblock]$test, [int]$seconds, [string]$what) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try { if (& $test) { return } } catch { }
    Start-Sleep -Seconds 3
  }
  throw "timed out after $seconds s waiting for $what"
}

function Test-Url([string]$url) {
  try { $r = Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 5 -MaximumRedirection 0 -ErrorAction Stop; return $r.StatusCode -lt 500 }
  catch { if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode -lt 500 } return $false }
}

function Invoke-Api([string]$method, [string]$path, $body = $null) {
  $p = @{ Method = $method; Uri = "$Base$path"; TimeoutSec = 30 }
  if ($body) { $p.Body = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 5)); $p.ContentType = 'application/json; charset=utf-8' }
  Invoke-RestMethod @p
}

# Sleep only when nobody is using the PC: no input for 10+ min, or no input since this wake.
function Invoke-SleepIfIdle {
  if ($NoSleep) { Write-Line 'sleep check skipped (-NoSleep)'; return }
  if (-not $DryRunSleep -and (Test-Path (Join-Path $PSScriptRoot 'NOSLEEP'))) { Write-Line 'sleep check skipped (scheduler\NOSLEEP exists)'; return }
  $idleMs = [double][AgentArmy.Native]::IdleMs()
  $idleMin = $idleMs / 60000
  $wake = Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Power-Troubleshooter'; Id = 1 } -MaxEvents 1 -ErrorAction SilentlyContinue
  $wokeForUs = $wake -and ($started - $wake.TimeCreated).TotalMinutes -lt 10 -and $wake.TimeCreated -lt $started
  $inputSinceWake = $true
  if ($wokeForUs) {
    $msSinceWake = ((Get-Date) - $wake.TimeCreated).TotalMilliseconds
    $inputSinceWake = $idleMs -lt $msSinceWake
  }
  $soon = Get-ScheduledTask -TaskPath '\AgentArmy\' -ErrorAction SilentlyContinue | Where-Object State -ne 'Disabled' |
    ForEach-Object { (Get-ScheduledTaskInfo $_).NextRunTime } | Where-Object { $_ -and $_ -gt (Get-Date) -and $_ -lt (Get-Date).AddMinutes(15) }
  $reason = "idle {0:N1} min, woke for this run: {1}, input since wake: {2}, next task within 15 min: {3}" -f $idleMin, [bool]$wokeForUs, $inputSinceWake, [bool]$soon
  if ($soon) { Write-Line "staying awake ($reason)"; return }
  if ($idleMin -ge 10 -or ($wokeForUs -and -not $inputSinceWake)) {
    if ($DryRunSleep) { Write-Line "dry run: would go to sleep now ($reason)"; return }
    Write-Line "going to sleep ($reason)"
    Start-Sleep -Seconds 5
    [void][AgentArmy.Native]::SetSuspendState($false, $false, $false)   # sleep (S3), never shutdown
  } else {
    Write-Line "staying awake, someone is using the PC ($reason)"
  }
}

# One run at a time: a second run waits for the first.
$mutex = New-Object System.Threading.Mutex($false, 'Local\AgentArmyRunBot')
$haveLock = $false
$status = 'failed'; $summary = ''; $runFile = $null; $agentId = $null
try {
  [void][AgentArmy.Native]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
  try { $haveLock = $mutex.WaitOne([TimeSpan]::FromMinutes(35)) } catch [System.Threading.AbandonedMutexException] { $haveLock = $true }
  if (-not $haveLock) { throw 'another bot run held the lock for 35 min' }
  Write-Line "start: $Prompt"

  # 1. Network (Wi-Fi/Ethernet come up a few seconds after waking).
  Wait-Until { [Net.NetworkInformation.NetworkInterface]::GetIsNetworkAvailable() -and [Net.Dns]::GetHostAddresses($NetworkProbeHost).Count -gt 0 } $NetworkWaitSec 'the network'

  # 2. Agent Army.
  if (-not (Test-Url "$Base/api/bots")) {
    Write-Line 'starting Agent Army'
    Start-Process wscript.exe -ArgumentList "`"$(Join-Path $Root 'launcher\agent-army.vbs')`""
    Wait-Until { Test-Url "$Base/api/bots" } 90 'Agent Army'
  }
  $botInfo = (Invoke-Api GET '/api/bots') | Where-Object id -eq $Bot
  if (-not $botInfo) { throw "no bot with id '$Bot' in bots.json" }

  # 3. Dossier (and Docker + its database) when the bot needs it.
  if ($botInfo.requires -and -not $botInfo.online) {
    Write-Line 'starting Dossier'
    # Through cmd: under Windows PowerShell 5.1 a native command's stderr plus ErrorActionPreference=Stop
    # aborts the script ("failed to connect to the docker API") instead of returning an exit code.
    $dockerOk = { cmd /c "docker info >nul 2>&1"; $LASTEXITCODE -eq 0 }
    if (-not (& $dockerOk)) {
      Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
      Wait-Until $dockerOk 240 'Docker Desktop'
    }
    Push-Location $DossierDir; try { cmd /c "docker compose up -d >nul 2>&1" } finally { Pop-Location }
    Wait-Until { Test-Url 'http://localhost:3000/api/health' } 240 'Dossier'
  }

  # 4. Run the bot.
  $agent = Invoke-Api POST '/api/agents' @{ botId = $Bot; name = "Scheduled $(Get-Date -Format 'MM-dd HH:mm')"; prompt = "[scheduled] $Prompt" }
  $agentId = $agent.id
  $deadline = (Get-Date).AddMinutes($TimeoutMin)
  do {
    Start-Sleep -Seconds 10
    $agent = Invoke-Api GET "/api/agents/$agentId"
  } while ($agent.status -in 'queued', 'running' -and (Get-Date) -lt $deadline)
  if ($agent.status -in 'queued', 'running') {
    Invoke-Api POST "/api/agents/$agentId/stop" | Out-Null
    throw "the bot ran longer than $TimeoutMin min and was stopped"
  }
  if ($agent.status -ne 'done') { throw "the bot ended with status '$($agent.status)'" }
  $status = 'ok'
  $summary = $agent.lastResult
} catch {
  $summary = "ERROR: $($_.Exception.Message)"
  Write-Line $summary
} finally {
  $dur = [int]((Get-Date) - $started).TotalSeconds
  try {
    $runFile = Join-Path $Runs ("{0}_{1}.md" -f $started.ToString('yyyy-MM-dd_HHmm'), $Bot)
    # Windows PowerShell 5.1 returns a JSON array as one object: unroll it with foreach.
    $msgs = @(); if ($agentId) { try { $resp = Invoke-Api GET "/api/agents/$agentId/messages"; $msgs = @(foreach ($m in $resp) { $m }) } catch { } }
    $tools = ($msgs | Where-Object kind -eq 'tool' | ForEach-Object { $_.tool -replace '^mcp__dossier__', 'dossier:' }) -join ', '
    $body = @(
      "# ${Bot}: $($started.ToString('yyyy-MM-dd HH:mm'))", '',
      "- Status: **$status**", "- Duration: $dur s", "- Prompt: $Prompt",
      "- Agent: $(if ($agentId) { "$agentId (open it in the dashboard)" } else { 'not started' })",
      "- Tools used: $(if ($tools) { $tools } else { 'none' })", '', '## Result', '', $summary
    ) -join "`n"
    Set-Content -Path $runFile -Value $body -Encoding UTF8
    Add-LogLine (Join-Path $Runs 'runs.log') ("{0}`t{1}`t{2}`t{3}s`t{4}" -f $started.ToString('yyyy-MM-dd HH:mm:ss'), $Bot, $status, $dur, (Split-Path $runFile -Leaf))
  } catch { Write-Line "could not write the run file: $($_.Exception.Message)" }
  $first = (($summary -split "`n") | Where-Object { $_.Trim() -and $_ -notmatch '^\s*[#|-]+\s*$' } | Select-Object -First 1)
  if (-not $first) { $first = $status }
  $first = ($first -replace '[*#`|]', '').Trim(); if ($first.Length -gt 180) { $first = $first.Substring(0, 177) + '...' }
  Show-Toast ("Agent Army: $Bot " + $(if ($status -eq 'ok') { 'done' } else { 'FAILED' })) $first
  Write-Line "end: $status in $dur s"
  [void][AgentArmy.Native]::SetThreadExecutionState($ES_CONTINUOUS)   # release keep-awake
  if ($haveLock) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
  try { Invoke-SleepIfIdle } catch { Write-Line "sleep check failed: $($_.Exception.Message)" }
}
if ($status -ne 'ok') { exit 1 }
