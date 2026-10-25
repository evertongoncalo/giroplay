'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');

const pad = (n) => String(n).padStart(2, '0');

// Data/hora no fuso do PC do painel, no formato "2026-10-25 14:03:22".
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
const naturalCompare = (a, b) => collator.compare(a, b);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function shortId(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 10);
}

// Nome de arquivo seguro para a biblioteca local (sem extensão, sem acentos, sem símbolos).
function safeName(fileName) {
  const base = fileName.replace(/\.[^.]+$/, '').normalize('NFKD');
  const clean = base.replace(/[^\w\-. ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60);
  return clean || 'video';
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Escreve em arquivo temporário e renomeia: um corte de energia nunca deixa o JSON pela metade.
function atomicWriteJson(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
    fs.rmSync(tmp, { force: true });
  }
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return m ? `${m} min ${pad(s % 60)} s` : `${s} s`;
}

module.exports = { stamp, dayKey, monthKey, naturalCompare, sleep, shortId, safeName, readJson, atomicWriteJson, fmtDuration };
