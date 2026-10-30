# Confere se o painel cobre a tela INTEIRA, inclusive a barra de tarefas do Windows.
# Mostra: tamanho/posição das janelas do GiroPlay, a barra de tarefas (classe Shell_TrayWnd) e qual
# janela está visível na faixa de baixo da tela, onde a barra costuma ficar.
# Uso: powershell -File tools/fullscreen-check.ps1 [-ProcName electron]
param([string]$ProcName = 'electron')
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class FS {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public static string Describe(IntPtr h) {
    var t = new StringBuilder(256); GetWindowText(h, t, 256);
    var c = new StringBuilder(256); GetClassName(h, c, 256);
    RECT r; GetWindowRect(h, out r); uint pid; GetWindowThreadProcessId(h, out pid);
    bool top = (GetWindowLong(h, -20) & 0x8) != 0;
    return (top ? "TOPMOST " : "normal  ") + "(" + r.L + "," + r.T + ") " + (r.R - r.L) + "x" + (r.B - r.T) + " | " + c + " | pid " + pid + " | \"" + t + "\"";
  }
  public static List<string> All() {
    var list = new List<string>(); int z = 0;
    EnumWindows((h, l) => {
      z++;
      if (!IsWindowVisible(h)) return true;
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      var t = new StringBuilder(256); GetWindowText(h, t, 256);
      string cls = c.ToString();
      if (t.Length == 0 && cls != "Shell_TrayWnd" && cls != "Shell_SecondaryTrayWnd") return true;
      list.Add("z=" + z + " " + Describe(h));
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
"tela: $($b.Width)x$($b.Height) | área útil (sem a barra): $($wa.Width)x$($wa.Height) -> a barra ocupa $($b.Height - $wa.Height) px"
"--- janelas na ordem do Windows (de cima para baixo), só as relevantes:"
[FS]::All() | Where-Object { $_ -match 'Shell_TrayWnd|Shell_SecondaryTrayWnd|GiroPlay' } | Select-Object -First 12
foreach ($y in @([int]($b.Height - 20), [int]($b.Height / 2))) {
  $pt = New-Object FS+POINT; $pt.X = [int]($b.Width / 2); $pt.Y = $y
  $h = [FS]::GetAncestor([FS]::WindowFromPoint($pt), 2)
  "janela visível em (x=$($pt.X), y=$y): $([FS]::Describe($h))"
}
