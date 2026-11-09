#!/usr/bin/env node
// Loreweaver sync: device token provisioning CLI (run on the hub).
//
// Usage:
//   node sync-token.js create <deviceName>   Create a device token and print it once
//   node sync-token.js list                  List registered devices
//   node sync-token.js revoke <deviceId>     Revoke a device
//
// The raw token is shown once and stored only as a SHA-256 hash in
// data/_sync/hub.json. It cannot be recovered later — copy it immediately.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';

import yaml from 'yaml';
import chalk from 'chalk';

// Minimal data-root resolution matching server.js: --dataRoot arg, else config.yaml.
const args = process.argv.slice(2);
const [command, nameArg] = args;

let dataRootArg = null;
const drIndex = args.indexOf('--dataRoot');
if (drIndex !== -1 && args[drIndex + 1]) {
    dataRootArg = args[drIndex + 1];
}

function resolveDataRoot() {
    if (dataRootArg) {
        return path.resolve(dataRootArg);
    }
    try {
        const config = yaml.parse(fs.readFileSync('./config.yaml', 'utf8'));
        const root = config?.dataRoot ?? './data';
        return path.resolve(String(root));
    } catch {
        return path.resolve('./data');
    }
}

const dataRoot = resolveDataRoot();
const hubFile = path.join(dataRoot, '_sync', 'hub.json');

function loadRegistry() {
    try {
        const parsed = JSON.parse(fs.readFileSync(hubFile, 'utf-8'));
        if (parsed && typeof parsed.devices === 'object' && parsed.devices !== null) {
            return parsed;
        }
    } catch { /* missing or corrupt: start fresh */ }
    return { devices: {} };
}

function saveRegistry(registry) {
    fs.mkdirSync(path.dirname(hubFile), { recursive: true });
    const tmp = path.join(path.dirname(hubFile), `.hub.json.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(registry, null, 4), 'utf-8');
    fs.renameSync(tmp, hubFile);
}

function sha256Hex(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function printHelp() {
    console.log('Loreweaver sync token manager (run on the hub).');
    console.log('');
    console.log('Usage:');
    console.log('  node sync-token.js create <deviceName>   Create a device token, print it once');
    console.log('  node sync-token.js list                  List registered devices');
    console.log('  node sync-token.js revoke <deviceId>     Revoke a device');
    console.log('');
    console.log('Options:');
    console.log('  --dataRoot <path>   Override the data root (default: from config.yaml or ./data)');
}

if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    process.exit(0);
}

if (command === 'create') {
    if (!nameArg || nameArg.startsWith('--')) {
        console.error(chalk.red('Usage: node sync-token.js create <deviceName>'));
        process.exit(1);
    }
    const registry = loadRegistry();
    const deviceId = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('hex');
    registry.devices[deviceId] = {
        name: nameArg.slice(0, 100),
        tokenHash: sha256Hex(token),
        created: Date.now(),
        lastSeen: 0,
    };
    saveRegistry(registry);
    console.log(chalk.green('Device created.'));
    console.log('');
    console.log(`  deviceId: ${deviceId}`);
    console.log(`  name:     ${nameArg}`);
    console.log('');
    console.log(chalk.bold('Token (shown once — copy it now into the device config.yaml under sync.token):'));
    console.log('');
    console.log(chalk.cyan(token));
    console.log('');
    console.log('Store it only on the device; only its hash is kept here.');
    process.exit(0);
}

if (command === 'list') {
    const registry = loadRegistry();
    const devices = Object.entries(registry.devices);
    if (devices.length === 0) {
        console.log('No devices registered.');
        process.exit(0);
    }
    console.log('Registered devices:');
    for (const [deviceId, device] of devices) {
        const lastSeen = device.lastSeen ? new Date(device.lastSeen).toISOString() : 'never';
        console.log(`  ${deviceId}  ${device.name.padEnd(20)}  last seen: ${lastSeen}`);
    }
    process.exit(0);
}

if (command === 'revoke') {
    if (!nameArg) {
        console.error(chalk.red('Usage: node sync-token.js revoke <deviceId>'));
        process.exit(1);
    }
    const registry = loadRegistry();
    if (!(nameArg in registry.devices)) {
        console.error(chalk.red(`Unknown deviceId: ${nameArg}`));
        console.log('Run "node sync-token.js list" to see registered devices.');
        process.exit(1);
    }
    delete registry.devices[nameArg];
    saveRegistry(registry);
    console.log(chalk.green(`Device ${nameArg} revoked. Its token no longer authenticates.`));
    process.exit(0);
}

console.error(chalk.red(`Unknown command: ${command}`));
printHelp();
process.exit(1);
