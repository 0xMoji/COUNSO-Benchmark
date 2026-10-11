# Fictional input examples

All inputs are manually authored examples for this development implementation, not captures of accounts, business systems, model responses or experiment outputs. Dates, identifiers, names and amounts describe fictional scenarios.

- `office-evidence`: a signed fictional purchase order for Harbor Supplies (PO-204), an older email estimate, an unresolved preference and an unverified tracker entry. Their disagreements exercise source authority and typed identity/date/currency facts.
- `office-data`: a short transaction CSV with versions of one transaction, case/space variations in region labels, multiple currencies, a negative/zero amount, cancelled/pending rows and an invalid amount. It exercises deterministic parsing and reconciliation without real financial records.
- `office-tools`: a fictional delivery-review request to Lia at an example-domain address, two adjacent calendar slots and one conflicting local mock event. It authorizes a local draft/private hold, never real sending or invitations.
- `office-recovery`: the same kind of fictional request with an explicit mock lost acknowledgement for the stable draft key. Request discovery/retry acts only on the local synthetic store.
- `ui-dashboard`: independent fictional support snapshots in `public/source.json` and `evaluator/source.json`, each with stable identities, similar team labels, distinct dates, active/closed/zero-category scopes and due-time boundaries.
- `ui-planner`: independent fictional resource/roster/work/draft inputs in `public/` and `evaluator/`. They preserve similar names, distinct roster dates, team/skill constraints, capacity/work limits and separate tentative allocations.

Evaluator transfer inputs and action/control plans are not part of the candidate's public handoff. The reference/oracle derives facts from the selected input schema. A shared-host handoff is instruction-level isolation only.
