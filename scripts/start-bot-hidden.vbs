Option Explicit
Dim shell, fso, root, nodePath, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
nodePath = root & "\runtime\node\node.exe"
command = "cmd.exe /c cd /d """ & root & "\bot-service"" && """ & nodePath & """ --env-file=.env src\server.mjs >> bot-live.log 2>> bot-error.log"
shell.Run command, 0, False
