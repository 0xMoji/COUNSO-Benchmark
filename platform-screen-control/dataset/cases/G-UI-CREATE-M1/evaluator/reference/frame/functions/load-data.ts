// Deterministic task-data function for the controlled proxy. No network or model calls.
export default function loadData(input: unknown, snapshot: unknown) {
  return {snapshot, scope: input};
}
