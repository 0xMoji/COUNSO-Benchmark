# Generic standalone UI adapter (0.5 development)

This adapter covers the two existing deep cases, `ui-dashboard` and `ui-planner`. It has no runtime npm dependencies. It does **not** exercise native Dust Frames, Dust SDK envelopes, A2UI messages/surfaces, or real business systems. Those levels remain UNKNOWN. Public and same-schema transfer inputs are independently hand-authored fictional examples; they contain no model outputs or historical run records. The task cases, atom weights and acceptance protocols remain fixed.

## Current verified level

`node --test tests/ui/offline.test.mjs tests/ui/http.test.mjs` checks only synthetic state transitions, deliberate wrong-scope/geometry controls, result handling, path boundaries and ordinary Node HTTP. It never starts a browser. `node adapters/standalone-ui/browser-acceptance.mjs --prepare --output <fresh-dir>` emits both typed reports with every UI atom UNKNOWN. Prepared reports are caller-created local outputs; none are bundled with this source package. They are not browser receipts.

Browser acceptance is unverified until actually executed. Ordinary users can run `--execute-browser` in their own authorized environment with normally launchable official Chrome. `--execute-ci` retains its GitHub Actions guard. Both modes share the same official Chrome (`channel: 'chrome'`), exact Playwright 1.57.0 and no custom browser security flags. Do not spoof `GITHUB_ACTIONS` for local execution. The exact official Playwright 1.57.0 lock is provided for dependency resolution. Dependency installation and browser execution are separate from source preparation. CI template is deliberately stored here, not enabled under `.github`; it preserves only synthetic browser evidence using the pinned official artifact action. Activation requires explicit authorization. It targets only push on `eval/counso-ui-probe` and the isolated `office-capability-kit-0.5/**` prefix; the coordinator must adjust the prefix consistently if packaging differs. First-run reference and four representative negative controls are included. Artifact upload/publication is not automatically enabled.

## Install and run browser acceptance

From the package root, resolve only the official locked package; browser download and package scripts are disabled:

```sh
cd adapters/standalone-ui
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --ignore-scripts --no-audit --no-fund
cd ../..
mkdir -p .local-runs
node adapters/standalone-ui/browser-acceptance.mjs --execute-browser --output .local-runs/browser-reference
```

Official Chrome must already be installed and normally launchable in the user's environment. The toolkit does not change browser security settings or install a browser. A failed launch is an instrumentation blocker; it does not prove task failure or browser success. `--candidate-dir <directory>` evaluates a static standalone app without package scripts. User-created reports, PNGs and ledgers stay in the chosen fresh local output directory.

## Interface and candidate packaging

A candidate provides an immutable static directory with `index.html`, `response.json` and all declared asset files. `response.json` contains `artifacts: [relative file paths]`. The runner never executes candidate package scripts. Files and every parent directory must be ordinary non-symlink paths. Canonical declared paths cannot contain traversal, URL schemes, encoded path separators, double slashes, absolute filesystem references or undeclared assets. Frozen source is hashed before/after both fixtures.

Local external scripts and ordinary inline `<script>` tags are supported; inline script bodies receive frozen-content CSP hashes. Inline event-handler attributes require a different adapter and are currently unsupported. External requests are rejected by context routes and CSP. Non-HTTP local CSV Blob downloads are allowed. Gold, controls, held queues, transfer plan and evaluator reports have no HTTP/window API. Host controls are evaluator-owned in-process methods. Tool routes and argument validation are defined once in `reference/api-contract.mjs`; schemas/descriptions are public in `tasks/ui/TOOL_INTERFACE.json`.

`--candidate-dir <directory>` and optional `--mapping <file>` adapt a legitimate standalone delivery. `action-mapping.json` describes visible role/name or label controls and unambiguous table headers. Neutral accessibility semantics are not a hidden mandatory hook. Missing/ambiguous/invisible controls add `PROTOCOL_INTEGRATION` diagnostics (at most a separate five-point diagnostic, never a business cap); only dependent atoms become UNKNOWN. Unsupported graphics/text semantics remain UNKNOWN for source-and-image-bound review. This is a bounded mapped horizontal/vertical-bar mechanical observer, not a general NLP/visual interpreter.

