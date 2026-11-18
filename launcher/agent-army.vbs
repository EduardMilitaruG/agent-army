' Agent Army launcher
'   agent-army.vbs          -> start the server silently in the background (used at Windows startup)
'   agent-army.vbs /open    -> make sure the server runs, then open the dashboard as an app window
Option Explicit
Dim sh, fso, appDir, node, edge, url, http, ok, i
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
url = "http://localhost:4777"

Function ServerUp()
  On Error Resume Next
  Dim req
  Set req = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  req.setTimeouts 1000, 1000, 1000, 1000
  req.Open "GET", url & "/", False
  req.Send
  ServerUp = (Err.Number = 0 And req.Status = 200)
  On Error GoTo 0
End Function

If Not ServerUp() Then
  node = "C:\Program Files\nodejs\node.exe"
  If Not fso.FileExists(node) Then node = "node"
  sh.CurrentDirectory = appDir
  ' 0 = hidden window, False = don't wait. Output goes to data\server.log
  sh.Run "cmd /c """"" & node & """ server.js >> data\server.log 2>&1""", 0, False
End If

If WScript.Arguments.Count > 0 Then
  If LCase(WScript.Arguments(0)) = "/open" Then
    ok = False
    For i = 1 To 20
      If ServerUp() Then ok = True : Exit For
      WScript.Sleep 500
    Next
    edge = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe"
    If fso.FileExists(edge) Then
      sh.Run """" & edge & """ --app=" & url, 1, False
    Else
      sh.Run url, 1, False
    End If
    If Not ok Then MsgBox "Agent Army server did not start. See data\server.log", 48, "Agent Army"
  End If
End If
