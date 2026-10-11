# office-capability-kit 0.5.2 agent-first development toolkit

A platform-independent development toolkit for synthetic office files, local tool transactions and generated standalone interactive web apps. Six tasks are registered: the Python runner implements four office tasks and the Node adapter contains two UI acceptance plans. Deterministic reference and replay providers check the instrument; their results are not model scores.

This source-only package contains implementation, synthetic input examples, schemas, tests, dependencies/lockfile, dependency notices and a CI template. It contains no precomputed run results, model samples or browser receipts. Run outputs are created locally by the caller. Browser acceptance, live-model capability and native platform integration remain unverified until actually executed.

## Start with your existing agent

The model is supplied by your agent platform. Export a public task, start its trusted synthetic tool host when required, give only the public directory to the agent, then independently grade its delivery. No model API, key, custom controller or extra model is required. See [AGENT_QUICKSTART.md](docs/AGENT_QUICKSTART.md) for the complete operator/agent workflow and unsupported-environment preflight.

```sh
.venv/bin/officekit prepare-agent --case office-recovery --output .local-runs/task-public --archive .local-runs/task-public.zip
.venv/bin/officekit host-agent --bundle .local-runs/task-public --output .local-runs/operator-run
# The existing agent reads TASK.md and runs the included call.py/submit.py.
.venv/bin/officekit grade-agent --bundle .local-runs/task-public --run .local-runs/operator-run --output .local-runs/grade
```

Install the kit using the clean-install commands below first. The host command stays running in the operator terminal while the agent uses the same public workspace. UI cases export static-app tasks and use the separate real-browser acceptance command. Chat-only/file-inaccessible platforms report ENVIRONMENT_UNSUPPORTED; no platform name alone proves native compatibility.

## Verify source bytes

From a clean checkout, `python3 -B scripts/verify_source.py` checks source-relative file hashes and rejects changed, missing, unlisted or symlink source files. It ignores only declared caller-local environments/build/run products and Git metadata. The manifest excludes itself, so this is byte-consistency checking rather than a signed authenticity guarantee.

## Clean installation and an office run

Requires Python 3.11 or newer. The Python package uses only the standard library, including its bundled build backend: no runtime or build dependency download is needed. Run from the package root:

```sh
python3 -m venv .venv
PIP_NO_INDEX=1 .venv/bin/python -m pip install --no-deps .
.venv/bin/officekit list
.venv/bin/officekit run --provider reference --case office-data --output .local-runs/example-data
```

Use a fresh output directory. The command creates `report.json`, `ledger.json`, `manifest.json` and generated `outputs/` files. The included reference makes zero model calls. The installed Python wheel contains the office core, office fixtures and schemas; the UI runtime remains in the source checkout and uses Node. `officekit prepare` supports the four office cases only. The four office cases are `office-evidence`, `office-data`, `office-tools` and `office-recovery`. They use fictional inputs and a local synthetic store; they cannot send real mail or change a real calendar. The recovery case covers a committed write with a lost acknowledgement, status discovery and an idempotent retry.

Deliberate controls use the same file/tool pipeline:

```sh
.venv/bin/officekit run --provider reference --case office-data --mutation wrong-total --output .local-runs/wrong-data
.venv/bin/officekit run --provider reference --case office-data --mutation forbidden-query --output .local-runs/protocol-control
```

These controls return exit status 1. A rejected unsupported read-only query is a protocol error; it does not establish a data leak or a business-system modification.

## Model/controller handoff

The kit never creates API keys, installs a model client or makes a paid model API request. An existing trusted controller can use the public file handoff or the bidirectional JSONL tool session. See [CONNECT_A_MODEL.md](docs/CONNECT_A_MODEL.md) for transport, metadata and evidence boundaries.

```sh
.venv/bin/officekit prepare --case office-evidence --output .local-runs/public-evidence
.venv/bin/officekit session --case office-recovery --output .local-runs/connected-recovery --max-tool-calls 32
```

`prepare` exports the prompt, synthetic inputs and tool descriptions. `session` emits a ready JSON line, accepts tool requests on stdin, returns actual local tool results on stdout and ends on a structured final message. An imported external ledger remains unverified and cannot certify tool effects.

## Standalone interactive UI

