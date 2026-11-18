# Removes every Agent Army scheduled task (the \AgentArmy\ folder). Leaves your data and run logs.
Get-ScheduledTask -TaskPath '\AgentArmy\' -ErrorAction SilentlyContinue | ForEach-Object {
  Unregister-ScheduledTask -TaskPath $_.TaskPath -TaskName $_.TaskName -Confirm:$false
  Write-Host "Removed $($_.TaskPath)$($_.TaskName)"
}
