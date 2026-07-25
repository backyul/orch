// Hermetic test preload. Wired via `node --test --import ./test/_setup.mjs` (see package.json).
//
// src/config.js resolves ORCH_DIR / PENDING_DIR / INBOX_DIR / STATE_FILE (and ORCH_ENV_FILE) from
// the environment into MODULE CONSTANTS at import time. When the suite is run in a shell where
// orc-gui.ps1 has exported ORCH_STATE_DIR=~/.claude/orchestrator-gui and ORCH_ENV_FILE=.env.gui
// (i.e. any shell that has ever launched the cockpit), every test that touches the real bus/store
// reads and writes the operator's LIVE cockpit store — leaving phantom `clitest_*`/`hooktest_*`
// workers and orphaned pending flags that the live daemon then acts on (idle-notification spam).
//
// This preload runs BEFORE any test module (and therefore before src/config.js) is imported, and
// redirects the state dir to a throwaway tmp dir + drops any inherited env-file override. It is the
// single structural guarantee that `node --test` can never pollute the live store — no per-file
// discipline required, so a newly-added test file can't silently regress it.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-state-'));
process.env.ORCH_STATE_DIR = stateDir;   // isolate the store/bus/state under tmp
delete process.env.ORCH_ENV_FILE;         // never read/write the operator's real .env.gui
