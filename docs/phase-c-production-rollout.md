# Native Calendar recurrence

Calendar to Todoist native recurrence admission runs as part of ordinary sync;
there is no production feature flag. A series is admitted only when its rule,
bounded occurrence inventory, timezone interpretation, and Todoist readback all
prove equivalent cadence and the stable task identity.

The current exact conversion families include multiple weekdays, multiple
month days, alternating weekdays, and simple month intervals. Provider
normalization and local date/time checks are required before linking the native
Todoist task. Explicit exceptions must be inventoried within a bounded window.

Rules with different provider semantics remain unchanged at the source and
produce a non-blocking unsupported outcome. In particular, Todoist's monthly
29/30/31 cadence can advance to February 28, while RFC 5545 skips February for
those month days; that rule is not projected as an approximate Calendar
series. Existing mirrors of unsupported rules are preserved.

The local recurrence tests cover normalized weekdays/month days, intervals,
DST wall-clock conversion, exception rejection, and month-end divergence.
Production acceptance for this issue still requires the deployed-worker live
suite and machine-generated evidence described in issue #510.
