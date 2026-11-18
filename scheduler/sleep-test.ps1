<#
  Proves the whole wake -> run -> sleep cycle.

  1. .\sleep-test.ps1            schedules a one-off Mentor run 3 minutes from now (wakes the PC),
                                 then put the PC to sleep (Start -> Power -> Sleep) within 2 minutes.
  2. Wait ~10 minutes, wake the PC, then:
     .\sleep-test.ps1 -Report    shows the evidence: last wake source, Agent Army run log,
                                 and Windows wake/sleep events since the test started.
     It also removes the one-off test task.
#>
param([switch]$Report, [int]$Minutes = 3)
$ErrorActionPreference = 'Stop'
$name = 'sleep-test'
$stamp = Join-Path $PSScriptRoot '..\data\runs\sleep-test.started'

if (-not $Report) {
  if (Test-Path (Join-Path $PSScriptRoot 'NOSLEEP')) { Write-Warning 'scheduler\NOSLEEP exists: the PC will NOT go back to sleep. Delete it first for a real test.' }
  $at = (Get-Date).AddMinutes($Minutes)
  $vbs = Join-Path $PSScriptRoot 'hidden.vbs'
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" -Argument "`"$vbs`" mentor-drill" -WorkingDirectory $PSScriptRoot
  Register-ScheduledTask -TaskPath '\AgentArmy\' -TaskName $name -Action $action -Trigger (New-ScheduledTaskTrigger -Once -At $at) -Principal $principal -Settings $settings -Description 'Agent Army: one-off sleep/wake test (Mentor drill)' -Force | Out-Null
  (Get-Date).ToString('o') | Set-Content $stamp
  Write-Host "Test task scheduled for $($at.ToString('HH:mm:ss')). Put the PC to SLEEP now (Start -> Power -> Sleep)."
  Write-Host 'Come back in ~10 minutes, wake it, and run: .\sleep-test.ps1 -Report'
  return
}

$since = if (Test-Path $stamp) { [datetime](Get-Content $stamp) } else { (Get-Date).AddHours(-1) }
Write-Host "=== Evidence since $since`n"
Write-Host '--- powercfg /lastwake'; powercfg /lastwake
Write-Host "`n--- Agent Army runs (data\runs\runs.log)"
Get-Content (Join-Path $PSScriptRoot '..\data\runs\runs.log') | Where-Object { [datetime]($_ -split "`t")[0] -ge $since }
Write-Host "`n--- run-bot.log"
Get-Content (Join-Path $PSScriptRoot '..\data\runs\run-bot.log') | Where-Object { $_ -match '^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d' -and [datetime]$_.Substring(0, 19) -ge $since }
Write-Host "`n--- Windows power events (Kernel-Power 42 = going to sleep, Power-Troubleshooter 1 = woke up)"
Get-WinEvent -FilterHashtable @{ LogName = 'System'; StartTime = $since; Id = 1, 42 } -ErrorAction SilentlyContinue |
  Where-Object { $_.ProviderName -in 'Microsoft-Windows-Kernel-Power', 'Microsoft-Windows-Power-Troubleshooter' } |
  Sort-Object TimeCreated | ForEach-Object {
    $what = if ($_.Id -eq 42) { 'SLEEP' } else { 'WAKE ' + (($_.Message -split "`n" | Where-Object { $_ -match 'Wake Source' }) -join ' ').Trim() }
    '{0}  {1}' -f $_.TimeCreated.ToString('HH:mm:ss'), $what
  }
Unregister-ScheduledTask -TaskPath '\AgentArmy\' -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item $stamp -ErrorAction SilentlyContinue
Write-Host "`nExpected: SLEEP (you) -> WAKE (Timer: AgentArmy sleep-test) -> a mentor 'ok' run -> 'going to sleep' -> SLEEP -> WAKE (you)."
