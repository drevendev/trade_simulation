# Open questions

Append-only. Questions that block implementation and cannot be resolved from the
specification alone. The researcher agent reads this file directly over HTTPS.

A question belongs here only when proceeding under any assumption would either be
unsafe or would make the work useless if the assumption turns out wrong. Everything
else is decided locally and recorded as a Decision on the Issue.

Each entry uses this shape:

```text
## Q-NNN — REQ-AREA-NNN — <the question, as a question>

Status:   OPEN | ANSWERED | WITHDRAWN
Blocks:   the Issues or requirement IDs that cannot proceed
Context:  what is already established, and what was tried
Options:  the candidate answers considered, with consequences
Answer:   filled in when the researcher responds, with the date
```

---

## 2026-09-03 — channel opened

No open questions. The specification mirror is not yet synchronized.

The first question is already known and is being asked out of band, because it
concerns the structure of the specification rather than its content: the
specification needs a navigation layer (`REQUIREMENTS_REGISTRY.csv`,
`SPEC_CHANGELOG.md`, `EXECUTION_ORDER.md`) so that a run can reach one requirement
without reading the whole folder.

---

## Q-001 — REQ-CONFIG-006 — Which document owns the fourteen production/labor controls that section 37 names and section 6/7 does not value?

Status:   OPEN
Blocks:   REQ-CONFIG-006 (landed PARTIAL), and the M4 rows that read these controls —
          REQ-PRODUCTION-003 (investment), REQ-PRODUCTION-005 (sticky wages),
          REQ-PRODUCTION-008 (lifecycle)

Context:  Section 37 "Configuration surface" of
          `06 - Handoff/05 — PRODUCTION_CAPITAL_LABOR_CONTRACTS.md` lists the controls
          `ProductionConfig` and `LaborConfig` "must include at least". Sections 6
          "Production defaults" and 7 "Labor defaults" of
          `06 - Handoff/03 — CANONICAL_CONFIG_AND_WORLD_GENERATION.md` state the
          baseline values, and `HANDOFF-REPAIR-005` / `HANDOFF-REPAIR-010` establish
          Handoff/03 as the sole owner of `SimulationConfig` baseline numbers.

          The two lists do not agree. Eighteen of the twenty-nine `ProductionConfig`
          controls and six of the ten `LaborConfig` controls have a stated value; the
          rest are named by section 37 and valued by nothing reachable from this
          requirement's registry slice. They are:

          ProductionConfig — `investmentReviewCadenceTicks`,
          `investmentUtilizationThreshold`, `minimumInvestmentMargin`,
          `investmentPropensity`, `maxInvestmentShareOfExcessCash`,
          `maxCapitalGrowthPerReview`, `lifecycleReviewCadenceTicks`,
          `mothballMarginThreshold`, `mothballUtilizationThreshold`,
          `reactivateMarginThreshold`, `closingGraceReviews`.

          LaborConfig — `maxLogWageStep`, `unitVacancyResponse`, `maxTightnessSignal`.

          Section 6 does state three review counts under different names, and the
          correspondence is forced because neither section declares any other
          review-count control, so these were mapped and the mapping recorded on Issue
          #527: `mothballAfterReviews` ← `mothballAfterNonviableReviews = 3`,
          `reactivateAfterReviews` ← `reactivateAfterViableReviews = 2`,
          `closeAfterReviews` ← `closeAfterMothballedReviews = 8`.

          Two further divergences were **not** mapped, because mapping them would
          invent a semantic rather than resolve a spelling:

          - Section 37 `maxLogWageStep` versus section 7 `maxWageMoveSharePerTick = 0.10`.
            A bound on a log step and a bound on a proportional move are different
            quantities; at 0.10 they differ by about half a percentage point of wage
            movement, so a wrong choice is silently plausible rather than obviously
            broken.
          - Section 37 `unitVacancyResponse` (a production unit responding to its own
            vacancies) versus section 7 `vacancyWagePressure = 0.40` and
            `unemploymentWagePressure = 0.40` (regional pressures). The scopes differ.

          Tried: the full reading order of `AUTHOR_RUNBOOK.md` section 4 — registry,
          `SPEC_CHANGELOG.md`, `EXECUTION_ORDER.md`, section 37, and the one dependency
          document. The mirror was not read recursively. No third document was opened.

Options:  1. Section 6/7 gains the missing values, keeping section 37 spelling. The
             surface then completes without touching any economic mechanism, and
             REQ-CONFIG-006 closes as IMPLEMENTED by adding defaults only.
          2. Section 37's list is reconciled down to what section 6/7 already values,
             and the unvalued controls are withdrawn as not-M4. Cheaper, but the M4
             production rows that reference investment and lifecycle behavior would
             have to be re-scoped.
          3. The values are left for the requirement that first reads each control
             (REQ-PRODUCTION-003/005/008). This spreads default authority across four
             rows and reopens the duplicate-owner problem that `HANDOFF-REPAIR-005` and
             `-010` were written to close. Not recommended.

          Whichever is chosen, `maxLogWageStep` versus `maxWageMoveSharePerTick` needs
          an explicit answer, because it decides a formula and not just a number.

          Separately, section 37 `laborEpsilon` and the section 37 "quantity tolerance"
          were deliberately **not** declared: labor is measured in worker-equivalents,
          a quantity, and `SimulationConfig.numeric.quantityEpsilon` already owns that
          tolerance — `HANDOFF-REPAIR-010` states the precedent verbatim for
          `MarketConfig`. If the researcher intends a labor tolerance distinct from
          `quantityEpsilon`, that also needs saying here. The *capital* tolerance is
          not an epsilon and does have its own owner and value, section 6
          `minimumLifecycleScale = 1e-6`, so it is declared.

          Implemented in the meantime: every control section 37 names is declared and
          validated, the twenty-nine with a stated value carry it, and the fourteen
          above are left `undefined` rather than guessed. A test asserts each of them
          is absent, so filling one in without answering this question fails the build.

Answer:   —
