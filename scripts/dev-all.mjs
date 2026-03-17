#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [];
let stopping = false;
let exitCode = 0;

function isExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function killChild(entry, signal = 'SIGTERM') {
  const { child } = entry;
  if (!child.pid || isExited(child)) {
    return;
  }

  try {
    if (process.platform === 'win32') {
      child.kill(signal);
      return;
    }

    process.kill(-child.pid, signal);
  } catch {
    // Best-effort shutdown.
  }
}

function maybeExit() {
  if (children.every((entry) => isExited(entry.child))) {
    process.exit(exitCode);
  }
}

function stopAll(signal = 'SIGTERM', excludePid) {
  for (const entry of children) {
    if (entry.child.pid === excludePid) {
      continue;
    }
    killChild(entry, signal);
  }

  setTimeout(() => {
    for (const entry of children) {
      if (entry.child.pid === excludePid) {
        continue;
      }
      killChild(entry, 'SIGKILL');
    }
  }, 2000).unref();
}

function handleShutdown(signal) {
  if (stopping) {
    return;
  }

  stopping = true;
  exitCode = signal === 'SIGINT' ? 130 : 0;
  stopAll('SIGTERM');
}

function spawnRunner(name, args) {
  const child = spawn(npmCommand, args, {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  });

  const entry = { name, child };
  children.push(entry);

  child.on('error', (error) => {
    if (!stopping) {
      console.error(`[dev] Failed to start ${name}: ${error.message}`);
      stopping = true;
      exitCode = 1;
      stopAll('SIGTERM', child.pid);
    }
    maybeExit();
  });

  child.on('exit', (code, signal) => {
    if (!stopping) {
      if (code !== 0) {
        console.error(`[dev] ${name} exited with code ${code ?? 1}`);
      } else if (signal) {
        console.error(`[dev] ${name} exited with signal ${signal}`);
      }

      stopping = true;
      exitCode = code ?? (signal ? 1 : 0);
      stopAll('SIGTERM', child.pid);
    }

    maybeExit();
  });

  return child;
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

spawnRunner('backend', ['run', 'dev:server']);
spawnRunner('frontend', ['run', 'dev:web']);
