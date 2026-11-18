# Pauses every Agent Army scheduled task (they stay registered; resume.ps1 turns them back on).
Get-ScheduledTask -TaskPath '\AgentArmy\' | Disable-ScheduledTask | ForEach-Object { Write-Host "Paused  $($_.TaskName)" }
New-Item -ItemType File -Force (Join-Path $PSScriptRoot 'PAUSED') | Out-Null   # the dashboard shows "paused"
