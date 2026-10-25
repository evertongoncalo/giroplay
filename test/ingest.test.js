'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeClip, makeEnv, waitFor, media } = require('./helpers');
const { sleep } = require('../src/main/util');

const names = (env) => env.library.ready().map((e) => e.sourceRel);

test('vídeo H.264 comum é copiado como está e entra no ciclo', async () => {
  const env = makeEnv();
  try {
    await makeClip(path.join(env.watch, 'oferta.mp4'));
    env.ingest.start();
    assert.ok(await waitFor(() => names(env).length === 1), 'deveria entrar no ciclo');
    const e = env.library.ready()[0];
    assert.equal(e.via, 'copy');
    assert.ok(fs.existsSync(env.library.filePath(e)));
  } finally { env.cleanup(); }
});

test('WebM/VP9 é convertido para H.264', async () => {
  const env = makeEnv();
  try {
    await makeClip(path.join(env.watch, 'estranho.webm'), { codec: 'libvpx-vp9', extra: ['-b:v', '300k'] });
    env.ingest.start();
    assert.ok(await waitFor(() => names(env).length === 1, 60000), 'deveria entrar no ciclo');
    const e = env.library.ready()[0];
    assert.equal(e.via, 'transcode');
    const info = await media.probe(env.library.filePath(e));
    assert.equal(info.codec, 'h264');
    assert.equal(info.pixFmt, 'yuv420p');
  } finally { env.cleanup(); }
});

test('vídeo 4K é reduzido para caber em 1920x1080', async () => {
  const env = makeEnv();
  try {
    await makeClip(path.join(env.watch, 'gigante.mp4'), { size: '3840x2160', seconds: 1, extra: ['-preset', 'ultrafast'] });
    env.ingest.start();
    assert.ok(await waitFor(() => names(env).length === 1, 90000), 'deveria entrar no ciclo');
    const e = env.library.ready()[0];
    assert.equal(e.via, 'transcode');
    assert.equal(e.width, 1920);
    assert.equal(e.height, 1080);
  } finally { env.cleanup(); }
});

test('arquivo cortado ao meio é recusado, nunca entra no ciclo', async () => {
  const env = makeEnv();
  try {
    const whole = path.join(env.root, 'inteiro.mp4');
    await makeClip(whole, { seconds: 4 });
    const bytes = fs.readFileSync(whole);
    fs.writeFileSync(path.join(env.watch, 'cortado.mp4'), bytes.subarray(0, Math.floor(bytes.length * 0.4)));
    env.ingest.start();
    assert.ok(await waitFor(() => env.library.rejectedList().length === 1, 30000), 'deveria ser recusado');
    assert.equal(names(env).length, 0);
    assert.match(env.library.rejectedList()[0].reason, /./);
  } finally { env.cleanup(); }
});

test('arquivo que não é vídeo (texto com extensão .mp4) é recusado', async () => {
  const env = makeEnv();
  try {
    fs.writeFileSync(path.join(env.watch, 'falso.mp4'), 'isto não é um vídeo '.repeat(500));
    env.ingest.start();
    assert.ok(await waitFor(() => env.library.rejectedList().length === 1, 30000));
    assert.equal(names(env).length, 0);
  } finally { env.cleanup(); }
});

test('upload lento: enquanto o arquivo ainda está chegando, nada entra no ciclo', async () => {
  const env = makeEnv({ stableSeconds: 1.5 });
  try {
    const src = path.join(env.root, 'origem.mp4');
    await makeClip(src, { seconds: 3, size: '640x480', extra: ['-b:v', '2M'] });
    const bytes = fs.readFileSync(src);
    assert.ok(bytes.length > 200000, 'o vídeo de teste precisa ser grande o bastante para chegar em pedaços');
    env.ingest.start();

    const dest = path.join(env.watch, 'chegando.mp4');
    const fd = fs.openSync(dest, 'w');
    const chunk = 20000;
    const enteredEarly = [];
    for (let off = 0; off < bytes.length; off += chunk) {
      fs.writeSync(fd, bytes, off, Math.min(chunk, bytes.length - off));
      await sleep(120);
      if (env.library.ready().length || env.ingest.cur) enteredEarly.push(off);
    }
    fs.closeSync(fd);
    assert.deepEqual(enteredEarly, [], 'o porteiro pegou o arquivo antes dele terminar de chegar');

    assert.ok(await waitFor(() => names(env).length === 1, 30000), 'depois de completo, deveria entrar');
    const e = env.library.ready()[0];
    const info = await media.probe(env.library.filePath(e));
    assert.ok(Math.abs(info.duration - 3) < 0.3);
    assert.equal(fs.statSync(env.library.filePath(e)).size, bytes.length, 'cópia idêntica ao original');
  } finally { env.cleanup(); }
});

