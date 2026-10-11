# Bounded controlled UI batch

This preparation belongs to `COUNSO-PLATFORM-SCREEN-0.4.0-control-v2`. It has **zero native model trials**. The executable branch is `eval/counso-ui-probe` in the verified private repository `0xMoji/counso-benchmark-reconstructed`. Parent/publisher alone owns the separately approved push and execution. This worker has not started a server, browser, candidate or workflow.

## Exact entry and source authority

- Offline generate: `python -m platform_screen.ci_batch prepare`. It refuses an existing preparation. Preserve the prior directory before an explicit rebind after source changes.
- Offline verify: `python -m platform_screen.ci_batch verify` and `node runtime/ci-entry.mjs --verify`.
- Authorized runner only: `node runtime/ci-entry.mjs --phase reference-create`, `dashboard-mutations`, `reference-edit`, or `planner-mutations`. There is no config/path/observer override CLI. `GITHUB_ACTIONS`, exact repo/ref/fixed controls job, independently supplied Actions commit/run ID, exact Git platform-screen-control/ prefix and checked-out prefixed batch anchor are verified before browser entry.
- The sole input is `ci-inputs/current-batch.json`, with a fixed SHA256 anchor. Every declared config, exhaustive static package, response, fixture raw bytes and authority metadata, observer, interface, design scope, acceptance plan and evaluator/runtime source is hash-bound. Candidate JSON trust flags and evaluator module paths are rejected.
- `runtime/ui-scope.json` is the matrix design-scope; `docs/UI_ACCEPTANCE_PLAN.json` is a separately bound acceptance plan. They are not interchangeable.
- Package digest = canonical SHA256 of sorted relative package-file SHA256 map. Response is separately bound. Fixture digest = canonical SHA256 of `{files: sorted raw-file SHA256 map, host_metadata: revision/canWrite}`. Initial and unseen replays compile the **same package/bundle**.

## Controls and execution budget

Two MAIN references, dashboard and planner, each run every applicable declared atom on primary and unseen same-schema fixtures. Six fixed source-only mutations cover correct-label/wrong-chart-geometry, primary-data hardcoding, old-result/old-error overwrite, cumulative allocation overflow, false Saved claim under stale revision and an old acknowledgement clearing newer local edits. Patches, original/mutated source hashes and exact expected atom/test IDs are declared before execution. No candidate output informed them.

One Actions job named controls runs four short, sequential phases: reference-create → dashboard-mutations (three) → reference-edit → planner-mutations (three). The existing eval/counso-ui-probe branch and original probe are retained. Setup/npm share a 60-second budget; precheck is limited to 60 seconds; phase shell limits are 90/90/120/90 seconds. The entire job has one 600-second ceiling. Each phase uses its own ci-results/<phase>/ directory, and a later phase never overwrites earlier evidence. Actual runtimes, queue times, artifact volume, account fees and remaining quota are **UNKNOWN** until service evidence returns. No new paid configuration is authorized. Preparation does not assert browser functionality. A partial/timeout job retains original artifacts and abstains.

Publisher places all new source under platform-screen-control/ and maps the internal .github/workflows/ui-acceptance.yml authority copy byte-for-byte to the active repository-root .github/workflows/counso-platform-screen-control.yml. Workflow default run cwd is the frozen root. Git verification uses HEAD:platform-screen-control/<batchpath>; active workflow bytes must match the authority copy.

Each config first runs an evaluator-registered known reference baseline with the same fixture, metadata, compiler, dependencies, official browser and host. Health is established only by a hash-bound actual-browser receipt whose independent predicates PASS. Config `registeredHealthControl` has exactly packageDir/packageSha256/bundleSha256/fixtureDir/fixtureSha256/hostMetadata/baselineTestId/baselineTestPlanSha256. Candidate self-report cannot establish health. Known invalid TSX/entry/import diagnosis is eligible only for the separate FAIL-only rejection path implemented by the compiler/CI/scorer owners, with registered same-job health; ambiguous infrastructure stays UNKNOWN.

Workflow uses Ubuntu24.04, Node24.16.0, SHA-pinned official actions, `contents: read`, credential persistence disabled, `npm ci --ignore-scripts` from the official lockfile, and the runner-preinstalled official Chrome channel. It downloads no second browser and uses no secrets, LLM API, tunnel, public deployment or security setting change. The opaque iframe and exact-route guard preserve the existing isolated proxy boundary.

## Import and verdict

`CIArtifactRegistration` is constructed by the coordinator after an independently observed publisher/GitHub service record, including exact repo, commit, run/attempt, phase label, fixed controls GitHub job, batch digest, downloaded artifact root-manifest digest and source observation. It is not a cryptographic signature and it cannot be deserialized from candidate JSON. Call:

`import_registered_artifact(bundle_root, downloaded_phase_artifact_root, registration)`

Pass the selected extracted phase directory containing batch-receipt.json to import, rather than the whole aggregate artifact. Import verifies the exhaustive downloaded phase artifact inventory, bounded paths, config/test/fixture/package/bundle typed joins and every referenced DOM, ledger, PNG and download digest before creating `TrustedBrowserReceipt`. Absolute runner paths are not used to join imported evidence. E0 is recomputed exclusively by frozen `objective_ui` against original response and required artifact bytes, with no added delivery weight. Browser assertions go through frozen `ui_scoring`. Missing or interrupted tests remain UNKNOWN.

Reference certification requires all applicable atoms PASS. Every selected mutation expected test must actually FAIL; UNKNOWN is an instrumentation gap and PASS is a missed mutation. Narrow mutation scores deliberately leave unrun unrelated atoms UNKNOWN. Compiler rejection receipts do not pretend to contain candidate clicks or claim business/safety caps.

Raw DOM/HTML where captured, screenshots, downloads, action receipts, host/network ledgers, build/package bindings and actual browser binary/version/image clocks remain original evidence. PNG aesthetic/image review remains UNKNOWN until inspected. CI/browser clocks never become model speed. Native Counso workspace/fork/flag, provider tokens, internal timing and costs remain UNKNOWN.

This version's fixed executable batch is the **eight predeclared controls only**. A future candidate batch needs the parent-owned run registration and reviewed bounded manifest update; candidate output cannot silently promote itself into this control registry.

The local development dependency symlink was replaced with an identical local official-registry dependency tree. A second temporary checkout-root compile produced the exact same reference bundle digest. node_modules is excluded from frozen source and installed from the official lockfile by CI. Trusted compiler settings and byte provenance, rather than a candidate environment, control builds.

The six-control closed set includes d-wrong-chart-geometry: numeric metrics and chart labels remain correct, while the exact frozen reference count-length height expression is inverted. D-E2 baseline is preregistered to FAIL on both fixtures from actual rendered geometry. The separate offline wrong-metric observer test remains. No new task or weight is added.
