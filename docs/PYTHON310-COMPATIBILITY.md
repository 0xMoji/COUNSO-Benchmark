# Python 3.10 SQLite authorizer compatibility repair

This branch is a small compatibility repair on the archived reconstruction baseline
`67d11ad1db52cadb413de105efc6797c24ffb4a5`. It is separate from the live-agent
pilot and does not repair or validate that pilot's scoring findings. It is not a
model-ranking release. The original `INDEPENDENT_REVIEW.md` and its machine-readable
evidence are retained unchanged as historical baseline evidence; they do not certify
this changed implementation.

## Observed failure

The baseline's actual GitHub Actions run
[38093975806](https://github.com/0xMoji/counso-benchmark-reconstructed/actions/runs/38093975806)
passed on Python 3.12. On CPython 3.10.22, package validation and all 67 unit tests
passed, but the reference self-test failed `R05-readonly-revenue:sql`. All 31
negative controls were detected. This was a harness compatibility failure, not a
candidate model failure.

`sqlite3.Connection.set_authorizer(None)` can disable the authorizer only from
Python 3.11 onward, according to the
[Python documentation](https://docs.python.org/3/library/sqlite3.html#sqlite3.Connection.set_authorizer).
The baseline used that operation before inserting two fixed evaluator perturbation
rows despite declaring Python >=3.10.

## Change and safety boundary

Replace that temporary disable call with an explicit callable returning
`sqlite3.SQLITE_OK`, supported by Python 3.10. This callback is used only for the
two hard-coded evaluator INSERT statements in the private in-memory database.
The same restrictive authorizer is restored before the second execution of
candidate SQL. No candidate string executes under the temporary callback.
Allowed table/function restrictions, single-statement SELECT execution, and the
instruction limit are unchanged. The Python 3.10 and 3.12 CI matrix is retained.

## Regression coverage and evidence scope

Seven new tests cover the reference SELECT, an equivalent aggregate SELECT,
callable-only authorizer compatibility and restored read-only enforcement,
constant queries, writes/multiple statements, unapproved functions, and
unapproved table reads. Both valid SELECTs must pass; invalid queries must fail.

Local command results are recorded separately in
`provenance/PYTHON310-COMPATIBILITY-TESTS.json`. Local Python 3.12 and the
callable-only compatibility regression are not a substitute for running Python
3.10. Remote results must be checked for the exact branch commit in GitHub Actions;
no remote green result is asserted by this document before that run exists.

The branch's `provenance/file_manifest.json` is regenerated for these new bytes.
The original baseline commit, frozen package, and candidate pilot outputs remain
unchanged.
