# dsh-plugin-debugging - visible stop window.
#
# PURE ASCII ON PURPOSE: PowerShell 5.1 reads a .ps1 without a BOM as ANSI, so any
# non-ASCII character here corrupts the file at parse time. Keep it ASCII.
#
# WHAT THIS IS
#   The visible stop control of a host that has no console. The hidden launcher removes
#   the console, and the console used to be the only obvious way to stop DSH.
#
# HOW ENDING THIS WINDOW ENDS DSH
#   It holds a Windows Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE and keeps the
#   host assigned to it. The moment this process ends - window closed, Ctrl+C, or killed -
#   the last handle to the job closes and the kernel terminates everything in it. That is
#   why all three ways work, and why none of them needs a signal or a pid lookup here.
#
#   Nothing in this file calls taskkill or stops a process by name. Ending the host is a
#   kernel side effect of this process ending; see docs/SHAPE.md for the measurements.
#
# SINGLETON
#   A named mutex per port, so a second attempt for the same port exits immediately. The
#   launcher also checks the pid file first, which is what keeps N restarts at one window.
param(
  [Parameter(Mandatory)][int]$Port,
  [Parameter(Mandatory)][string]$PidFile,
  [Parameter(Mandatory)][string]$LogPath,
  [Parameter(Mandatory)][string]$MarkerPath,
  [int]$FirstAppearanceSeconds = 180,
  [int]$RestartWaitSeconds = 150,
  [int]$GraceSeconds = 5
)

$ErrorActionPreference = 'Stop'

# ============================================================================
# CTRL+C IS READ AS A KEYSTROKE, NOT AS A SIGNAL (measured 2026-10-17)
#
# The launcher starts this window through `wscript show-window.vbs`, which uses
# Shell.Run to create a NEW PROCESS GROUP. Windows disables Ctrl+C for such a
# group, so the signal never reaches this process: the user held Ctrl+C and the
# window simply ignored it, while closing the window still worked.
#
# `TreatControlCAsInput` sidesteps the whole question: Ctrl+C arrives in the
# console input buffer as an ordinary key press, and the main loop polls for it.
# That is independent of process-group flags, of console modes set by ancestors,
# and of whether anything installed a control handler.
#
# Nothing else changes: however this process ends, the job handle closes and the
# kernel terminates the host. This block only makes Ctrl+C one of the ways.
# ============================================================================
try {
  [Console]::TreatControlCAsInput = $true
} catch {
  # No console (should not happen for this window). Closing the window still works.
}

<#
.SYNOPSIS
  Waits, and returns $true if Ctrl+C was pressed meanwhile.

.DESCRIPTION
  The wait is sliced into 100 ms steps so a key press is noticed promptly instead of
  after the next full one-second tick.
#>
function Wait-OrCtrlC([int] $milliseconds) {
  $deadline = (Get-Date).AddMilliseconds($milliseconds)
  while ((Get-Date) -lt $deadline) {
    try {
      if ([Console]::KeyAvailable) {
        $key = [Console]::ReadKey($true)
        if ($key.Key -eq 'C' -and ($key.Modifiers -band [ConsoleModifiers]::Control)) {
          return $true
        }
      }
    } catch {
      # Reading the console failed; fall back to plain sleeping.
      Start-Sleep -Milliseconds 100
    }
    Start-Sleep -Milliseconds 100
  }
  return $false
}

function Say([string] $message) {
  try {
    Add-Content -LiteralPath $LogPath -Value ('{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $message) -Encoding UTF8
  } catch {
  }
}

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, ('Global\DshStopWindow-' + $Port), [ref] $createdNew)
if (-not $createdNew) {
  Say ('already running for port ' + $Port + '; this attempt exits')
  $mutex.Dispose()
  exit 0
}

