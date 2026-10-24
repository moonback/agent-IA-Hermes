# HERMES desktop worker: one JSON command on stdin, one JSON result on stdout.
# Uses Windows UI Automation (semantic control access) and never clicks screen coordinates.
# Runs as the current user, without elevation, in a separate short-lived process.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HermesWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public MOUSEINPUT mi; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  // Windows refuses SetForegroundWindow from a background process. A neutral synthetic input
  // (zero-distance mouse move) makes this process the last input source, and the input queue of
  // the current foreground thread is shared during the call: both are documented conditions.
  // KEYBDINPUT inside the 40-byte x64 INPUT union.
  [StructLayout(LayoutKind.Explicit, Size = 40)] struct KINPUT {
    [FieldOffset(0)] public uint type; [FieldOffset(8)] public ushort vk; [FieldOffset(10)] public ushort scan;
    [FieldOffset(12)] public uint flags; [FieldOffset(16)] public uint time; [FieldOffset(24)] public IntPtr extra;
  }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, KINPUT[] inputs, int size);
  // Types text as Unicode characters (KEYEVENTF_UNICODE): independent of the keyboard layout.
  public static void TypeUnicode(string text) {
    foreach (char c in text.Replace(((char)13).ToString(), "")) {
      KINPUT[] k = new KINPUT[2];
      for (int i = 0; i < 2; i++) {
        k[i].type = 1; // INPUT_KEYBOARD
        if (c == (char)10) { k[i].vk = 0x0D; k[i].flags = (uint)(i == 1 ? 0x2 : 0); }
        else { k[i].scan = c; k[i].flags = (uint)(0x4 | (i == 1 ? 0x2 : 0)); }
      }
      SendInput(2, k, Marshal.SizeOf(typeof(KINPUT)));
    }
  }
  public static bool Activate(IntPtr h) {
    INPUT[] nudge = new INPUT[1];
    nudge[0].type = 0; nudge[0].mi.dwFlags = 0x0001; // INPUT_MOUSE, MOUSEEVENTF_MOVE by (0,0)
    SendInput(1, nudge, Marshal.SizeOf(typeof(INPUT)));
    uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    uint cur = GetCurrentThreadId();
    bool attached = fgThread != 0 && fgThread != cur && AttachThreadInput(cur, fgThread, true);
    try {
      ShowWindow(h, IsIconic(h) ? 9 : 5);
      BringWindowToTop(h);
      return SetForegroundWindow(h);
    } finally {
      if (attached) AttachThreadInput(cur, fgThread, false);
    }
  }
}
'@

$AE = [System.Windows.Automation.AutomationElement]
# Classic Win32/WinForms controls need the client-side proxies; without them they appear as bare panes.
# The UIA client must be initialised (RootElement) before registering them.
$null = $AE::RootElement
try {
  [System.Windows.Automation.ClientSettings]::RegisterClientSideProviderAssembly(
    (New-Object System.Reflection.AssemblyName('UIAutomationClientsideProviders, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')))
} catch { }

function Out-Result($obj) {
  [Console]::Out.Write((ConvertTo-Json -InputObject $obj -Depth 12 -Compress))
}

function Fail($code, $message) {
  Out-Result @{ ok = $false; code = $code; error = $message }
  exit 0
}

