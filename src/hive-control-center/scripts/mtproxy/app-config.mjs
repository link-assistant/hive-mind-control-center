#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage: app-config.mjs <accounts-shared-data>');
  process.exit(2);
}

let config;
try {
  config = JSON.parse(readFileSync(path, 'utf8'));
} catch {
  console.log('status=unreadable');
  process.exit(0);
}

const proxy = config.proxy && typeof config.proxy === 'object' ? config.proxy : config;
const host = String(proxy.host ?? '');
const port = String(proxy.port ?? '');
const encoded = String(proxy.secret ?? '');
const raw = Buffer.from(encoded, 'base64');
const hex = raw.toString('hex');
const prefix = hex.slice(0, 2).toLowerCase();
const key = ['dd', 'ee'].includes(prefix) ? hex.slice(2) : hex;
const sha = key ? createHash('sha256').update(key).digest('hex') : '';

console.log('status=ok');
console.log(`host=${host}`);
console.log(`port=${port}`);
console.log(`prefix=${prefix}`);
console.log(`keylen=${key.length}`);
console.log(`sha=${sha}`);