`ui-dashboard` and `ui-planner` use the [standalone adapter](adapters/standalone-ui/README.md), ordinary HTML/JavaScript, visible accessibility semantics and an explicit mapping file. Their public and same-schema transfer examples are independently hand-authored fictional inputs. See [UI model handoff](docs/CONNECT_A_MODEL.md#ui-model-handoff-from-the-source-checkout) for a public-input-only copy command; the browser `--prepare` command creates report skeletons, not a model input export. Genuine date changes, nondefault selections across source changes, invalid-to-valid edits, Add/Remove, conflict Reapply/Discard and failure recovery are explicit plans.

Node 22 or newer is recommended; the locked package supports Node 18 or newer. Offline/ordinary HTTP checks need no npm install and do not launch a browser:

```sh
mkdir -p .local-runs
node --test tests/ui/offline.test.mjs tests/ui/http.test.mjs
node adapters/standalone-ui/browser-acceptance.mjs --prepare --output .local-runs/prepared-ui
```

The prepare command produces local UNKNOWN reports. It does not execute browser behavior. To actually run acceptance in your authorized environment, install the exact locked Playwright package and use `--execute-browser` with normally launchable official Chrome, as documented in the adapter README. `--execute-ci` keeps its GitHub Actions guard; do not spoof it for local use. The ordinary CI template uses official preinstalled Chrome, exact Playwright 1.57.0, one ten-minute job, read-only repository contents and no business secrets. It is a template under `adapters/standalone-ui`, not an enabled workflow. Its branch and path scope are precisely `eval/counso-ui-probe` and `office-capability-kit-0.5/**` (plus its own workflow file). Enabling or running it is a separate authorized action.

## Deterministic tests

```sh
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -B -m unittest discover -s tests -p 'test*.py' -v
node --test tests/ui/offline.test.mjs tests/ui/http.test.mjs
```

Optional JSON Schema tests skip when `jsonschema`/`referencing` tooling is absent. Stdlib semantic tests always run. Test outcomes and local run artifacts are not shipped with the source package.

## Results, platform boundaries and licenses

Atoms use PASS, FAIL or UNKNOWN, fixed weights, typed observations and evidence references. UNKNOWN retains its weight: bounds and coverage disclose unresolved behavior. Business facts, ordinary functional failure, protocol integration, instrumentation gaps and proven unsafe effects are separate. Natural-language substrings alone do not establish false completion. Requested model/effort metadata is separate from a verified backend; unobservable tokens, snapshot and pure inference time stay UNKNOWN. Local fixture timings are not model speed. No ranking or stability claim is provided.

[PLATFORM_PROTOCOL_BOUNDARIES.md](docs/PLATFORM_PROTOCOL_BOUNDARIES.md) distinguishes standalone HTML, Dust Frames React/TSX and A2UI declarative messages. Dust/A2UI adapters are optional and unimplemented. Native Counso is UNKNOWN. MCP support alone does not establish an A2UI renderer.

[SYNTHETIC_INPUTS.md](docs/SYNTHETIC_INPUTS.md) describes the fictional input examples. Public inputs and evaluator controls are separate directories; a shared host/manual handoff provides instruction-level separation, not an OS sandbox. [SOURCE_MANIFEST.json](SOURCE_MANIFEST.json) inventories only this package's source files; it excludes itself from hashing.

No project-wide redistribution license has been granted for this development toolkit. [THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md) and `licenses/` cover only their named dependencies. [COMPLETION_GATES.md](docs/COMPLETION_GATES.md) describes future verification gates without claiming they have passed.

## Bounded observation corrections in 0.5.2

The standalone browser evaluator accepts narrowly typed visible numbers with
explicit units in the same value text or a genuinely visible bound unit label.
Its decimal/thousands grammar is documented alongside the evaluator; ambiguous
formats and unsupported prose stay `UNKNOWN`. Units are never supplied from an
expected answer.

Chart measurements may perform ordinary scrolling to place the chart in the
actual viewport. The evidence records the real pre/post-scroll state and images;
visibility, hit-testing, stability and common-zero geometry checks still apply.
Scrolling is a measurement step, not proof of user activation.

Failed browser waits/actions preserve the actual last DOM, PNG, action log and
trusted tool ledger before teardown whenever capture remains available. Missing
terminal evidence is reported explicitly. A wait timeout alone does not certify
a successful or failed business outcome. The successful-empty date probe changes
the upper bound first, keeping both intermediate intervals valid.

This increment does not alter the six task inputs, scoring weights or gold.
Earlier observations retain their original version. New browser runs use this
collector; no earlier unknown observation is silently converted to a pass.
