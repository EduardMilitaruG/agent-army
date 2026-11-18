# Removes the shortcuts and the startup entry created by install.ps1 (leaves the app and your data).
$paths = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Agent Army.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'Agent Army.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Startup')) 'Agent Army (background).lnk')
)
foreach ($p in $paths) { if (Test-Path $p) { Remove-Item $p; Write-Host "Removed $p" } }
