# Connecting an existing model controller

The runner separates tasks/scoring from the model provider and platform. It does not collect API keys or launch an arbitrary candidate program. Use an agent or wrapper you already trust and have configured. Connecting a controller is an integration task; the transport's existence is not evidence that Counso, any named model or a production service has been exercised.

## Public file handoff for the four office cases

`officekit prepare --case office-evidence --output public-task` creates a new directory containing the public prompt, input files, per-task tool descriptions and a hash-bound public manifest. It excludes evaluator gold, mock service state and negative controls. Give only this public directory to the candidate. Keep candidate outputs in a separate directory with `outputs/<declared-filename>` and a structured `candidate.json`.

```sh
officekit grade --bundle public-task --artifacts candidate-result --candidate candidate-result/candidate.json --output graded-result
```

`officekit prepare` supports only the four office cases. The UI cases listed by `officekit list` use a separate source-checkout Node adapter; the Python wheel does not contain that UI runtime. File content and delivery can be checked. A candidate-provided ledger/state cannot establish that real tool actions occurred, so those dimensions stay UNKNOWN. File handoff alone is insufficient for the two transaction tasks' tool-effect claims.

## Actual interactive tool session

Start `officekit session --case office-recovery --output connected-result --max-tool-calls 32` as a subprocess in a trusted controller. Read its stdout line by line and write a complete JSON object followed by a newline to stdin. Do not feed evaluator files, private archives or hidden expected answers to the model.

1. The first stdout object has `type: ready`, the public prompt and the exact task-local tools.
2. Send one request: `{"op":"tool","tool":"files.read_input","arguments":{"file":"request.json"}}`.
3. Read the `tool_result` response. Pass the actual result to the model before asking for the next action. Tool identities and schemas are those from the ready message; an unrelated service-wide help page grants no additional tool operations.
4. End with `{"op":"final","result":{"artifacts":[],"completed_actions":[],"facts":{},"text":"..."}}`. Use actual artifact paths and accepted event/resource identifiers returned by tools when claiming completion.

Malformed or unsupported requests consume the fixed request budget and produce protocol evidence. Nothing is executed as code from a JSONL request. The tool service is a synthetic local store. Candidate files are restricted to declared `outputs/` paths. It cannot send real mail, alter a real calendar or read the user's accounts.

`schemas/jsonl-session.schema.json`, `schemas/candidate.schema.json` and `schemas/tool-event.schema.json` document the transport. The Python runtime validates the bounded contract it supports; it is not a general-purpose JSON Schema implementation.

## Provider implementation boundary

A Python integration can implement `Provider.execute(session) -> CandidateResult` and supply a `ProviderInfo`. `session.call(tool, arguments)` is the authoritative local request/result interface. The controller's own network/model calls are outside the core. Report their metadata truthfully: requested model/effort is not a verified backend snapshot. Keep unobservable token counts, snapshot and pure inference timing UNKNOWN. Single-model/no-extra-LLM restrictions belong in the evaluation protocol used by the caller.

The included reference and recorded-action providers make zero model calls. JSONL tests use a deterministic external controller and verify genuine feedback plumbing; they are not live-model tests. No packaged OpenAI, Counso, Dust or A2UI provider has yet been run. The default four-task public export can be used by an already configured product, but its precise native tool wiring must be implemented against that product's supported interface.

## UI model handoff from the source checkout

This is separate from the four-case Python handoff. `browser-acceptance.mjs --prepare` creates UNKNOWN report skeletons, not a model task export. Give the model only the UI public inputs and tool interface. From the source package root, create a fresh public input directory:

```sh
mkdir -p .local-runs
mkdir .local-runs/ui-dashboard-public
cp tasks/ui/ui-dashboard/public/* .local-runs/ui-dashboard-public/
cp tasks/ui/TOOL_INTERFACE.json .local-runs/ui-dashboard-public/
```

For `ui-planner`, replace both occurrences of `ui-dashboard` with `ui-planner`. Never include task atoms, `evaluator/`, the reference app, oracle code or negative controls in the model input directory. Do not give the controller the full source checkout as its task context. Keep its generated standalone files in a separate static candidate directory, for example `.local-runs/candidate-ui`.

After the model has produced `index.html`, `response.json` and declared local assets, evaluate them in your authorized normally launchable official Chrome environment using the locked dependency install described in the adapter README:

```sh
node adapters/standalone-ui/browser-acceptance.mjs --execute-browser --case ui-dashboard --candidate-dir .local-runs/candidate-ui --output .local-runs/ui-dashboard-grade
```

This command runs real browser events and creates caller-local reports/PNG/tool ledgers; none are included in the source-only package. Live-model output is unverified until your configured controller actually generates it, and browser behavior is unverified until acceptance executes.

The UI task public prompt, fixture and `TOOL_INTERFACE.json` describe a static standalone app package and its synthetic HTTP capabilities. Keep evaluator probes, unseen fixtures and reference/mutations out of the candidate context. Give the generated package to the separate browser adapter with an explicit visible-action mapping where needed. A2UI declarative output and Frames TSX output require their own runtime adapters; they are not silently accepted as standalone HTML.
