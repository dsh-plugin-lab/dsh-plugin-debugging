' dsh-plugin-debugging - show a console window running a command from the job file.
'
' WHY THIS EXISTS (measured 2026-10-17): Node cannot ask Windows for CREATE_NEW_CONSOLE.
' `spawn(..., { detached: true })` maps to DETACHED_PROCESS - no console at all - and a
' non-detached child just inherits its parent's (hidden) console. So the only way to get
' a *visible* console window from a process that has none is this hop: wscript.exe is a
' GUI-subsystem binary, and Shell.Run with style 1 asks for a new visible console.
'
' WHY IT TAKES A FILE PATH AND NOT THE COMMAND (measured the hard way): Node escapes
' `"` inside an argument as `\"`, and wscript's argument parser does not undo that. The
' command arrived with stray backslashes, Shell.Run failed silently, and the only symptom
' was "no window". Passing a path avoids quoting entirely - the command is read verbatim
' from the job file's `stopWindowCommand` line.
'
' PURE ASCII ON PURPOSE: cscript/wscript read a .vbs as ANSI, so a non-ASCII comment
' swallows the statement after it and fails with an undefined-variable error.
'
' NO MODAL DIALOGS: an unhandled error here pops an invisible modal box and the caller
' waits forever, which looks exactly like "nothing happened". Every failure path is
' caught and exits non-zero.
'
' USAGE: wscript.exe "show-window.vbs" "<job file>"
Option Explicit

Dim fso, sh, jobPath, logPath, command, f, line, found

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

Sub Note(message)
  On Error Resume Next
  If logPath <> "" Then
    Dim handle
    Set handle = fso.OpenTextFile(logPath, 8, True)
    handle.WriteLine Now & "  show-window: " & message
    handle.Close
  End If
  On Error GoTo 0
End Sub

logPath = ""
command = ""

If WScript.Arguments.Count < 1 Then
  WScript.Quit 1
End If
jobPath = WScript.Arguments(0)
If Not fso.FileExists(jobPath) Then
  WScript.Quit 1
End If

On Error Resume Next
Set f = fso.OpenTextFile(jobPath, 1)
Do While Not f.AtEndOfStream
  line = f.ReadLine
  If Left(line, 4) = "log=" Then
    logPath = Trim(Mid(line, 5))
  ElseIf Left(line, 18) = "stopWindowCommand=" Then
    ' Not trimmed: the command is used verbatim, and Trim would also be harmless, but
    ' keeping it verbatim makes it obvious that nothing here rewrites the string.
    command = Mid(line, 19)
  End If
Loop
f.Close
On Error GoTo 0

If command = "" Then
  Note "job file has no stopWindowCommand line"
  WScript.Quit 1
End If

' 1 = normal window: this is the visible stop control, so it must not be hidden.
On Error Resume Next
sh.Run command, 1, False
If Err.Number <> 0 Then
  Note "could not start the stop window (" & Err.Number & "): " & Err.Description
  WScript.Quit 1
End If
On Error GoTo 0
