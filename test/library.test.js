'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Library } = require('../src/main/library');
const { tmpDir, silentLog } = require('./helpers');

function entry(name, extra = {}) {
  return { id: `id_${name}`, key: name.toLowerCase(), sourceRel: name, sig: '1-1', name, file: `${name}.mp4`, duration: 10, ...extra };
}

function makeLib() {
  const dir = tmpDir();
  return { dir, lib: new Library(dir, silentLog) };
}

function touch(lib, e) {
  fs.writeFileSync(path.join(lib.dir, e.file), 'x');
}

test('vídeo novo entra sempre no fim do ciclo', () => {
  const { lib } = makeLib();
  lib.addReady(entry('a'));
  lib.addReady(entry('b'));
  lib.addReady(entry('c'));
  assert.deepEqual(lib.ready().map((e) => e.name), ['a', 'b', 'c']);
  lib.addReady(entry('d'));
  assert.deepEqual(lib.ready().map((e) => e.name), ['a', 'b', 'c', 'd']);
});

test('next percorre o ciclo e volta ao início', () => {
  const { lib } = makeLib();
  ['a', 'b', 'c'].forEach((n) => lib.addReady(entry(n)));
  assert.equal(lib.next(null).name, 'a');
  assert.equal(lib.next('id_a').name, 'b');
  assert.equal(lib.next('id_c').name, 'a');
});

test('vídeo adicionado enquanto o último toca vira o próximo, não o primeiro', () => {
  const { lib } = makeLib();
  ['a', 'b'].forEach((n) => lib.addReady(entry(n)));
  assert.equal(lib.next('id_b').name, 'a'); // sem novidade, volta ao início
  lib.addReady(entry('novo'));
  assert.equal(lib.next('id_b').name, 'novo');
  assert.equal(lib.next('id_novo').name, 'a');
});

test('com um único vídeo ele repete', () => {
  const { lib } = makeLib();
  lib.addReady(entry('a'));
  assert.equal(lib.next('id_a').name, 'a');
});

test('lista vazia devolve null', () => {
  const { lib } = makeLib();
  assert.equal(lib.next(null), null);
  assert.equal(lib.next('qualquer'), null);
});

test('versão nova do mesmo arquivo herda a posição e a antiga sai', () => {
  const { lib } = makeLib();
  ['a', 'b', 'c'].forEach((n) => lib.addReady(entry(n)));
  lib.addReady(entry('b', { id: 'id_b2', sig: '2-2', file: 'b2.mp4' }));
  assert.deepEqual(lib.ready().map((e) => e.id), ['id_a', 'id_b2', 'id_c']);
  assert.equal(lib.data.entries.id_b.status, 'retired');
});

test('arquivo de vídeo em uso só é apagado depois que sai de uso', () => {
  const { lib } = makeLib();
  const a = lib.addReady(entry('a'));
  const b = lib.addReady(entry('b'));
  touch(lib, a);
  touch(lib, b);
  lib.setInUse(['id_a']);
  lib.retire('id_a', 'teste');
  lib.cleanup();
  assert.ok(fs.existsSync(path.join(lib.dir, 'a.mp4')), 'ainda está tocando: não pode apagar');
  lib.setInUse([]);
  lib.cleanup();
  assert.ok(!fs.existsSync(path.join(lib.dir, 'a.mp4')), 'ninguém usa mais: apaga');
  assert.ok(fs.existsSync(path.join(lib.dir, 'b.mp4')), 'quem está no ciclo fica');
});

test('quarentena tira do ciclo e evita reprocessar o mesmo arquivo', () => {
  const { lib } = makeLib();
  lib.addReady(entry('a'));
  lib.addReady(entry('b'));
  lib.quarantine('id_a', 'não decodifica');
  assert.deepEqual(lib.ready().map((e) => e.name), ['b']);
  assert.ok(lib.isHandled('a', '1-1'), 'mesma assinatura: já tratado');
  assert.ok(!lib.isHandled('a', '9-9'), 'arquivo reenviado (assinatura nova) é reavaliado');
  assert.equal(lib.next('id_a').name, 'b', 'o ciclo continua a partir do vídeo quarentenado');
});

test('manifest sobrevive a reiniciar o app', () => {
  const { dir, lib } = makeLib();
  lib.addReady(entry('a'));
  lib.addReady(entry('b'));
  const again = new Library(dir, silentLog);
  assert.deepEqual(again.ready().map((e) => e.name), ['a', 'b']);
  again.addReady(entry('c'));
  assert.deepEqual(again.ready().map((e) => e.name), ['a', 'b', 'c']);
});
