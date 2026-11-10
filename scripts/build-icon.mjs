#!/usr/bin/env node
// Generates build/icon.ico for electron-builder.
// Pipeline: scripts/build-icon.ps1 resizes Loreweaver.png into build/pngs
// (System.Drawing bicubic); this script assembles the .ico from those PNGs.
// Usage: node scripts/build-icon.mjs
// Requires: npm i -D png-to-ico
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pngToIco from 'png-to-ico';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pngDir = path.join(root, 'build', 'pngs');
const outDir = path.join(root, 'build');

// Windows .ico sizes. 256 is the largest electron-builder needs.
const sizes = [256, 128, 64, 48, 32, 24, 16];

const pngs = sizes.map((size) => {
    const file = path.join(pngDir, `icon_${size}.png`);
    console.log(`adding ${file}`);
    return fs.readFileSync(file);
});

fs.mkdirSync(outDir, { recursive: true });
const ico = await pngToIco(pngs);
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
console.log(`wrote ${path.join(outDir, 'icon.ico')} (${ico.length} bytes)`);
