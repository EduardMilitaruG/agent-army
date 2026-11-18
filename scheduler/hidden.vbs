' Runs run-bot.ps1 for one task id with no console window, and waits so Task Scheduler sees the real duration.
'   wscript hidden.vbs <task-id>
Dim sh, fso, ps1, code
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
ps1 = fso.GetParentFolderName(WScript.ScriptFullName) & "\run-bot.ps1"
code = sh.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """ -Task " & WScript.Arguments(0), 0, True)
WScript.Quit code
