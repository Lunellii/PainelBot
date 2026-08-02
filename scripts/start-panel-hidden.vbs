Option Explicit
Dim shell, fso, root, nodePath, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
nodePath = root & "\runtime\node\node.exe"
command = "cmd.exe /c cd /d """ & root & """ && """ & nodePath & """ scripts\panel-server.mjs >> panel-live.log 2>> panel-error.log"
shell.Run command, 0, False
