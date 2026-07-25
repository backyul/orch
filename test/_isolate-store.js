// Force tests onto an isolated, throwaway state dir so they NEVER read or write a real orchestrator
// store — not the default (~/.claude/orchestrator) and, crucially, not the cockpit's
// (~/.claude/orchestrator-gui). Without this, running the suite from a GUI agent (whose env sets
// ORCH_STATE_DIR=...-gui) makes the cli.js subprocesses + bus writes corrupt the LIVE store with
// test fixtures — a stray 'w9' worker, fake pendings, a flipped away flag — which the orchestrator
// then has to clean up. It also removes cross-file shared-state pollution (the flaky 'say is
// suppressed' failure). Import this FIRST — before anything that reads config.js's ORCH_DIR, which
// is resolved from process.env.ORCH_STATE_DIR at module load.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.ORCH_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-'));