# -NoNewline: a trailing newline would break the launcher log line that echoes this pid.
Set-Content -LiteralPath $PidFile -Value $PID -NoNewline -Encoding ASCII
Say ('window up (pid ' + $PID + ', port ' + $Port + ')')

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DshStopWindowJob
{
    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct BASIC_LIMIT
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct EXTENDED_LIMIT
    {
        public BASIC_LIMIT BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const int PROCESS_SET_QUOTA = 0x0100;
    const int PROCESS_TERMINATE = 0x0001;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(int access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    // Returns a handle the caller must KEEP OPEN for as long as it wants the host bound:
    // closing it is exactly what terminates the members.
    public static long CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            throw new Exception("CreateJobObject failed (win32 " + Marshal.GetLastWin32Error() + ")");
        }

        EXTENDED_LIMIT extended = new EXTENDED_LIMIT();
        extended.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int length = Marshal.SizeOf(typeof(EXTENDED_LIMIT));
        IntPtr buffer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(extended, buffer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint) length))
            {
                throw new Exception("SetInformationJobObject failed (win32 " + Marshal.GetLastWin32Error() + ")");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }

        return job.ToInt64();
    }

    // Assigns an ALREADY RUNNING process. Nested jobs are allowed: the host is normally
    // already inside its own job and can still be adopted (measured).
    public static void PutInJob(long jobHandle, int pid)
    {
        IntPtr process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid);
        if (process == IntPtr.Zero)
        {
            throw new Exception("OpenProcess failed (win32 " + Marshal.GetLastWin32Error() + ")");
        }

        bool assigned;
        int error;
        try
        {
            assigned = AssignProcessToJobObject(new IntPtr(jobHandle), process);
            error = Marshal.GetLastWin32Error();
        }
        finally
        {
            CloseHandle(process);
        }

        if (!assigned)
        {
            throw new Exception("AssignProcessToJobObject failed (win32 " + error + ")");
        }
    }
}
'@

$script:job = 0
$script:adoptedPid = 0
$script:everBound = $false
$script:lastTarget = 0
$script:reArmedFor = 0
$script:lastBindNote = ""

# Liveness only: nothing in this file ends a process (see the file header).
function HostAlive([int] $ProcessId) {
  if ($ProcessId -le 0) { return $false }
  return ($null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue))
}

# Writes a note once per distinct message. The bind path runs every second, so a plain
# Say buried the log in identical lines (measured: 30+ lines per failed restart).
function Bind-Note([string] $Message) {
  if ($Message -ne $script:lastBindNote) {
    $script:lastBindNote = $Message
    Say $Message
  }
}

<#
.SYNOPSIS
  Creates the control job and makes it the current one.

.DESCRIPTION
  Deliberately does NOT close the handle it replaces. Closing a KILL_ON_JOB_CLOSE job
  ends every process still inside it, and "is anything still inside it" is the one thing
  this script cannot know for sure. An abandoned empty job costs one handle until this
  process ends; a wrong close costs a running host.
#>
function Open-ControlJob([string] $Why) {
  try {
    $script:job = [DshStopWindowJob]::CreateKillOnCloseJob()
    Say ('control job created (handle ' + $script:job + '; ' + $Why + ')')
  } catch {
    $script:job = 0
    Say ('could not create the control job: ' + $_.Exception.Message)
  }
}

<#
.SYNOPSIS
  Adopts a host pid into the control job, re-arming the job when the hierarchy forbids it.

.DESCRIPTION
  A job handle is fixed to one branch of the job hierarchy by its FIRST adoption: once it
  holds a process, Windows refuses (win32 5, ERROR_ACCESS_DENIED) to add a process coming
  from a different tree. That is why a window that survived a restart could never take
  control of the new host again (measured 2026-10-18: one handle adopted 29260 at 13:26
  and refused 33696 at 13:40, while a freshly started window adopted a host immediately).
  A new handle starts a new hierarchy, so re-arming is the fix.

  The re-arm is guarded: it happens only while the previously adopted host is GONE, which
  is the only situation where abandoning the old handle cannot end a live process.
#>
function Bind-Host([int] $ProcessId) {
  if ($script:lastTarget -ne $ProcessId) {
    $script:lastTarget = $ProcessId
    $script:reArmedFor = 0
  }
  if ($script:job -eq 0) { Open-ControlJob 'initial' }

  try {
    [DshStopWindowJob]::PutInJob($script:job, $ProcessId)
    $script:adoptedPid = $ProcessId
    $script:everBound = $true
    $script:lastBindNote = ""
    Say ('bound to host pid ' + $ProcessId)
    return $true
  } catch {
    Bind-Note ('could not bind pid ' + $ProcessId + ': ' + $_.Exception.Message)
  }

  if (-not $script:everBound) { return $false }
  if (HostAlive $script:adoptedPid) { return $false }
  if ($script:reArmedFor -eq $ProcessId) { return $false }

  $script:reArmedFor = $ProcessId
  Open-ControlJob ('re-armed for pid ' + $ProcessId + '; the previous handle sat in another job tree')
  if ($script:job -eq 0) { return $false }
  try {
    [DshStopWindowJob]::PutInJob($script:job, $ProcessId)
    $script:adoptedPid = $ProcessId
    $script:lastBindNote = ""
    Say ('bound to host pid ' + $ProcessId + ' after re-arming the control job')
    return $true
  } catch {
    Say ('re-arming did not help for pid ' + $ProcessId + ': ' + $_.Exception.Message)
    return $false
  }
}

