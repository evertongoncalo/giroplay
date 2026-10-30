'use strict';
// Teste de ponta a ponta do FLUXO que travou o primeiro uso: abrir, configurar, iniciar, sair.
// Roda o app de verdade, em tela cheia, e pergunta ao Windows qual janela está visível no centro da
// tela (WindowFromPoint). Cobre a tela por alguns segundos em cada cenário; tudo encerra sozinho.
//
//   node tools/test-fluxo.js              todos os cenários
//   node tools/test-fluxo.js --only=2,5   só alguns
//   node tools/test-fluxo.js --exe=dist/win-unpacked/GiroPlay.exe   testa o app empacotado
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { run, Media } = require('../src/main/media');
const { DEFAULTS } = require('../src/main/config');

const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ffmpeg = new Media(() => DEFAULTS).ffmpeg;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'giroplay-fluxo-'));
const drive = path.join(work, 'drive');
const only = ((process.argv.find((a) => a.startsWith('--only=')) || '').slice(7)).split(',').filter(Boolean).map(Number);
const want = (n) => !only.length || only.includes(n);
const exeArg = ((process.argv.find((a) => a.startsWith('--exe=')) || '').slice(6));
let failed = 0;
let seq = 0;

const check = (name, ok, detail) => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'OK   ' : 'FALHA'} ${name}${detail ? ` - ${detail}` : ''}`);
};

const ps = (file, ...args) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, file), ...args], { encoding: 'utf8', windowsHide: true });

// Título e processo da janela visível no centro da tela (ou, com bottom, na faixa de baixo, onde fica a barra do Windows)
function topWindow(bottom = false) {
  const [title, proc] = ps('topwindow.ps1', ...(bottom ? ['-Bottom'] : [])).trim().split('|');
  return { title, proc };
}

// Pilha de janelas do Windows (de cima para baixo), para diagnóstico quando algo falha
const windowStack = () => ps('windows-stack.ps1').split('\n').slice(0, 6).map((l) => `      ${l.trim()}`).join('\n');

function procsOf(dados) {
  const k = dados.replace(/'/g, "''");
  const json = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$k='${k}'; Get-CimInstance Win32_Process | Where-Object { $_.Name -ne 'powershell.exe' -and $_.CommandLine -and $_.CommandLine.Contains($k) } | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress`],
  { encoding: 'utf8', windowsHide: true }).trim();
  if (!json) return [];
  const parsed = JSON.parse(json);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({ pid: p.ProcessId, cmd: p.CommandLine }));
}

