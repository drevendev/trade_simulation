\# SPEC\_CHANGELOG

Append-only. Semantic requirement changes only; wording-only cleanup may be omitted unless it changes navigation anchors.

| DATE | REVISION | REQ\_ID | CHANGE | REASON |  
| \--- | \--- | \--- | \--- | \--- |  
| 2026-09-03 | NAV-001 | REQ-SCOPE-001, REQ-SCOPE-002, REQ-MIGRATION-001..004, REQ-CORE-001..006, REQ-CONFIG-001..005, REQ-ACCEPTANCE-001..003 | Created permanent requirement IDs and bootstrapped the implementation registry for M0-M2. No economic mechanics changed. | Stateless AUTHOR/ACCEPTOR runs require direct requirement navigation and implementation-status evidence. |  
| 2026-09-03 | NAV-002 | — | Added SPEC\_INDEX.md, EXECUTION\_ORDER.md and ANSWERS\_TO\_IMPLEMENTER.md. Added the repository feedback-channel and no-silent-semantic-change rules to PROJECT\_MANIFEST and handoff copy 99\. | Establish a bidirectional file-based protocol between researcher/QA and implementation agents. |  
| 2026-09-03 | MIRROR-001 | — | Defined the public mirror allowlist as the root control layer plus 06 \- Handoff only; explicitly excluded research, drafts, reports, canonical working copies and STATE\_AND\_QUEUE. | Public repository should receive only implementation authority, not research history or operational/private material. |

Rule: a future semantic change to an existing REQ\_ID must append a row here before or together with the canonical document update. IDs are never renumbered or reused. Retired requirements remain in REQUIREMENTS\_REGISTRY.csv with STATUS=RETIRED.

| 2026-09-03 | RUNTIME-001 | REQ-MIGRATION-003 and M1-M11 execution boundary | Resolved conflicting C\#-versus-browser wording: M0 freezes .NET 9 legacy; M1+ canonical engine is TypeScript/browser-capable; C\# remains a golden/reference oracle; M11 adds Worker/UI around the same engine rather than porting it. | Prevent duplicate implementation of canonical economics in C\# followed by a second TypeScript rewrite. |

2026-09-03 | UI\_UX\_QA\_09 | REQ-VISUALIZATION-001 added/FROZEN | Clarified active-selection invalidation under retention: detail-only eviction preserves aggregate T; evicted compare baseline B remains visibly unavailable with deltas disabled; loss of aggregate T shows an unavailable selected-tick state and never silently substitutes another tick. Added visualization test 47 and matching history acceptance. No economic mechanic changed.  