Open-ControlJob 'initial'

$bound = 0
$waited = 0

function Show-Panel {
  param([string] $Title, [string[]] $Lines, [string] $Colour)
  try { $Host.UI.RawUI.WindowTitle = $Title } catch { }
  Clear-Host
  foreach ($line in $Lines) { Write-Host $line -ForegroundColor $Colour }
}

try {
  while ($true) {
    $owner = 0
    $ownerName = ''
    try {
      $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
      if ($connection) {
        $owner = [int] $connection.OwningProcess
        $ownerName = (Get-Process -Id $owner -ErrorAction SilentlyContinue).ProcessName
      }
    } catch {
    }

    if ($owner -ne 0) {
      $waited = 0

      if ($owner -ne $bound) {
        if ($ownerName -eq 'node') {
          if (Bind-Host $owner) { $bound = $owner } else { $bound = 0 }
        }
        elseif ($ownerName -ne 'node') {
          # Never adopt a process that is not a DSH host: adopting it would make closing
          # this window end something unrelated.
          $bound = 0
          Bind-Note ('refusing to bind pid ' + $owner + ': process name is ' + $ownerName + ', not node')
        }
      }

      if ($bound -ne 0) {
        Show-Panel -Title ('DSH ' + $Port + ' (pid ' + $bound + ')') -Colour 'Green' -Lines @(
          ''
          ('  DSH is running  (pid ' + $bound + ', port ' + $Port + ')')
          ''
          '  DSH lives as long as this window.'
          '  Ending this window ends DSH: close it, or press Ctrl+C.'
        )
      }
      else {
        Show-Panel -Title ('DSH ' + $Port + ' (not bound)') -Colour 'Yellow' -Lines @(
          ''
          ('  Something is listening on port ' + $Port + ' (pid ' + $owner + ', ' + $ownerName + ').')
          ''
          '  This window did not take control of it, so ending this window'
          '  will NOT end it. The log has the reason:'
          ('    ' + $LogPath)
        )
      }
    }
    else {
      if ($bound -ne 0) {
        if (Test-Path -LiteralPath $MarkerPath) {
          # A restart is in flight: the marker is still on disk and the new host is still
          # starting (measured 21-22 s). Keep waiting instead of disappearing meanwhile.
          $left = $RestartWaitSeconds - $waited
          if ($left -le 0) { Say 'gave up waiting for the host to come back'; break }
          $waited++
          Show-Panel -Title ('DSH ' + $Port + ' (restarting)') -Colour 'Cyan' -Lines @(
            ''
            ('  DSH on port ' + $Port + ' is restarting.')
            ''
            ('  Waiting up to ' + $left + ' more seconds for it to come back.')
          )
        }
        else {
          # The host was stopped some other way (not by this window). Leave a short grace,
          # then go away rather than linger as an empty shell.
          $left = $GraceSeconds - $waited
          if ($left -le 0) { Say 'host is gone and no restart is in flight; leaving'; break }
          $waited++
          Show-Panel -Title ('DSH ' + $Port + ' (not running)') -Colour 'DarkYellow' -Lines @(
            ''
            ('  DSH is not running on port ' + $Port + '.')
            ''
            ('  This window closes by itself in ' + $left + ' s.')
          )
        }
      }
      else {
        # Normal, not an error: the launcher starts the host first and the host needs a
        # while before it listens, so the window routinely comes up before the host does.
        $left = $FirstAppearanceSeconds - $waited
        if ($left -le 0) { Say 'no host ever appeared on this port; leaving'; break }
        $waited++
        Show-Panel -Title ('DSH ' + $Port + ' (waiting)') -Colour 'Gray' -Lines @(
          ''
          ('  Waiting for DSH to appear on port ' + $Port + '.')
          ''
          ('  Gives up in ' + $left + ' s if it never does.')
        )
      }
    }

    if (Wait-OrCtrlC 1000) {
      Say 'ctrl+c pressed; ending the window (and with it the host)'
      break
    }
  }
}
finally {
  if ($bound -ne 0) { Say ('window leaving; host pid ' + $bound + ' ends with it') }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  try { $mutex.ReleaseMutex() } catch { }
  $mutex.Dispose()
  Say 'window down'
}
