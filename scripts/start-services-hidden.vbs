Option Explicit
Dim shell, fso, root, nodePath, botCommand, panelCommand
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
nodePath = root & "\runtime\node\node.exe"
botCommand = "cmd.exe /c cd /d """ & root & "\bot-service"" && """ & nodePath & """ --env-file=.env src\server.mjs >> bot-live.log 2>> bot-error.log"
panelCommand = "cmd.exe /c cd /d """ & root & """ && """ & nodePath & """ scripts\panel-server.mjs >> panel-live.log 2>> panel-error.log"
shell.Run botCommand, 0, False
WScript.Sleep 1200
shell.Run panelCommand, 0, False
