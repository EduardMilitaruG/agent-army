# Creates the app icon, a Desktop shortcut, a Start menu shortcut and a Windows startup entry.
# Run again any time; it overwrites its own shortcuts. To remove: launcher\uninstall.ps1
$ErrorActionPreference = 'Stop'
$appDir = Split-Path $PSScriptRoot -Parent
$vbs = Join-Path $PSScriptRoot 'agent-army.vbs'
$ico = Join-Path $PSScriptRoot 'agent-army.ico'

# --- icon: white rounded square with a black "A" (matches the dashboard logo) ---
Add-Type -AssemblyName System.Drawing
$size = 256
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
$g.Clear([System.Drawing.Color]::Transparent)
$r = 56; $path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $r, $r, 180, 90); $path.AddArc($size - $r - 1, 0, $r, $r, 270, 90)
$path.AddArc($size - $r - 1, $size - $r - 1, $r, $r, 0, 90); $path.AddArc(0, $size - $r - 1, $r, $r, 90, 90); $path.CloseFigure()
$g.FillPath([System.Drawing.Brushes]::White, $path)
$font = New-Object System.Drawing.Font('Segoe UI', 150, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fmt = New-Object System.Drawing.StringFormat; $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
$g.DrawString('A', $font, [System.Drawing.Brushes]::Black, (New-Object System.Drawing.RectangleF 0, 8, $size, $size), $fmt)
$g.Dispose()
# write a PNG-compressed .ico (supported since Windows Vista)
$ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $png = $ms.ToArray()
$fs = [System.IO.File]::Create($ico); $w = New-Object System.IO.BinaryWriter $fs
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]1)
$w.Write([Byte]0); $w.Write([Byte]0); $w.Write([Byte]0); $w.Write([Byte]0)
$w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]$png.Length); $w.Write([UInt32]22)
$w.Write($png); $w.Close(); $bmp.Dispose()

# --- shortcuts ---
$sh = New-Object -ComObject WScript.Shell
function New-Shortcut($lnk, $extra, $desc) {
  $s = $sh.CreateShortcut($lnk)
  $s.TargetPath = "$env:WINDIR\System32\wscript.exe"
  $s.Arguments = ("`"$vbs`" $extra").Trim()
  $s.WorkingDirectory = $appDir
  $s.IconLocation = $ico
  $s.Description = $desc
  $s.Save()
  Write-Host "Created $lnk"
}
$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Agent Army.lnk'
$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Agent Army (background).lnk'
New-Shortcut (Join-Path $desktop 'Agent Army.lnk') '/open' 'Open the Agent Army dashboard'
New-Shortcut $startMenu '/open' 'Open the Agent Army dashboard'
New-Shortcut $startup '' 'Start the Agent Army server in the background at sign-in'
