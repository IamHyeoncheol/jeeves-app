Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
app = root & "\jeeves-app"
exe = app & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(exe) Then
  MsgBox "Jeeves: electron.exe not found. Run npm install in the jeeves-app folder.", 48, "Jeeves"
  WScript.Quit 1
End If
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = app
sh.Run """" & exe & """ """ & app & """", 1, False
