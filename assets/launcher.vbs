' dsh-plugin-debugging - relaunch shim (static; holds no logic).
'
' WHY THIS FILE EXISTS AT ALL (measured 2026-10-17): wscript.exe is a GUI-subsystem
' binary, so a task started through it gets no console window. A task started with
' node.exe - a console program - gets one, and schtasks has no switch to hide it.
' This shim exists only to be that GUI-subsystem hop; every decision lives in
' launcher.js, which is plain Node and unit tested.
'
' PURE ASCII ON PURPOSE: cscript/wscript read a .vbs as ANSI, so a non-ASCII comment
' swallows the statement after it and fails with an undefined-variable error.
'
' NO MODAL DIALOGS (measured the hard way): an unhandled error in a script started by
' wscript.exe pops a message box. When the caller is a scheduled task with no visible
' console, that box is invisible AND modal - the task hangs forever and looks like
' "nothing ran". So every failure path here is caught, logged, and exits non-zero.
'
' USAGE (from the task's /tr value): wscript.exe "launcher.vbs" "<job file>"
' The job file's first three lines are "node=", "launcher=" and "log="; the shim reads
' only those and passes the job file path through unchanged.
Option Explicit

Dim fso, sh, jobPath, nodePath, launcherPath, logPath, f, line
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

Sub Note(message)
  On Error Resume Next
  If logPath <> "" Then
    Dim handle
    Set handle = fso.OpenTextFile(logPath, 8, True)
    handle.WriteLine Now & "  shim: " & message
    handle.Close
  End If
  On Error GoTo 0
End Sub

nodePath = ""
launcherPath = ""
logPath = ""

If WScript.Arguments.Count < 1 Then
  Note "no job file argument; nothing to do"
  WScript.Quit 1
End If
jobPath = WScript.Arguments(0)

If Not fso.FileExists(jobPath) Then
  Note "job file not found: " & jobPath
  WScript.Quit 1
End If

' The job file is written by the tool; reading a few keys with Line() avoids needing a
' JSON parser in VBScript.
On Error Resume Next
Set f = fso.OpenTextFile(jobPath, 1)
Do While Not f.AtEndOfStream
  line = Trim(f.ReadLine)
  If Left(line, 5) = "node=" Then
    nodePath = Mid(line, 6)
  ElseIf Left(line, 9) = "launcher=" Then
    launcherPath = Mid(line, 10)
  ElseIf Left(line, 4) = "log=" Then
    logPath = Mid(line, 5)
  End If
Loop
f.Close
On Error GoTo 0

If nodePath = "" Or launcherPath = "" Then
  Note "job file is missing node= or launcher= (" & jobPath & ")"
  WScript.Quit 1
End If

If Not fso.FileExists(nodePath) Then
  Note "node binary not found: " & nodePath
  WScript.Quit 1
End If

If Not fso.FileExists(launcherPath) Then
  Note "launcher script not found: " & launcherPath
  WScript.Quit 1
End If

' 0 = hidden: this node process, and everything it starts, stays off screen.
On Error Resume Next
sh.Run """" & nodePath & """ """ & launcherPath & """ """ & jobPath & """", 0, False
If Err.Number <> 0 Then
  Note "could not start the launcher (" & Err.Number & "): " & Err.Description
  WScript.Quit 1
End If
On Error GoTo 0
