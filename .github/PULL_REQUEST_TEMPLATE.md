<!--
A pull request body is a handoff record. It must stand alone: a reviewer with no
access to the originating session decides from this text plus the diff.
Delete nothing. If a section does not apply, say why.
-->

Closes #

## Achieved outcome

<!-- What is now true that was not true before. One paragraph, no narration. -->

## Tested revision

<!-- The commit SHA the checks below actually ran against. -->

## Changed artifacts

<!-- Files or areas, and what each change does. -->

## Acceptance criteria

<!-- Copy each criterion from the Issue and mark its status with evidence. -->

- [ ]

## Checks

| Check | Outcome | Evidence |
| --- | --- | --- |
| `dotnet build --configuration Release` | | |
| `dotnet test --configuration Release` | | |

Outcome is exactly one of `passed`, `failed`, `not_run`, `unavailable`.
`not_run` and `unavailable` require a reason and the risk they leave open.

## Not checked

<!-- What was deliberately or unavoidably not verified, and the residual risk. -->

## Assumptions and unknowns

<!-- Separate established facts from inference. Confidence does not make an
assumption a fact. -->

## Highest-risk area for review

<!-- Where a reviewer should look first, and why. -->

## Remaining gate

<!-- Any decision, authority, or follow-up still required — or an explicit statement
that no mandatory work remains. Discovered work belongs in a linked Issue, not here. -->
