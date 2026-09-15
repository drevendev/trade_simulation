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

---

## Q-002 — REQ-CONFIG-007 — Which document values the sixteen M4 population controls that section 33 names and section 8 of Handoff/03 states in a different vocabulary?

Status:   OPEN
Blocks:   REQ-CONFIG-007 (landed PARTIAL), and the M4 rows that read these controls —
          REQ-POPULATION-001 (household demand), REQ-POPULATION-002 (labor supply),
          REQ-POPULATION-003 (welfare/health signals)

Context:  Section 33 "Configuration surface" of
          `06 - Handoff/06 — POPULATION_DEMOGRAPHY_CLANS_CONTRACTS.md` names the control
          groups `PopulationConfig` must centralize; sections 4, 5, 6, 8, 9, 10 and 11 of
          the same document spell the individual M4 controls. Section 8 "Population
          defaults" of
          `06 - Handoff/03 — CANONICAL_CONFIG_AND_WORLD_GENERATION.md` states the
          baseline values, and `HANDOFF-REPAIR-005` / `HANDOFF-REPAIR-010` establish
          Handoff/03 as the sole owner of `SimulationConfig` baseline numbers.

          The two lists speak different vocabularies. Section 8 of Handoff/03 is largely a
          demography baseline — births, deaths, aging, migration, mobility, cohort-merge
          tolerances — which REQ-CONFIG-007's own `STATEMENT` defers to M8 and which
          `EXECUTION_ORDER.md` puts there too. Of its non-demographic entries,
          `consumptionBudgetShareLower/Middle/Upper`, `precautionaryCashFloorMonths`,
          `needSubstitutionElasticity` and `healthEmaAlpha` have no counterpart among the
          controls sections 4-11 name, and sixteen of the twenty M4 controls have no value
          anywhere. The sixteen left undefaulted are:

          Liquidity floor (section 4) — `minHouseholdCashPerCapita`,
          `liquidityFloorShare`.

          Participation (section 8) — `baseParticipationByStratum`, `minParticipation`,
          `maxParticipation`, `minWeakOpportunityFactor`, `maxWeakOpportunityFactor`.

          Wage signal (section 9) — `maxWageSignalStep`.

          Welfare signals (section 10) — `essentialAlpha`, `incomeAlpha`,
          `employmentAlpha`, `scenarioRealIncomeScale`.

          Health stock (section 11) — `healthRecoveryRate`,
          `healthMaintenanceThreshold`, `serviceHealthRate`, `serviceBaseline`.

          Four controls were valued, and the reasoning for each is recorded so it can be
          overruled cheaply:

          - `minHealthParticipationFactor = 0.75`, `maxHealthParticipationFactor = 1.02`
            from section 8 of Handoff/06 itself, "Recommended healthParticipationFactor
            range [0.75,1.02]". `HANDOFF-REPAIR-M4-002` promoted Handoff/05
            recommendations "where exact", which is the precedent applied here.
          - `wageSignalAdjustmentSpeed = 0.20` ← section 8 `wageSignalAlpha`. The section
            9 update `wageSignal × exp(speed × ln(target/wageSignal))` is a geometric EMA
            whose smoothing factor is that coefficient, and neither section declares a
            second wage-signal smoothing control, so the correspondence is forced.
          - `prosperityAlpha = 0.15` ← section 8 `prosperityEmaAlpha`. Spelling only; no
            other prosperity smoothing control exists in either document.

          Three further divergences were **not** mapped, because mapping them would invent
          a semantic rather than resolve a spelling — the `maxLogWageStep` precedent from
          Q-001:

          - Section 4 `liquidityFloorShare` (a share of opening home cash) versus section
            8 `precautionaryCashFloorMonths = 0.25` (a number of months). Different
            quantities, and section 4's floor is `max(perCapita × population, share ×
            cash)`, which needs both of its own parameters.
          - Section 5 `priceSensitivity_c` (per need category, and section 5 requires
            ESSENTIAL_FOOD to differ from COMFORT) versus section 8
            `needSubstitutionElasticity = 0.60` (one global). A single global value
            contradicts the per-category requirement in the same breath.
          - Section 8 `healthEmaAlpha = 0.20` has no counterpart: section 11's health
            update is not an EMA, and section 10's four alphas are all named.

          Tried: the reading order of `AUTHOR_RUNBOOK.md` section 4 — registry,
          `SPEC_CHANGELOG.md`, `EXECUTION_ORDER.md`, section 33 and the sections of
          Handoff/06 that state each control, then the one dependency document
          (Handoff/03). The mirror was not read recursively. No third document was opened.

Options:  1. Section 8 of Handoff/03 gains the missing values under the section 4/8/9/10/11
             spelling. REQ-CONFIG-007 then closes as IMPLEMENTED by adding defaults only,
             and no economic mechanism moves.
          2. Section 33's M4 list is reconciled down to what section 8 already values, and
             the unvalued controls are withdrawn as not-M4. Cheaper, but
             REQ-POPULATION-001..003 would have to be re-scoped, and section 4's liquidity
             floor and section 11's health stock have no formula left without them.
          3. The values are left for the requirement that first reads each control. This
             spreads default authority across four rows and reopens the duplicate-owner
             problem `HANDOFF-REPAIR-005` and `-010` were written to close. Not
             recommended.

          Two questions need an explicit answer whichever option is chosen:

          - **Does `baseParticipationByStratum` supersede `LaborConfig.baselineParticipationRate`?**
            Section 8 of Handoff/06 needs participation per stratum
            (`baseParticipation[stratum]`, strata VULNERABLE / WORKING_MIDDLE / AFFLUENT);
            section 7 of Handoff/03 states one scalar `baselineParticipationRate = 0.70 of
            WORKING population`, which #528 landed on `LaborConfig` from section 37 of
            Handoff/05 — a section that itself offered "or a Population-owned reference".
            One value under two owners is exactly what `HANDOFF-REPAIR-010` forbids. This
            run declared the stratum map and left it undefined rather than pick; nothing
            reads either control yet, so the choice is still free.
          - **Is `LaborConfig`'s working-health-factor clamp the same thing as section 8's
            `healthParticipationFactor` bound?** This run read them as distinct — section
            11 of Handoff/06 says health "may feed the already bounded Production
            `healthLaborProductivityFactor`", a productivity factor, while section 8's
            factor scales participation, and the two stated ranges differ ([0.5, 1.05]
            versus [0.75, 1.02]). If they are meant to be one control, the second pair
            should be withdrawn.

          Separately, section 9 `workerEpsilon` was deliberately **not** declared, on the
          Q-001 reading: workers are measured in worker-equivalents, a quantity, and
          `SimulationConfig.numeric.quantityEpsilon` already owns that tolerance. The
          section 10 `P_raw` weights (0.35 / 0.25 / 0.15 / 0.20 / 0.05) were read as
          formula constants rather than configuration, because section 33 does not list
          them among what `PopulationConfig` centralizes, they must sum to 1.0, and section
          33's "Scenario files may override values but may not introduce new bespoke
          formulas without schema version change" is what a scenario-tunable weight vector
          would defeat. If either reading is wrong, it needs saying here.

          Implemented in the meantime: every M4-subset control section 33 names is declared
          and validated, the four above carry their value, and the other sixteen are left
          `undefined` rather than guessed. A test asserts each of them is absent, so filling
          one in without answering this question fails the build. A second test asserts the
          deferred M8 demography/migration/mobility controls are absent, so pulling them
          forward fails the build too.

Answer:   —
