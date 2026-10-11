# RECON-0.2 control inventory

These are deterministic synthetic controls, not model samples and not a human review. The original 67 tests plus eight Python-compatibility tests remain byte-for-byte unchanged. `tests/test_revision_02.py` adds 39 test methods with multiple subcases.

| Area | Semantic positive controls | Nearby genuine error / UNKNOWN controls |
|---|---|---|
| B01 entity fields | canonical order reversal, registration_number, Chinese aliases | name/contact substitution, case guessing, missing/duplicate semantic fields |
| B13 evidence | public result-field keys, authority-policy/support sources, order changes | each missing primary authority, sales-only/open workspace, nonexistent sources FAIL; ambiguous categories/relevance UNKNOWN; duplicate category/incorrect array shape schema FAIL |
| B17 amount | decimal scale changes and finite scientific notation | +0.01, sub-context-precision differences, NaN/sNaN/infinities, invalid strings; numeric JSON violates string schema |
| Legacy period helper | period/holding_period and explicit holding-field aliases | filename/version_date/quote_date and substring guesses FAIL |
| New B17 | exact frozen prompt/schema/business hashes; period enum; U-EUR-FX=4000 | old holding_period invalid; 120000/124000/wrong amount fail new target; old-target UNKNOWN is controlled by external legacy wrapper |
| New B17 CSV | all original rows with reordered rows and equivalent decimals | missing/duplicate/wrong rows, UNKNOWN=0, wrong native columns fail business; header-order/extra-columns/ragged records fail format; unparseable business rows UNKNOWN; out-of-enum status format FAIL/business UNKNOWN while independent wrong amounts and legal state reversals remain FAIL |
| Remaining extra-row ambiguity | recognized correct subtotal is UNKNOWN, not PASS | fake subtotal amount or fictitious complete confirmed position regardless of ID prefix FAIL; unknown extra label UNKNOWN; out-of-enum summary status format FAIL, not a business hard zero |
| Source-map scope | required confirmed source mappings PASS; valid additional holdings/quotes UNKNOWN and full quality UNKNOWN, even with a synthetic 4/4/4 review | omitted/wrong required choices, nonexistent/mismatched source IDs, draft/period/stale/indicative extra sources FAIL; scope UNKNOWN plus proven critical amount error retains quality zero |
| B20 OOXML | inlineStr/s/str IDs with preserved leading zeros; physical row reorder | numeric IDs, truncated zero, text amount, sub-cent amount error, duplicated physical row/cell FAIL |
| B20 formulas | all 2400 ROUND(C−D−E,2) rows independently recomputed, missing-cache supported formula, positive/negative rounding | wrong calculation, wrong-value reference, forged cache, cycle FAIL; unsupported formula/complexity UNKNOWN; no code execution |
| Evidence/revisions | matching new service run/session/scenario/fingerprint/pinned hash | changed run/session/scenario/fingerprint/content and missing real-run hash reject; task/grader mismatch and mixed-version aggregation reject |
| Generator | regenerated catalog/gold structural equality, unchanged input hashes | protects against B17-only changes leaking through shared mutable generator objects |
| Helper | three-state handled/PASS-FAIL-UNKNOWN contract | unhandled is distinct from handled UNKNOWN; independently namespaced loader |

## Commands

```sh
python3 -m unittest discover -s tests -v
python3 -m counso_bench selftest --output /tmp/recon02-selftest
python3 tests/independent_review_controls.py --package-root . --output-dir /tmp/recon02-independent
python3 tests/independent_oracle.py .
```

Existing independent scripts produce 37 control checks plus a source-only arithmetic oracle. Re-running an existing independent script is not a fresh independent code review. The final execution fingerprint subsequently passed an additional independent AI 95-case control matrix; see docs/INDEPENDENT_REVIEW_RECON_0.2.zh.md. This bounded review is not a human quality assessment or remote CI result.

Legacy wrapper controls (owned by the experiment manager) separately verify that 4000/120000/124000 all remain UNKNOWN under the old underspecified eur_intermediate field, and that old exact CSV column contracts cannot be imposed after the fact. They retain original service identity checks, original scores and check-level diffs. This package does not pretend those old outputs were new model runs.