function killAll(dados) {
  for (const p of procsOf(dados)) { try { execFileSync('taskkill.exe', ['/PID', String(p.pid), '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* já saiu */ } }
}

// Abre o app com dados novos (primeiro uso de verdade)
function launch(extra, { guardian = false, dados = path.join(work, `dados${++seq}`) } = {}) {
  const args = [root, `--giro-data=${dados}`, `--watch=${drive}`, ...(guardian ? [] : ['--no-guardian']),
    '--cfg=stableSeconds=1', '--cfg=scanIntervalSec=0.5', '--cfg=statusToDrive=false', ...extra];
  // --exe=CAMINHO testa o app empacotado (o mesmo que o instalador coloca no PC) em vez do código-fonte
  const child = exeArg ? spawn(exeArg, args.slice(1), { stdio: 'ignore' }) : spawn(require('electron'), args, { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const log = () => {
    const dir = path.join(dados, 'logs');
    try { return fs.readdirSync(dir).filter((f) => f.startsWith('giroplay-')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n'); } catch { return ''; }
  };
  return { child, dados, exited, log };
}

async function waitLog(app, re, count = 1, timeoutMs = 40000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((app.log().match(re) || []).length >= count) return true;
    await sleep(150);
  }
  return false;
}
const lastDump = (app) => (app.log().match(/\[teste\] estado: .*/g) || []).pop() || '';
const short = (dump) => dump.replace(/.*estado: /, '');

const scenarios = {
  // ---------- 1. primeiro uso: abre SÓ nas configurações, sem cobrir a tela ----------
  1: async () => {
    console.log('1) Primeiro uso (sem configuração salva)');
    const app = launch(['--test-script=7:dump', '--exit-after=16']);
    await waitLog(app, /\[teste\] estado/);
    const top = topWindow();
    check('as configurações são a janela visível na tela', /configura/i.test(top.title), `visível: "${top.title}" (${top.proc})`);
    check('o painel NÃO foi aberto em tela cheia', /playing=false \| painel=nao/.test(lastDump(app)), short(lastDump(app)));
    check('nenhum vídeo começou a tocar sem o ▶ Iniciar', !/tocando:/.test(app.log()));
    await app.exited;
    killAll(app.dados);
  },

  // ---------- 2. ▶ Iniciar, Esc, C ----------
  2: async () => {
    console.log('2) ▶ Iniciar -> tela cheia -> Esc (menu) -> C (configurações por cima do painel)');
    // exit-after folgado: cada medição do PowerShell leva 2 a 3 s, e o app precisa estar vivo até a última.
    const app = launch(['--test-script=5:play,9:dump,10:shot-player,12:esc,13:shot-player,15:c,16:dump,17:shot-settings', '--exit-after=45']);
    await waitLog(app, /\[teste\] estado/, 1);
    let top = topWindow();
    const d1 = lastDump(app);
    check('depois do ▶ Iniciar o painel está em tela cheia e por cima', /playing=true \| painel=sim tela-cheia=true no-topo=true visivel=true/.test(d1), short(d1));
    check('a janela visível no centro é o painel', top.title === 'GiroPlay', `visível: "${top.title}"`);
    const bottom = topWindow(true);
    check('a barra de tarefas do Windows NÃO aparece (na faixa de baixo da tela a janela visível é o painel)', bottom.title === 'GiroPlay', `visível embaixo: "${bottom.title}" (${bottom.proc})`);
    if (bottom.title !== 'GiroPlay') console.log(`    pilha de janelas do Windows (de cima para baixo):\n${windowStack()}`);
    check('as configurações ficaram escondidas', /config=sim visivel=false/.test(d1));
    check('o vídeo está tocando', /tocando:/.test(app.log()));
    check('o Esc abre o menu de saída', await waitLog(app, /menu de saída aberto/, 1, 10000));
    await waitLog(app, /\[teste\] estado/, 2, 12000);
    const d2 = lastDump(app);
    check('com C, as configurações ficam POR CIMA do painel', /config=sim visivel=true no-topo=true/.test(d2) && /no-topo=false visivel=true/.test(d2), short(d2));
    // Três medições seguidas: todas precisam mostrar as configurações na frente, com o app ainda vivo.
    const seen = [];
    for (let i = 0; i < 3; i++) {
      const alive = app.child.exitCode === null;
      seen.push(alive ? topWindow().title : '(o app já tinha encerrado)');
    }
    const ok = seen.every((t) => /configura/i.test(t));
    check('a janela visível no centro agora são as configurações (3 medições)', ok, seen.map((t) => `"${t}"`).join(', '));
    if (!ok) console.log(`    pilha de janelas do Windows (de cima para baixo):\n${windowStack()}\n    estado do app agora: ${short(lastDump(app))}`);
    await app.exited;
    killAll(app.dados);
  },

  // ---------- 3. Esc, Esc sai de verdade (com guardião ligado) ----------
  3: async () => {
    console.log('3) Esc, Esc fecha o app de verdade e o guardião não o reabre');
    const app = launch(['--play', '--test-script=7:esc,9:esc', '--exit-after=40'], { guardian: true });
    await waitLog(app, /tocando:/, 1, 40000);
    const exitCode = await Promise.race([app.exited, sleep(25000).then(() => 'tempo')]);
    check('o app encerrou depois do segundo Esc', exitCode === 0, `código de saída: ${exitCode}`);
    check('registrou a saída pelo menu', /saída pelo menu do painel/.test(app.log()));
    await sleep(9000);
    check('o guardião NÃO reabriu o app', (app.log().match(/GiroPlay .* iniciando/g) || []).length === 1 && procsOf(app.dados).filter((p) => !p.cmd.includes('guardian.js')).length === 0);
    check('o guardião encerrou junto', procsOf(app.dados).length === 0);
    killAll(app.dados);
  },

  // ---------- 4. Alt+F4 abre o menu em vez de fechar de repente ----------
  4: async () => {
    console.log('4) Alt+F4 abre o menu de saída (e não derruba o painel)');
    const app = launch(['--play', '--test-script=7:altf4,9:esc', '--exit-after=30']);
    await waitLog(app, /tocando:/, 1, 40000);
    check('Alt+F4 abriu o menu', await waitLog(app, /menu de saída aberto/, 1, 15000));
    const code = await Promise.race([app.exited, sleep(15000).then(() => 'tempo')]);
    check('o Esc seguinte encerrou o app', code === 0, `código de saída: ${code}`);
    killAll(app.dados);
  },

  // ---------- 5. P para a exibição e volta às configurações ----------
  5: async () => {
    console.log('5) Esc, P para a exibição e volta às configurações');
    const app = launch(['--play', '--test-script=7:esc,8:p,10:dump', '--exit-after=16']);
    await waitLog(app, /\[teste\] estado/, 1, 40000);
    const top = topWindow();
    const d = lastDump(app);
    check('a exibição parou e o painel foi fechado', /playing=false \| painel=nao/.test(d), short(d));
    check('as configurações estão visíveis', /config=sim visivel=true/.test(d) && /configura/i.test(top.title), `visível: "${top.title}"`);
    await app.exited;
    killAll(app.dados);
  },

  // ---------- 6. o guardião reabre já exibindo; "iniciar sozinho" também ----------
  6: async () => {
    console.log('6) Retomar depois de uma queda e "iniciar sozinho"');
    const dadosR = path.join(work, 'dados-retomar');
    fs.mkdirSync(dadosR, { recursive: true });
    fs.writeFileSync(path.join(dadosR, 'estado.json'), JSON.stringify({ playing: true }));
    let app = launch(['--retomar', '--exit-after=12'], { dados: dadosR });
    await waitLog(app, /exibição iniciada/, 1, 15000);
    check('--retomar com a exibição ligada antes da queda: já começa exibindo', /exibição iniciada/.test(app.log()));
    await app.exited;
    killAll(dadosR);

    app = launch(['--cfg=autoStart=true', '--exit-after=12']);
    await waitLog(app, /exibição iniciada/, 1, 15000);
    check('"iniciar sozinho" ligado: começa exibindo sem clique', /exibição iniciada/.test(app.log()));
    await app.exited;
    killAll(app.dados);
  },

  // ---------- 7. o caso real do usuário: reproduzindo vídeo, app preso, Esc Esc ----------
  7: async () => {
    console.log('7) Reproduzindo vídeo com o app "preso" (achando que já está saindo): Esc, Esc tem que sair mesmo assim');
    const t0 = Date.now();
    const app = launch(['--play', '--test-script=6:zumbi,8:esc,10:esc', '--exit-after=45']);
    await waitLog(app, /tocando:/, 1, 40000);
    const code = await Promise.race([app.exited, sleep(35000).then(() => 'tempo')]);
    const secs = (Date.now() - t0) / 1000;
    check('o app saiu sozinho (não só pelo limite de segurança do teste)', code === 0 && secs < 30, `código ${code}, ${secs.toFixed(1)} s`);
    check('registrou a saída pelo menu', /saída pelo menu do painel/.test(app.log()));
    killAll(app.dados);
  },

  // ---------- 8. botão "Sair do GiroPlay" das configurações (dois cliques) ----------
  8: async () => {
    console.log('8) Botão "Sair do GiroPlay" das configurações (dois cliques, sem caixa do Windows)');
    const t0 = Date.now();
    const app = launch(['--test-script=6:settings-quit', '--exit-after=45']);
    const code = await Promise.race([app.exited, sleep(35000).then(() => 'tempo')]);
    const secs = (Date.now() - t0) / 1000;
    check('o app saiu sozinho', code === 0 && secs < 30, `código ${code}, ${secs.toFixed(1)} s`);
    check('registrou o pedido de saída', /saindo do GiroPlay/.test(app.log()));
    killAll(app.dados);
  },

  // ---------- 9. fechar a janela de configurações antes de iniciar encerra o app ----------
  9: async () => {
    console.log('9) Fechar a janela de configurações no X, antes de iniciar o painel, encerra o app');
    const t0 = Date.now();
    const app = launch(['--test-script=6:close-settings', '--exit-after=45']);
    const code = await Promise.race([app.exited, sleep(35000).then(() => 'tempo')]);
    const secs = (Date.now() - t0) / 1000;
    check('o app saiu sozinho', code === 0 && secs < 30, `código ${code}, ${secs.toFixed(1)} s`);
    killAll(app.dados);
  },
};

(async () => {
  fs.mkdirSync(drive, { recursive: true });
  for (const name of ['a.mp4', 'b.mp4']) {
    const r = await run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(drive, name)], { timeoutMs: 120000 });
    if (r.code !== 0) throw new Error(r.stderr);
  }
  for (const n of Object.keys(scenarios).map(Number)) if (want(n)) await scenarios[n]();
  console.log(failed ? `\n${failed} verificação(ões) falharam. Pasta: ${work}` : '\nFluxo de abrir/iniciar/sair: tudo certo.');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
