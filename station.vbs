' qiqi.help render station: double-click to open it, with no terminal window. It starts the
' tray icon (station.ps1), which keeps the station (station.mjs) running and opens its window.
' usage: station.vbs [/quiet]   (/quiet: the tray icon only, no window)
Set fso = CreateObject("Scripting.FileSystemObject")
ps1 = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "station.ps1")
args = " -Open"
If WScript.Arguments.Count > 0 Then
  If WScript.Arguments(0) = "/quiet" Then args = ""
End If
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & ps1 & """" & args, 0, False
