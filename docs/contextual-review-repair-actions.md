# Context-aware repair actions (issue #284)

The review portal displays historical alert evidence and newly verified provider objects separately. The **current repair context** lists the exact selected Todoist and Calendar IDs, their live status, mapping and recurrence role. A missing (404/410) Todoist task or a cancelled Calendar event has **unknown/unverifiable recurrence**; absence does not establish that it was one-off.

## Workflow

1. Open a case and inspect **Current repair context**. A previously recorded provider ID is read-only evidence, not authorization to repair or recreate it.
2. **Recheck items (no changes)** makes a fresh read. **Find existing item** lets you choose another exact live provider identity; a title match alone never authorizes a mutation. Search result selection is tied to the current case and ID.
3. **What would you like to do?** lists applicable common actions (Verify existing link, Link these existing items, Create missing counterpart, Keep separate / exclude). The collapsed **Advanced repairs** disclosure exposes only specialist actions with enough verified evidence. Nothing mutates by default.
4. **Why aren't other actions shown?** explains the missing preconditions without presenting misleading disabled options. For example, Flatten requires a live recurring source/active occurrence; Transfer requires a recurring Calendar master and suitable recurring Todoist task; Create requires exactly one verified unmapped source.
5. Select an operation, specify only its relevant details, and explicitly choose **Preview repair (no changes)**. Review the exact proposed provider effects, mappings, recurrence scope, and warnings, then independently choose **Apply repair**.
6. **Run reconciliation** scans the whole selected profile and is not equivalent to one-case repair. **Dismiss alert only** hides the alert without proving provider or mapping repair.

## Safety and stale data

The browser's capability list is deliberately conservative and only a usability hint. It uses exact-profile and exact-ID verified snapshots; recurrence masters and occurrences are distinct. Mapping, ownership and pending repair controls can withhold dangerous options. Updating the selected item or fetching changed live data revokes an ineligible action, its preview, owner/scope/winner settings and old dispositions, **without substituting another action**. A new action always requires explicit selection.

The backend remains authoritative: preview validates live provider objects, mapping/control versions, recurrence preconditions and current decision status, and applying an approved preview rechecks the frozen snapshots and guarded write conditions. The UI cannot authorize a repair by hiding or showing an option.

Accessibility: both common and Advanced action pickers are native keyboard-accessible selects, with labelled fields and a readable help disclosure. Changes in availability clear an invalid selection and report a status notice rather than silently changing which operation would execute.

No local action-capability evaluation, case opening, search or recheck performs a Todoist/Calendar or mapping mutation. Provider changes occur only through the existing explicit approved-preview/apply process.