function Get-ProcName([int]$procId) {
  try { return (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { return $null }
}

function Rect($r) {
  if ($r.IsEmpty) { return $null }
  return @{ x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height }
}

function Describe($el, [bool]$withValue) {
  $c = $el.Current
  $patterns = @($el.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName -replace 'Identifiers\.Pattern$', '' -replace 'Pattern$', '' })
  $d = [ordered]@{
    name = $c.Name
    controlType = ($c.ControlType.ProgrammaticName -replace '^ControlType\.', '')
    automationId = $c.AutomationId
    className = $c.ClassName
    isEnabled = $c.IsEnabled
    isOffscreen = $c.IsOffscreen
    isPassword = $c.IsPassword
    patterns = $patterns
    bounds = (Rect $c.BoundingRectangle)
  }
  if ($withValue -and -not $c.IsPassword -and $patterns -contains 'Value') {
    try {
      $v = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
      if ($v.Length -gt 500) { $v = $v.Substring(0, 500) }
      $d.value = $v
    } catch { }
  }
  return $d
}

# Re-resolves the window from its handle and checks it is still the one the agent observed.
function Get-CheckedWindow($cmd) {
  $h = [IntPtr][long]$cmd.windowHandle
  if (-not [HermesWin32]::IsWindow($h)) { Fail 'WINDOW_GONE' "La fenêtre $($cmd.windowHandle) n'existe plus" }
  $win = $AE::FromHandle($h)
  if ($win.Current.Name -ne $cmd.expectedWindowTitle) {
    Fail 'WINDOW_CHANGED' "Titre actuel « $($win.Current.Name) » différent du titre observé « $($cmd.expectedWindowTitle) »"
  }
  $pn = Get-ProcName $win.Current.ProcessId
  if ($pn -ne $cmd.processName) { Fail 'PROCESS_MISMATCH' "Processus réel « $pn » différent de « $($cmd.processName) »" }
  return $win
}

function Find-Single($win, $cmd) {
  $conds = New-Object System.Collections.Generic.List[System.Windows.Automation.Condition]
  if ($cmd.name) { $conds.Add((New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, [string]$cmd.name))) }
  if ($cmd.automationId) { $conds.Add((New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, [string]$cmd.automationId))) }
  if ($cmd.controlType) {
    $ct = [System.Windows.Automation.ControlType].GetField([string]$cmd.controlType).GetValue($null)
    $conds.Add((New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $ct)))
  }
  if ($conds.Count -eq 0) { Fail 'NO_TARGET' 'Cible requise : name, automationId ou controlType' }
  $cond = if ($conds.Count -eq 1) { $conds[0] } else { New-Object System.Windows.Automation.AndCondition(, $conds.ToArray()) }
  $found = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  if ($found.Count -eq 0) { Fail 'NOT_FOUND' 'Aucun contrôle ne correspond à la cible' }
  if ($found.Count -gt 1) { Fail 'AMBIGUOUS' "$($found.Count) contrôles correspondent ; précisez automationId ou controlType" }
  $el = $found[0]
  if (-not $el.Current.IsEnabled) { Fail 'DISABLED' 'Le contrôle est désactivé' }
  return $el
}

$KEYS = @{
  'ENTER' = '{ENTER}'; 'TAB' = '{TAB}'; 'ESC' = '{ESC}'; 'UP' = '{UP}'; 'DOWN' = '{DOWN}'; 'LEFT' = '{LEFT}'; 'RIGHT' = '{RIGHT}'
  'HOME' = '{HOME}'; 'END' = '{END}'; 'PGUP' = '{PGUP}'; 'PGDN' = '{PGDN}'; 'BACKSPACE' = '{BACKSPACE}'; 'DELETE' = '{DEL}'; 'F5' = '{F5}'
  'CTRL+A' = '^a'; 'CTRL+C' = '^c'; 'CTRL+V' = '^v'; 'CTRL+S' = '^s'; 'CTRL+Z' = '^z'; 'CTRL+F' = '^f'; 'CTRL+N' = '^n'; 'CTRL+W' = '^w'; 'ALT+F4' = '%{F4}'
}

