'use strict';
// Guardião: processo pequeno que vigia o GiroPlay e o reabre se ele morrer ou travar.
// Roda com o próprio executável do Electron em modo Node (ELECTRON_RUN_AS_NODE=1).
//
//   uso: guardian.js <pid> <pasta-de-dados> <executável> [argumentos do app...]
//
// - Se o app fechar de propósito (menu Sair), ele deixa o arquivo quit.flag e o guardião encerra.
// - Se o processo sumir sem quit.flag (queda, falta de memória, "Finalizar tarefa"), reabre o app.
// - O app grava a hora em "heartbeat" a cada 5 s. Se ficar mais de 90 s sem atualizar, o processo
//   está travado: o guardião o encerra e reabre.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const [, , pidArg, dataDir, exe, ...appArgs] = process.argv;
const pid = Number(pidArg);
const quitFlag = path.join(dataDir, 'quit.flag');
const heartbeat = path.join(dataDir, 'heartbeat');
const startedAt = Date.now();
const FROZEN_AFTER_MS = Number(process.env.GIRO_FROZEN_MS) || 90e3; // a variável existe só para os testes
const CRASH_LOOP_MS = 20e3;

const alive = (p) => {
  try {
    process.kill(p, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

const note = (text) => {
  try {
    fs.appendFileSync(path.join(dataDir, 'logs', 'guardiao.log'), `${new Date().toISOString()} ${text}\n`);
  } catch { /* ignora */ }
};

function relaunch() {
  // Se o app morre logo depois de abrir, não fica reabrindo em disparada.
  const delay = Date.now() - startedAt < CRASH_LOOP_MS ? 15000 : 2000;
  note(`reabrindo o GiroPlay em ${delay / 1000} s`);
  setTimeout(() => {
    // O guardião roda com ELECTRON_RUN_AS_NODE; o app reaberto precisa rodar como app, não como Node.
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(exe, appArgs, { detached: true, stdio: 'ignore', env });
    child.unref();
    process.exit(0);
  }, delay);
}

const timer = setInterval(() => {
  if (!alive(pid)) {
    clearInterval(timer);
    if (fs.existsSync(quitFlag)) {
      note('GiroPlay fechado de propósito; guardião encerrando');
      process.exit(0);
    }
    note(`GiroPlay (pid ${pid}) não está mais rodando sem pedido de saída`);
    relaunch();
    return;
  }
  let lastBeat = startedAt;
  try {
    lastBeat = Math.max(lastBeat, fs.statSync(heartbeat).mtimeMs);
  } catch { /* ainda não gravou */ }
  if (Date.now() - lastBeat > FROZEN_AFTER_MS) {
    note(`GiroPlay (pid ${pid}) sem sinal de vida há ${Math.round((Date.now() - lastBeat) / 1000)} s; encerrando para reabrir`);
    try { process.kill(pid, 'SIGKILL'); } catch { /* o próximo ciclo trata */ }
  }
}, 3000);