test('vídeos novos entram no fim, na ordem em que ficam prontos', async () => {
  const env = makeEnv();
  try {
    await makeClip(path.join(env.watch, '10-b.mp4'));
    await makeClip(path.join(env.watch, '02-a.mp4'));
    env.ingest.start();
    assert.ok(await waitFor(() => names(env).length === 2));
    assert.deepEqual(names(env), ['02-a.mp4', '10-b.mp4'], 'primeira carga segue a ordem natural do nome');
    await makeClip(path.join(env.watch, '01-novo.mp4'));
    assert.ok(await waitFor(() => names(env).length === 3));
    assert.deepEqual(names(env), ['02-a.mp4', '10-b.mp4', '01-novo.mp4'], 'o novo vai pro fim, mesmo com nome "menor"');
  } finally { env.cleanup(); }
});

test('apagar da pasta tira do ciclo (depois da tolerância) e libera o arquivo local', async () => {
  const env = makeEnv();
  try {
    await makeClip(path.join(env.watch, 'a.mp4'));
    await makeClip(path.join(env.watch, 'b.mp4'));
    env.ingest.start();
    assert.ok(await waitFor(() => names(env).length === 2));
    const removedFile = path.join(env.libDir, env.library.ready().find((e) => e.sourceRel === 'a.mp4').file);
    assert.ok(fs.existsSync(removedFile));
    fs.rmSync(path.join(env.watch, 'a.mp4'));
    assert.ok(await waitFor(() => names(env).length === 1, 15000), 'a.mp4 deveria sair do ciclo');
    assert.deepEqual(names(env), ['b.mp4']);
    env.library.cleanup();
    assert.ok(!fs.existsSync(removedFile), 'arquivo local apagado');
  } finally { env.cleanup(); }
});

test('pasta do Drive inacessível NÃO esvazia o ciclo', async () => {
  const env = makeEnv();
  try {
    await makeClip(path.join(env.watch, 'a.mp4'));
    env.ingest.start();
    assert.ok(await waitFor(() => names(env).length === 1));
    const away = `${env.watch}_sumiu`;
    fs.renameSync(env.watch, away);
    await sleep(3000); // muito mais que missingGraceSec
    assert.equal(env.ingest.getState().folderOk, false);
    assert.deepEqual(names(env), ['a.mp4'], 'sem acesso à pasta não dá para concluir que o vídeo foi apagado');
    fs.renameSync(away, env.watch);
    await sleep(1500);
    assert.deepEqual(names(env), ['a.mp4']);
    assert.equal(env.ingest.getState().folderOk, true);
  } finally { env.cleanup(); }
});

test('se TODOS os vídeos somem de uma vez, espera mais antes de esvaziar', async () => {
  const env = makeEnv({ wipeGuardSec: 3600 });
  try {
    await makeClip(path.join(env.watch, 'a.mp4'));
    await makeClip(path.join(env.watch, 'b.mp4'));
    env.ingest.start();
    assert.ok(await waitFor(() => names(env).length === 2));
    fs.rmSync(path.join(env.watch, 'a.mp4'));
    fs.rmSync(path.join(env.watch, 'b.mp4'));
    await sleep(3000);
    assert.equal(names(env).length, 2, 'pasta "vazia" de repente: não confia, mantém o ciclo');
  } finally { env.cleanup(); }
});

test('arquivo substituído (mesmo nome) é reprocessado e mantém a posição', async () => {
  const env = makeEnv();
  try {
    await makeClip(path.join(env.watch, 'a.mp4'), { seconds: 2 });
    await makeClip(path.join(env.watch, 'b.mp4'), { seconds: 2 });
    env.ingest.start();
    assert.ok(await waitFor(() => names(env).length === 2));
    const before = env.library.ready().find((e) => e.sourceRel === 'a.mp4');
    await makeClip(path.join(env.watch, 'a.mp4'), { seconds: 3 });
    assert.ok(await waitFor(() => env.library.ready().find((e) => e.sourceRel === 'a.mp4')?.id !== before.id, 20000));
    assert.deepEqual(names(env), ['a.mp4', 'b.mp4'], 'continua na primeira posição');
    assert.ok(Math.abs(env.library.ready()[0].duration - 3) < 0.3);
  } finally { env.cleanup(); }
});

test('arquivos temporários e a pasta _giroplay são ignorados', async () => {
  const env = makeEnv();
  try {
    fs.mkdirSync(path.join(env.watch, '_giroplay'));
    await makeClip(path.join(env.watch, '_giroplay', 'x.mp4'));
    await makeClip(path.join(env.watch, '.tmp.driveupload.mp4'));
    await makeClip(path.join(env.watch, 'real.mp4'));
    env.ingest.start();
    assert.ok(await waitFor(() => names(env).length === 1));
    await sleep(2500);
    assert.deepEqual(names(env), ['real.mp4']);
  } finally { env.cleanup(); }
});
