'use strict';
// Testa o guardião de verdade, com o app rodando:
//   A) o processo principal morre            -> tem que ser reaberto e voltar a tocar
//   B) o processo principal trava (suspenso)  -> sem sinal de vida, tem que ser encerrado e reaberto
//   C) saída de propósito (quit.flag)         -> NÃO pode ser reaberto, e o guardião tem que encerrar
//
//   node tools/test-guardian.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { run, Media } = require('../src/main/media');
const { DEFAULTS } = require('../src/main/config');

const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'giroplay-guardiao-'));
const dados = path.join(work, 'dados');
const drive = path.join(work, 'drive');
const ffmpeg = new Media(() => DEFAULTS).ffmpeg;
const results = [];

function ps(command) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true });
}

// Processos desta execução de teste, achados pela linha de comando
function procs() {
  // O próprio PowerShell que faz a consulta tem a pasta na linha de comando: precisa ficar de fora.
  const json = ps(`$k='${dados.replace(/'/g, "''")}'; Get-CimInstance Win32_Process | Where-Object { $_.Name -ne 'powershell.exe' -and $_.CommandLine -and $_.CommandLine.Contains($k) } | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress`);
  if (!json.trim()) return [];
  const parsed = JSON.parse(json);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({ pid: p.ProcessId, cmd: p.CommandLine }));
}
const findMain = () => procs().find((p) => !p.cmd.includes('--type=') && !p.cmd.includes('guardian.js'));
const findGuardian = () => procs().find((p) => p.cmd.includes('guardian.js'));

function logText() {
  const dir = path.join(dados, 'logs');
  try { return fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n'); } catch { return ''; }
}
const count = (re) => (logText().match(re) || []).length;

async function waitUntil(cond, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(500);
  }
  console.log(`  (tempo esgotado esperando: ${label})`);
  return false;
}

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK   ' : 'FALHA'} ${name}${detail ? ` - ${detail}` : ''}`);
}

function killMainOnly(pid) {
  execFileSync('taskkill.exe', ['/PID', String(pid), '/F'], { windowsHide: true, stdio: 'ignore' }); // sem /T: o guardião sobrevive, como numa queda de verdade
}

function suspend(pid) {
  ps(`Add-Type -Name N -Namespace W -MemberDefinition '[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h);'; [W.N]::NtSuspendProcess((Get-Process -Id ${pid}).Handle) | Out-Null`);
}

function cleanup() {
  for (const p of procs()) { try { execFileSync('taskkill.exe', ['/PID', String(p.pid), '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* já saiu */ } }
}

(async () => {
  fs.mkdirSync(drive, { recursive: true });
  const clip = await run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(drive, 'a.mp4')]);
  if (clip.code !== 0) throw new Error(clip.stderr);

  const electronExe = require('electron');
  const argv = [root, `--giro-data=${dados}`, `--watch=${drive}`, '--windowed=480x270+700+40',
    '--cfg=stableSeconds=1', '--cfg=scanIntervalSec=0.5', '--cfg=statusToDrive=false'];
  const child = spawn(electronExe, argv, { stdio: 'ignore', env: { ...process.env, GIRO_FROZEN_MS: '15000' } });
  child.unref();

  const started = await waitUntil(() => count(/tocando:/g) >= 1 && findGuardian() && findMain(), 90000, 'app e guardião no ar');
  record('app abre, toca e sobe o guardião', started);
  if (!started) { cleanup(); process.exit(2); }

  // A) queda do processo principal
  await sleep(22000); // passa da janela de "cai logo ao abrir" do guardião
  const startsBeforeA = count(/GiroPlay .* iniciando/g);
  const mainA = findMain();
  killMainOnly(mainA.pid);
  const tA = Date.now();
  const reopened = await waitUntil(() => count(/GiroPlay .* iniciando/g) > startsBeforeA, 30000, 'reabrir depois da queda');
  const playedA = reopened && await waitUntil(() => count(/tocando:/g) >= 2 && findMain() && findMain().pid !== mainA.pid, 40000, 'voltar a tocar');
  record('A) queda do processo: reabre e volta a tocar', Boolean(playedA), reopened ? `reaberto em ${((Date.now() - tA) / 1000).toFixed(1)} s` : 'não reabriu');

  // B) travamento: processo suspenso, heartbeat para de ser gravado
  await sleep(22000);
  const startsBeforeB = count(/GiroPlay .* iniciando/g);
  const mainB = findMain();
  suspend(mainB.pid);
  const tB = Date.now();
  const reopenedB = await waitUntil(() => count(/GiroPlay .* iniciando/g) > startsBeforeB, 60000, 'reabrir depois do travamento');
  const mainB2 = findMain();
  record('B) travamento (sem sinal de vida): encerra e reabre', Boolean(reopenedB && mainB2 && mainB2.pid !== mainB.pid),
    reopenedB ? `reaberto em ${((Date.now() - tB) / 1000).toFixed(1)} s (limite do teste: 15 s sem sinal)` : 'não reabriu');

  // C) saída de propósito
  await sleep(22000);
  const startsBeforeC = count(/GiroPlay .* iniciando/g);
  const mainC = findMain();
  fs.writeFileSync(path.join(dados, 'quit.flag'), String(Date.now())); // é o que o menu "Sair" faz
  killMainOnly(mainC.pid);
  await sleep(12000);
  const noRelaunch = count(/GiroPlay .* iniciando/g) === startsBeforeC && !findMain();
  const guardianGone = await waitUntil(() => !findGuardian(), 8000, 'guardião encerrar');
  record('C) saída de propósito: não reabre e o guardião encerra', noRelaunch && guardianGone);

  cleanup();
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed} cenário(s) falharam. Log: ${path.join(dados, 'logs')}` : '\nGuardião: todos os cenários passaram.');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
