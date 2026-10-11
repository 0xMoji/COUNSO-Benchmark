# RECON-0.2 revision and review boundary

HISTORY-RECONSTRUCTED. Synthetic business data. Package/grader revision RECON-0.2, Python package 0.2.0. The wire response schema remains RECON-0.1 for compatibility. This is an independent revised package, not a claim that the original historical benchmark has been recovered.

## Status and ancestry

- Compatibility starting point: commit `a9f731be5abfacf5270c75e387c150ad216e7d9b`, manifest `ecac5fc602577f32b694030bb3e045f4c14a1ede1937e1e61fec4caf983f808b`. Its published Python 3.10/3.12 CI success is preserved in `provenance/history/PYTHON310-PUBLICATION.json`; it does not prove that this new code has passed those remote jobs.
- The callable SQLite authorizer restoration and `sqlite3.Warning` rejection are retained. The original 67 regressions and the additional eight compatibility regressions are unchanged.
- `INDEPENDENT_REVIEW.md`, `provenance/INDEPENDENT_REVIEW.json`, the old control/oracle/selftest evidence and the old final-verification document are historical evidence, preserved byte-for-byte. They do not cover the new code, schemas or split CSV checks. The new independent AI review is complete with a bounded pass: see `docs/INDEPENDENT_REVIEW_RECON_0.2.zh.md`. This package has not been uploaded or published.
- No candidate model/effort identifiers were read to implement the changes. The revision code has no provider-specific behavior. Real candidate outputs, original scores and original service observations remain outside this package and are never overwritten.

## Same-task semantic equivalences

1. B01 and its simpler source-review relative: exact audited field aliases (`registration_number`/`登记号` → `registration`, `辖区` → `jurisdiction`), with order independence. No blanket lowercasing. Display name, contact name, unknown labels and duplicate semantic fields are not accepted. Public schemas list canonical labels, explicit aliases and plausible distractors.
2. B13: five state categories accept their short key or the matching public response-field name. Every category must contain its actual primary authority. Related supporting/conflicting sources and array order do not create errors. Missing authority and invented sources fail, even when another category is unparseable or ambiguous. Unrecognized category or potentially related but unclassified supplemental evidence remains UNKNOWN for independent review. The new schema declares the keys and string-array shapes and requires exactly one key per category.
3. B17 amounts, including the simple static-valuation relative: finite Decimal, exact numeric equality. Decimal scale does not change the value; NaN, infinity, malformed values and any nonzero error fail. Schema string type remains independently enforced. Zero-tolerance equality is compared directly, avoiding arithmetic-context rounding of tiny differences.
4. Legacy B17 period equivalence uses only explicit aliases of the holding period; filename/version/quote-date labels remain wrong. No substring heuristics.
5. OOXML `s`, `inlineStr` and `str` are text types. Duplicate worksheet names, physical row identifiers and cell references are rejected instead of being overwritten by dictionary parsing. Legal physical row reorder remains supported. Text IDs preserve exact leading zeros; numeric IDs and text amounts still fail. Microsoft documents `str` as the String cell type: https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.spreadsheet.cellvalues . This is not a Microsoft Excel visual/compatibility test.
6. The B20 prompt did not forbid amount formulas. A bounded AST/Decimal evaluator recalculates local numeric references, arithmetic and ROUND; it never executes candidate code. Supported formula values must agree with both their available cache and source-derived expectations. Unsupported formulas remain UNKNOWN, not a cached-value pass. Wrong amounts, references that produce wrong values, forged caches, cycles and numeric type violations are rejected. Formula result amounts use zero tolerance instead of hiding sub-cent errors through output rounding. Other spreadsheet task formula requirements are unchanged.
7. Shared CSV reading rejects logical records whose number of fields differs from the header; quoted embedded delimiters remain normal CSV. This detects a genuine malformed-row defect independently of whether legacy headers were adequately specified.

## New B17 task clarification is separate

