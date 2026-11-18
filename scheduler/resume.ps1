# Turns every Agent Army scheduled task back on after pause.ps1.
Get-ScheduledTask -TaskPath '\AgentArmy\' | Enable-ScheduledTask | ForEach-Object { Write-Host "Resumed $($_.TaskName)" }
Remove-Item (Join-Path $PSScriptRoot 'PAUSED') -ErrorAction SilentlyContinue
