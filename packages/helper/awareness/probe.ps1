# Foreground app probe: what is the user looking at, and (for Word) which file.
#
# Enumerates top-level windows in z-order and picks the first real one that is
# not one of ours — the pet's own windows are usually in front when this runs.
# Emits one compact JSON object; fails soft.
param([int]$OwnPid = 0, [string]$OutFile = '')

$ErrorActionPreference = 'SilentlyContinue'

# Windows PowerShell 5.1 writes its redirected stdout in the OEM/ANSI codepage
# by default, which turns Chinese paths into mojibake for the Node parent.
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class FgProbe {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@

$skipClasses = @('Shell_TrayWnd', 'Progman', 'WorkerW', 'Windows.UI.Core.CoreWindow', 'IME', 'MSCTFIME UI')
$script:chosen = $null

$callback = [FgProbe+EnumProc]{
  param([IntPtr]$h, [IntPtr]$l)
  if ($script:chosen) { return $false }

  $title = New-Object System.Text.StringBuilder 512
  [void][FgProbe]::GetWindowText($h, $title, 512)
  $class = New-Object System.Text.StringBuilder 256
  [void][FgProbe]::GetClassName($h, $class, 256)
  $procId = 0
  [void][FgProbe]::GetWindowThreadProcessId($h, [ref]$procId)

  if (-not [FgProbe]::IsWindowVisible($h)) { return $true }
  if ($title.ToString() -eq '') { return $true }
  if ($skipClasses -contains $class.ToString()) { return $true }
  if ($procId -eq $OwnPid) { return $true }

  $name = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
  # 'electron' is the unpackaged runtime our helper runs on; skip the whole
  # family because its windows can be owned by the browser or a renderer.
  if ($name -eq 'electron') { return $true }

  $script:chosen = [pscustomobject]@{
    pid     = $procId
    app     = $name
    title   = $title.ToString()
    class   = $class.ToString()
  }
  return $false
}

[void][FgProbe]::EnumWindows($callback, [IntPtr]::Zero)

if ($null -eq $script:chosen) {
  $payload = '{"app":null}'
} else {
  $docPath = $null
  $page = $null
  try {
    if ($script:chosen.app -eq 'WINWORD') {
      $word = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
      $docPath = $word.ActiveDocument.FullName
      $page = $word.Selection.Information(3)
    }
  } catch { }

  $payload = @{
    pid     = $script:chosen.pid
    app     = $script:chosen.app
    title   = $script:chosen.title
    docPath = $docPath
    page    = $page
  } | ConvertTo-Json -Compress
}

# Write through a file with explicit UTF-8: a redirected PowerShell 5.1 stdout
# pipe mangles non-ASCII regardless of [Console]::OutputEncoding.
if ($OutFile -ne '') {
  [System.IO.File]::WriteAllText($OutFile, $payload, (New-Object System.Text.UTF8Encoding($false)))
} else {
  $payload
}