## Evidence and dependencies

`tasks/ui/*/evaluator/probes.json` states each atom's actual action → effect → visible state → accepted ledger chain. The controller issues real `click`, `fill`, `selectOption`, `setChecked` and key events. Read-only DOM capture checks native `checkVisibility`, ancestor opacity/display/visibility, current input `value`, explicit displayed units, unique visible meanings, actual table rows and real plot/glyph rectangles. Glyph/plot geometry must be stable at two observations; solid paint, ancestor visibility/no unsupported masking/transform and actual hit visibility are observable prerequisites. DOM facts are re-captured across the PNG boundary; instability marks affected evidence UNKNOWN. Zero categories and wrong-ratio controls are explicit. PNGs are state/ledger-bound, saved with SHA256, and remain `visually_inspected:false`; no aesthetic/readability judgment is claimed automatically.

Every probe has an isolated context/store and action/host request/result/commit ledger, visible state and PNG hashes. Source capture occurs at request initiation, so an old held response actually carries the old scope/source. Conflict, read-only, transient/ambiguous failure and late-ack are controlled effects, not claimed unsafe actions. Teardown releases outstanding mock requests with an explicit observer-teardown rejection and closes connections on a bounded cleanup path; these are not candidate attempts.

`report.mjs` emits the core's typed atoms (`PASS/FAIL/UNKNOWN`, dimension, fixed weight, required probes, expected/observed and artifact/tool-event evidence). It does not implement another quality aggregate or infer safety/business caps. Missing chart evidence does not erase independently proved row evidence. Source mismatches require an affirmative current-result view; retained/pending/unsupported visible state remains UNKNOWN for business review. A separately observed old-completion regression can still prove a FUNCTIONAL_RESULT failure without inventing a material-claim cap. Pure natural-language “saved” claims are not regex-classified: exact accepted draft payload/commit/state is required, and unsupported full save-state semantics remain UNKNOWN. Synthetic boundary testing does not prove real-service security, native protocol coverage or ranking stability.

## Browser sequences prepared

Dashboard: baseline source facts; keyboard chart activation; two distinct dates with genuinely distinct records; nondefault team/status/date retained across a revised source; current-source reset; successful empty view; old success and old error after newer completion; failure/retry for current intent; same unchanged app on the fictional transfer fixture. Negative source variants are `wrong-scope`, `old-response`, `wrong-geometry`.

Planner: old capacity/filter/date/search/sort/download/key behavior; actual Add → cumulative preview → explicit Save → new browser document read; invalid Add/edit → valid correction; Remove before Save; real revision conflict → Review → explicit Reapply with remote change or explicit Discard; predeclared/midflight read-only; pending duplicate prevention and delayed A acknowledgement preserving B; ambiguous failure → actual re-read → explicit retry; same app on the fictional transfer fixture. Negative source variant is `late-ack-clears-edits`.

Actual browser acceptance and live-model/native platform integration are unverified. Keep run outputs local. No browser receipt or result history is included in this source package.

### Typed visible quantity grammar (0.5.2)

The value must be one complete signed scalar, with a dot decimal separator and
optional correctly grouped comma thousands, optionally followed by one explicit
unit token. Examples: `16 tickets`, `23.25 hours`, `1,234.50 hours`. Scientific
notation, mixed locale separators, extra quantities and free prose are not
guessed. A genuinely visible adjacent unit may bind a plain scalar; adjacent
explanatory prose cannot override an inline unit. Conflicting unit declarations
stay UNKNOWN. No expected mapping unit is copied into the observation.

Plain chart counts can share one actual visible zero-origin range/unit label
only when all mapped counts, plots and glyphs belong to the same nearest named
visible chart section/region. Its raw range label and all member identities are
recorded. Duplicate labels, hidden evidence, cross-region associations and
unsupported range grammar stay UNKNOWN. A zero-size glyph on its declared axis
can establish DOM membership only; it cannot certify paint or plotted values.
The independent chart geometry and visibility checks are unchanged.
