# Lista as janelas visíveis na ordem em que o Windows as empilha (de cima para baixo) e quais são TOPMOST.
# Diagnóstico para tools/test-fluxo.js: mostra quem está na frente de quem.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class Z {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static List<string> All() {
    var list = new List<string>(); int order = 0;
    EnumWindows((h, l) => {
      order++;
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
      if (sb.Length == 0) return true;
      int ex = GetWindowLong(h, -20); RECT r; GetWindowRect(h, out r);
      uint pid; GetWindowThreadProcessId(h, out pid);
      bool top = (ex & 0x8) != 0;
      list.Add(order + "|" + (top ? "TOPMOST" : "normal ") + "|" + (r.R - r.L) + "x" + (r.B - r.T) + "|pid " + pid + "|" + sb.ToString());
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
[Z]::All() | Select-Object -First 25