try {
  $cmd = [Console]::In.ReadToEnd() | ConvertFrom-Json
  switch ($cmd.op) {
    'probe' {
      Out-Result @{ ok = $true; psVersion = $PSVersionTable.PSVersion.ToString(); os = [Environment]::OSVersion.VersionString }
    }
    'screenshot' {
      [void][HermesWin32]::SetProcessDPIAware()
      $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      try {
        $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
        $bmp.Save([string]$cmd.path, [System.Drawing.Imaging.ImageFormat]::Png)
      } finally { $g.Dispose(); $bmp.Dispose() }
      Out-Result @{ ok = $true; path = [string]$cmd.path; width = $b.Width; height = $b.Height }
    }
    'windows' {
      $fg = [long][HermesWin32]::GetForegroundWindow()
      $list = @()
      foreach ($w in $AE::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
        $c = $w.Current
        if ([string]::IsNullOrWhiteSpace($c.Name)) { continue }
        $list += [ordered]@{
          handle = [long]$c.NativeWindowHandle
          title = $c.Name
          processId = $c.ProcessId
          processName = (Get-ProcName $c.ProcessId)
          className = $c.ClassName
          isForeground = ([long]$c.NativeWindowHandle -eq $fg)
          bounds = (Rect $c.BoundingRectangle)
        }
      }
      Out-Result @{ ok = $true; windows = $list; foregroundHandle = $fg }
    }
    'inspect' {
      $h = [IntPtr][long]$cmd.windowHandle
      if (-not [HermesWin32]::IsWindow($h)) { Fail 'WINDOW_GONE' "La fenêtre $($cmd.windowHandle) n'existe plus" }
      $win = $AE::FromHandle($h)
      $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
      $script:count = 0
      $max = [int]$cmd.maxNodes
      function Walk($el, [int]$depth) {
        if ($script:count -ge $max) { return $null }
        $script:count++
        $node = Describe $el $true
        if ($depth -lt [int]$cmd.maxDepth) {
          $children = @()
          $child = $walker.GetFirstChild($el)
          while ($null -ne $child -and $script:count -lt $max) {
            $n = Walk $child ($depth + 1)
            if ($n) { $children += $n }
            $child = $walker.GetNextSibling($child)
          }
          if ($children.Count -gt 0) { $node.children = $children }
        }
        return $node
      }
      $tree = Walk $win 0
      Out-Result @{ ok = $true; window = @{ handle = [long]$cmd.windowHandle; title = $win.Current.Name; processName = (Get-ProcName $win.Current.ProcessId) }; tree = $tree; nodeCount = $script:count; truncated = ($script:count -ge $max) }
    }
    'click' {
      $win = Get-CheckedWindow $cmd
      $el = Find-Single $win $cmd
      $p = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); $action = 'invoke' }
      elseif ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle(); $action = 'toggle' }
      elseif ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select(); $action = 'select' }
      elseif ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { $p.Expand(); $action = 'expand' }
      else { Fail 'NO_SEMANTIC_ACTION' "Le contrôle n'expose aucune action UI Automation (Invoke/Toggle/Select/Expand)" }
      Start-Sleep -Milliseconds 200
      Out-Result @{ ok = $true; action = $action; element = (Describe $el $false); windowStillExists = [HermesWin32]::IsWindow([IntPtr][long]$cmd.windowHandle) }
    }
    'type' {
      $win = Get-CheckedWindow $cmd
      $el = Find-Single $win $cmd
      if ($el.Current.IsPassword) { Fail 'PASSWORD_FIELD' 'Saisie dans un champ mot de passe interdite' }
      $text = [string]$cmd.text
      $p = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) {
        if ($p.Current.IsReadOnly) { Fail 'READ_ONLY' 'Le contrôle est en lecture seule' }
        $p.SetValue($text)
        $after = $p.Current.Value
        Out-Result @{ ok = $true; method = 'value'; element = (Describe $el $false); valueMatches = ($after -eq $text); valueLength = $after.Length }
      } else {
        # Fallback for edit controls exposing only TextPattern (e.g. Notepad): focus this exact element,
        # check the focus really landed there, type at the caret, then read the document back.
        $tp = $null
        if (-not $el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) { Fail 'NO_TEXT_INPUT' "Le contrôle n'accepte pas de saisie (ni ValuePattern ni TextPattern)" }
        if (-not $el.Current.IsKeyboardFocusable) { Fail 'NOT_FOCUSABLE' 'Le contrôle ne peut pas recevoir le focus clavier' }
        $h = [IntPtr][long]$cmd.windowHandle
        [void][HermesWin32]::Activate($h)
        Start-Sleep -Milliseconds 250
        # Activating the window often focuses its main edit already; SetFocus is only a complement.
        if (-not $el.Current.HasKeyboardFocus) { try { $el.SetFocus(); Start-Sleep -Milliseconds 150 } catch { } }
        $isFg = [long][HermesWin32]::GetForegroundWindow() -eq [long]$h
        if (-not $isFg -or -not $el.Current.HasKeyboardFocus) { Fail 'FOCUS_FAILED' "Impossible de donner le focus au contrôle (fenêtre au premier plan : $isFg, contrôle focalisé : $($el.Current.HasKeyboardFocus)) ; texte non saisi" }
        [HermesWin32]::TypeUnicode($text)
        Start-Sleep -Milliseconds 200
        $doc = $tp.DocumentRange.GetText(-1)
        Out-Result @{ ok = $true; method = 'keyboard'; element = (Describe $el $false); valueMatches = ($doc -replace "`r`n", "`n").Contains(($text -replace "`r`n", "`n")); valueLength = $doc.Length; readBack = $(if ($doc.Length -gt 500) { $doc.Substring(0, 500) } else { $doc }) }
      }
    }
    'keypress' {
      $win = Get-CheckedWindow $cmd
      $seq = $KEYS[[string]$cmd.keys]
      if (-not $seq) { Fail 'KEY_NOT_ALLOWED' "Touche non autorisée : $($cmd.keys)" }
      $h = [IntPtr][long]$cmd.windowHandle
      [void][HermesWin32]::Activate($h)
      Start-Sleep -Milliseconds 200
      if ([long][HermesWin32]::GetForegroundWindow() -ne [long]$h) { Fail 'FOCUS_FAILED' "Impossible d'amener la fenêtre au premier plan ; touche non envoyée" }
      [System.Windows.Forms.SendKeys]::SendWait($seq)
      Out-Result @{ ok = $true; keys = [string]$cmd.keys; foregroundAfter = [long][HermesWin32]::GetForegroundWindow() }
    }
    default { Fail 'UNKNOWN_OP' "Opération inconnue : $($cmd.op)" }
  }
} catch {
  Out-Result @{ ok = $false; code = 'WORKER_ERROR'; error = $_.Exception.Message }
}
