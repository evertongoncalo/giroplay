# Diz qual janela está de fato visível no centro da tela (a que o usuário enxerga e clica).
# Com -Bottom, olha a faixa de baixo da tela (onde fica a barra de tarefas do Windows): se aparecer a
# barra, o título vem vazio e o processo é "explorer".
# Saída: "<título>|<processo>". Usado por tools/test-fluxo.js para provar que as configurações
# não ficam escondidas atrás do painel e que o painel cobre a tela inteira.
param([switch]$Bottom)
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class TopWin {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$pt = New-Object TopWin+POINT
$pt.X = [int]($b.X + $b.Width / 2)
$pt.Y = if ($Bottom) { [int]($b.Y + $b.Height - 20) } else { [int]($b.Y + $b.Height / 2) }
$h = [TopWin]::GetAncestor([TopWin]::WindowFromPoint($pt), 2)
$sb = New-Object System.Text.StringBuilder 256
[void][TopWin]::GetWindowText($h, $sb, 256)
$procId = [uint32]0
[void][TopWin]::GetWindowThreadProcessId($h, [ref]$procId)
$name = try { (Get-Process -Id $procId).ProcessName } catch { '?' }
"$($sb.ToString())|$name"
