Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
app = root & "\jeeves-app"
exe = app & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(exe) Then
  MsgBox "Jeeves: electron.exe not found. Run npm install in the jeeves-app folder.", 48, "Jeeves"
  WScript.Quit 1
End If
Set sh = CreateObject("WScript.Shell")

' Auto update on start: git pull --ff-only (safe: never merges or overwrites local changes).
' Skipped when Jeeves is already running (it may be editing its own folder) or when git is missing.
running = False
On Error Resume Next
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("SELECT CommandLine FROM Win32_Process WHERE Name = 'electron.exe'")
For Each p In procs
  If Not IsNull(p.CommandLine) Then
    If InStr(1, p.CommandLine, app, vbTextCompare) > 0 Then running = True
  End If
Next
On Error GoTo 0
If Not running And fso.FolderExists(root & "\.git") Then
  logf = app & "\update-log.txt"
  cmd = "cmd /c cd /d """ & root & """ && git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=15 pull --ff-only > """ & logf & """ 2>&1"
  On Error Resume Next
  sh.Run cmd, 0, True
  On Error GoTo 0
End If

sh.CurrentDirectory = app
sh.Run """" & exe & """ """ & app & """", 1, False
