# Give the task to an agent, not to a model API

The caller chooses an existing agent whose platform supplies its model. The kit makes no model API call and needs no key. Agents need the documented file/tool capabilities; a chat-only model is an unsupported environment, not a score of zero. No adapter or native capability is inferred from a platform name.

## Operator: install once and export a public task

From the source package root, use Python 3.11+:

```sh
python3 -m venv .venv
PIP_NO_INDEX=1 .venv/bin/python -m pip install --no-deps .
.venv/bin/officekit prepare-agent --case office-recovery --output .local-runs/recovery-public --archive .local-runs/recovery-public.zip
```

Any of the six fixed case IDs can be exported, including both UI cases from the installed wheel. The directory/ZIP contains TASK.md, public inputs, actual permitted tool descriptions, final schema, environment requirements and fixed stdlib helpers. It contains no evaluator, service state, reference implementation, mutation, scorer, credential or run result. Keep the full source checkout and private evaluator files away from the candidate's task context.

## Operator: start the trusted office tool host

For the four office cases, in an operator terminal:

```sh
.venv/bin/officekit host-agent --bundle .local-runs/recovery-public --output .local-runs/operator-recovery --timeout 900
```

The host remains running while the agent works. It writes `.bridge/ready.json` into the public task directory. The agent and host must see that same public directory through their shell/files tools. Only the operator holds `.local-runs/operator-recovery`. A separately uploaded ZIP in an unrelated platform filesystem does not connect back to this host. Use an execution environment with a shared public workspace or a supported platform tool integration; do not expose a host over an unapproved tunnel. The local bridge currently requires POSIX, Python 3.11+, normal directory-relative/no-follow filesystem calls, POSIX file locking and a running trusted host. Unsupported operating systems or missing tools are explicitly reported.

Give the existing agent only the public directory and say: “Read TASK.md, check ENVIRONMENT.json, solve this task using its fixed tools, and submit the specified files.” It runs the included call.py directly. You do not write a controller, choose a model API or create credentials. The host records actual synthetic tool results and commits; the helper does not fabricate responses or reveal grading. Nothing sends real mail or changes a real calendar.

The host's 900-second waiting window includes operator/candidate handoff, not just inference. For a comparison the operator must separately register equal agent start/deadline/tool allowances. The toolkit does not turn a handoff delay into model speed.

## Operator: independently grade the original office session

```sh
.venv/bin/officekit grade-agent --bundle .local-runs/recovery-public --run .local-runs/operator-recovery --receipt .local-runs/operator-recovery/host_receipt.json --output .local-runs/recovery-grade
```

This command verifies fixed public input, the operator's original host receipt, run identity and hash-bound actual files/ledger/state before applying the same core rubric again. Candidate-created ledgers, states and receipts are not accepted as authority. The operator must retain the private original; hashes detect changed content but are not signatures. A candidate with arbitrary access to the operator's private filesystem is outside this instruction-level trust boundary. No OS sandbox is claimed.

The agent's submission/candidate.json and handoff.json are delivery claims. Tool-created outputs and the authoritative report/manifest remain in the operator run. A lost acknowledgement is a real tool result to resolve, not permission to replace the ledger or fabricate a successful result.

## UI task: generate a static mini app, then independently run the browser

```sh
.venv/bin/officekit prepare-agent --case ui-dashboard --output .local-runs/dashboard-public --archive .local-runs/dashboard-public.zip
```

Give the exported public directory to a files-capable agent. It delivers `submission/index.html`, `submission/response.json` and declared local assets, optionally an accessibility action-mapping.json. The fixed submit.py produces a static handoff; it never grants functional PASS. The two UI tasks require no office tool-host process. Their synthetic HTTP source/draft tools are supplied later by the independent browser host.

From the trusted source checkout, install the exact locked official Playwright package as documented in the standalone adapter README, then run:

```sh
node adapters/standalone-ui/browser-acceptance.mjs --execute-browser --case ui-dashboard --candidate-dir .local-runs/dashboard-public/submission --output .local-runs/dashboard-grade
```

Use `ui-planner` for the other task. No candidate npm/build script is run. Use a normally launchable authorized official Chrome environment. A restricted environment keeps browser behavior UNKNOWN; do not change browser security flags, spoof CI, or bypass a denied launch. The bounded CI template provides the supported alternative. The separate Node/browser adapter lives in the source checkout, not in the Python wheel.

Dates, nondefault selections, new same-schema data, errors/empty results, actual commits, conflict Review/Reapply/Discard and late acknowledgements are assessed by visible results and the trusted ledger. Source code, screenshots alone and candidate-written records cannot certify behavior.

## Platform boundaries

Counso, DeepSeek-hosted agents, native assistants and other agent platforms may use this workflow only when their actual tools/environment satisfy the preflight. There is no model/provider-specific API integration. Native Counso runtime remains UNKNOWN until its supported interface is exercised. The standalone HTML task is not Dust Frames React/TSX and is not an A2UI message/renderer test. Those are optional distinct future runtime adapters, never silently credited.