`B17-contract-0.2` final manifest hash:
`a1eb635d8edca150207be281e169d6feb20954dec51b223fa591493f95b4f42a`.

The final frozen manifest is preserved under `provenance/history/`. Exported prompt, response schema and all three business files match its hashes exactly. The new run/input envelopes add explicit revision labels; README and business input bytes are unchanged. No earlier B17 pre-review hash is used. The eight pre-existing pilot candidate packages were not modified.

The new task publicly defines the `eur_intermediate` target as U-EUR-FX, `period_source=period`, fixed CSV columns and the unknown-only native-currency columns. The original holdings, quotes, policy, normal amounts and itemized gold CSV are unchanged. Catalog, schema, gold response, checks and deterministic generator agree. A shared-object alias in the original generator was detached before applying B17-only changes, so CSV constraints do not leak into its simpler relative.

The itemized CSV check keeps its original total weight of four but splits into:
- Three critical business-fact points: every input position exists exactly once; status, values, unknown blanks and required native amounts match.
- One noncritical public-format point: exact column names/order, record width and declared CONFIRMED/UNKNOWN status labels.

A remaining fixed-prompt boundary is preserved explicitly: extra clearly identified subtotal rows were not expressly forbidden. Complete correct source-position rows plus a correct recognized subtotal therefore produce business UNKNOWN, never automatic full credit or an invented-extra-position hard zero. An invalid summary status is separately a noncritical format failure. Wrong subtotal amounts, missing/duplicate source rows and explicit fictitious position rows fail business checks regardless of their ID prefix. Unrecognized extra rows stay UNKNOWN, not silently ignored. Out-of-enum status spellings fail format but do not alone prove wrong business state: the business check retains UNKNOWN while still checking independent values. Legal CONFIRMED/UNKNOWN reversals remain business failures. Wrong columns and ragged records fail format; when they prevent reliable business interpretation, business state stays UNKNOWN. This conservatism was chosen after the contract was frozen, without changing candidate conditions.

Legacy B17 `eur_intermediate` has no unique target: 4000, 120000 and 124000 must all be UNKNOWN in old-output regrades. Legacy exact CSV column semantics also remain UNKNOWN, while separately demonstrable malformed-row defects may receive noncritical format FAIL. New-task definitions must not be applied retroactively.

A second remaining fixed-prompt boundary concerns selected_holding_rows and selected_quote_rows: “confirmed position_id” can mean confirmed SGD valuation or actually verified source evidence. All required confirmed-position choices must still match. Extra mappings are checked against the actual input position and source-row IDs, holding approval/period/latest-version rules, and quote date/FINAL state. Wrong, missing or ineligible source rows fail. Additional valid source rows remain scope UNKNOWN instead of an exact-key-set failure. Explicit quality_scope_unknown preserves incomplete quality coverage even if supplied review dimensions are all four; the check stays noncritical. Already-proven safety/critical errors retain their zero hard gate, while ordinary determined noncritical errors retain their existing completeness cap. This applies equally in the legacy semantic helper, without changing the fixed prompt or inventing model-specific exceptions.

## Export and score a genuinely new run

```sh
python3 -m counso_bench export B17.reconcile --output /tmp/new-B17-input
python3 -m counso_bench score B17.reconcile \
  --response /path/to/new-output/response.json --run /path/to/new-run.json \
  --output-dir /path/to/new-output \
  --task-revision B17-contract-0.2 --rubric-version RECON-0.2 \
  --output /path/to/new-score.json
```

The flags change only the in-memory scoring envelope, recorded in `scoring_envelope_overrides`. They do not prove what input a candidate saw; the experiment runner must retain and verify the actual frozen input manifest before choosing them. The original run file hash is retained. NEW_MODEL runs require the new rubric explicitly, and revised tasks require the exact task revision. Aggregation rejects report/task revision mismatches. Completion, objective correctness, AI-assisted evidence review and real human quality remain distinct; missing human assessment remains UNKNOWN.

