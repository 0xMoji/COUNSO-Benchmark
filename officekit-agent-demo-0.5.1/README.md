# Agent-produced dashboard demo source

This static mini app was produced by an agent given only the exported public ui-dashboard task. It is a sample, not the toolkit reference or a model-performance result. No private tool session, model conversation, precomputed score, host receipt or archival identifier is included.

Use the independent standalone browser adapter from the toolkit source checkout:

```sh
node adapters/standalone-ui/browser-acceptance.mjs --execute-browser --case ui-dashboard --candidate-dir ../officekit-agent-demo-0.5.1/ui-dashboard --mapping ../officekit-agent-demo-0.5.1/ui-dashboard/action-mapping.json --output .local-runs/agent-demo-evidence
```

The evaluator supplies fictional source data and computes expected visible behavior independently. Functional PASS, FAIL or UNKNOWN is saved in the caller-local report. A static package or successful CI step alone is not a functional PASS. It is ordinary HTML/JavaScript; native Counso, Dust Frames and A2UI execution is not supplied. No model API or key is required.
