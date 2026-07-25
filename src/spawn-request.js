// The orchestrator's "propose a worker" action: writes a pending of type 'spawn-request'
// that the daemon escalates with Approve/Dismiss (cockpit banner + Telegram buttons).
// Approval spawns the worker; the orchestrator never spawns directly.
export function makeSpawnRequest(bus, { name, why }) {
  const ref = bus.genRef('orch');
  return bus.writePending({
    ref,
    type: 'spawn-request',
    worker: 'orch',
    proposedName: name,
    why,
    text: `Spawn worker "${name}"? ${why || ''}`.trim(),
    createdAt: Date.now(),
  });
}