## New service observations and old regrades

For a new service-dependent run, start this package's `serve-mock`, retain its run/session/fingerprint and capture the canonical `observations.json` SHA256 in trusted assessor metadata after the session. Supply it as `run.observation_file_sha256` or `score --observation-sha256 HASH`. The scorer checks run, session, scenario, origin, current execution fingerprint and the pinned content hash. The hash is not a digital signature; assessor metadata and service files must be isolated from the candidate. Hashing a file after an attacker changed both it and its trusted receipt would not establish authenticity.

Old B01 service observations cannot be used as this package's new execution evidence. A legacy regrade must first authenticate the old run/session/scenario/fingerprint against the old frozen package, retain all source hashes, and then explicitly apply a semantic patch. It must not rewrite observations or substitute the new fingerprint.

The reusable patch interface is:

```python
from counso_bench.revision_semantics import evaluate_equivalence
handled, passed, reason = evaluate_equivalence(
    check, response, output_dir, original_package_root, observations)
```

`passed=None` is UNKNOWN; `handled=False` means use the original check unchanged. This helper does not authenticate runs. In a process already importing the original package, use `examples/load_revision_helper.py` to load this package under a distinct namespace. The external experiment manager owns the full audit/regrade wrapper, including old-B17 UNKNOWN overrides, before/after check records and original input/run/response/artifact/observation hashes. The final external adapter is PILOT-LEGACY-REGRADE-0.2.1 (script SHA256 164c91dbc4c9c3f40e992b3c1a5f0e1444b913cbb2392df3fbd970db20800616): besides old EUR/CSV UNKNOWN handling it retains unrecognized legacy period free strings as UNKNOWN and rejects non-string period values before the narrow label helper. It passed 31 independently rerun adapter controls. That wrapper is not replaced by new `score` commands, and no model call is synthesized by this implementation.

## Verification and limits

See `provenance/REVISION-0.2-VALIDATION.json` for results and `docs/REVISION-0.2-CONTROLS.md` for semantic positive/negative controls. New tests are deterministic simulated controls, not candidate observations. The original 75 tests, new revision tests, 31 positive reference scenarios, 31 negative selftest controls and the existing independent-control script have been exercised locally on Python 3.12.14. The new code has not yet run in remote Python 3.10 CI; the preserved compatibility controls test its two known SQLite hazards locally. Independent AI review of RECON-0.2 passed its 95-case bounded matrix. This is not real human quality review. Actual Microsoft Excel rendering remains UNKNOWN.

### Pilot audit wrapper location (separate deliverable)

The experiment manager prepared `evaluator/regrade_baseline.py` in the separate `counso-pilot-20261010` evidence directory. It is run only after the revised helper is frozen:

```sh
python evaluator/regrade_baseline.py \
  --evidence-root /workspace/shared/counso-pilot-20261010 \
  --baseline-package /workspace/shared/counso-benchmark-reconstructed \
  --new-package /workspace/shared/counso-benchmark-recon-0.2 \
  --output-dir /workspace/shared/counso-pilot-20261010/evaluator/regraded-v0.2.1
```

That command is outside this source package; its results remain a separate experimental deliverable; the final adapter’s 31 controls were independently reviewed. The input paths are experiment-local, not required installation paths. No successful regrade is claimed by this implementation record.

## Post-review packaging identity

The added independent audit reports bind review snapshot manifest f19619224f2af285948be9abcdca1070b6e01a29437278ec3bf05d86f157e2de and execution fingerprint bd20bb4d7d2470a1f5736a86508fb8f28e4a8eaf73d492cde4af78e8c1aa7c45. Including those reports changes the overall package manifest. Only documentation/provenance and the manifest were updated after review; the execution fingerprint remains unchanged. The 40-cell experiment corpus and regrade script are not copied into this execution package. All 11 selected audit artifacts plus their delivery manifest are preserved byte-for-byte under provenance/recon02-independent-audit/.
