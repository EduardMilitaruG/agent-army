<#
  Registers one Task Scheduler task per entry in tasks.json, under the folder \AgentArmy\.
  Run again after editing tasks.json (the dashboard's Manage bots screen runs it for you):
  - tasks of bots that are turned off or deleted in bots.json are not registered,
  - tasks no longer in tasks.json are removed (the one-off sleep-test is left alone),
  - if the schedule is paused (scheduler\PAUSED exists), new tasks are registered paused too.
  Remove everything with uninstall-tasks.ps1.

  Each task: wakes the computer, runs only while you're logged on, starts as soon as possible after a
  missed start, never runs twice at once, is stopped after 30 min, and also runs on battery.
#>
$ErrorActionPreference = 'Stop'
$folder = '\AgentArmy\'
$vbs = Join-Path $PSScriptRoot 'hidden.vbs'
# Windows PowerShell 5.1 hands a JSON array over as ONE object: unroll it with ForEach-Object.
$tasks = @(Get-Content (Join-Path $PSScriptRoot 'tasks.json') -Raw -Encoding UTF8 | ConvertFrom-Json | ForEach-Object { $_ })
$bots = @(Get-Content (Join-Path (Split-Path $PSScriptRoot -Parent) 'bots.json') -Raw -Encoding UTF8 | ConvertFrom-Json | ForEach-Object { $_ })
if ($tasks.Count -gt 0 -and -not $tasks[0].id) { throw 'tasks.json was not read as a list of tasks; nothing changed.' }
if ($bots.Count -eq 0 -or -not $bots[0].id) { throw 'bots.json was not read as a list of bots; nothing changed.' }
$activeBots = @($bots | Where-Object { -not $_.disabled } | ForEach-Object { $_.id })
$paused = Test-Path (Join-Path $PSScriptRoot 'PAUSED')

if (Get-CimInstance Win32_Battery) { Write-Warning 'A battery was detected: tasks are set to run on battery too. Edit install-tasks.ps1 if you want AC only.' }

# Run only when logged on: Claude Code's login, the toast and Docker Desktop all live in your session.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

$wanted = @()
foreach ($t in $tasks) {
  if ($activeBots -notcontains $t.bot) { Write-Host ("Skipped    {0,-20} (bot '{1}' is off or deleted)" -f $t.id, $t.bot); continue }
  $wanted += $t.id
  $at = [datetime]::ParseExact($t.at, 'HH:mm', $null)
  $trigger = if ($t.days -contains 'daily') { New-ScheduledTaskTrigger -Daily -At $at }
             else { New-ScheduledTaskTrigger -Weekly -DaysOfWeek $t.days -At $at }
  $action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" -Argument "`"$vbs`" $($t.id)" -WorkingDirectory $PSScriptRoot
  Register-ScheduledTask -TaskPath $folder -TaskName $t.id -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description "Agent Army: runs the '$($t.bot)' bot ($($t.prompt))" -Force | Out-Null
  if ($paused) { Disable-ScheduledTask -TaskPath $folder -TaskName $t.id | Out-Null }
  Write-Host ("Registered {0}{1,-20} {2,-9} {3} {4}{5}" -f $folder, $t.id, $t.bot, ($t.days -join ','), $t.at, $(if ($paused) { ' (paused)' } else { '' }))
}

# Remove tasks that are no longer wanted (deleted runs, deleted or turned-off bots).
Get-ScheduledTask -TaskPath $folder -ErrorAction SilentlyContinue | Where-Object { $wanted -notcontains $_.TaskName -and $_.TaskName -ne 'sleep-test' } | ForEach-Object {
  Unregister-ScheduledTask -TaskPath $folder -TaskName $_.TaskName -Confirm:$false
  Write-Host "Removed    $($_.TaskName)"
}
Get-ScheduledTask -TaskPath $folder -ErrorAction SilentlyContinue | ForEach-Object { '{0,-20} {1,-8} next run: {2}' -f $_.TaskName, $_.State, (Get-ScheduledTaskInfo $_).NextRunTime }
