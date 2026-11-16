' Silent desktop launcher for Portly (no terminal window)
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = appDir
shell.Run "node """ & appDir & "\desktop-app.js""", 0, False
