# Calendar projection architecture decision

Status: optional manual Google integration, beta; live OAuth/API/UI verification is blocked pending a user-owned Desktop OAuth client and normal account-owner consent. Research checked **2026-10-17**. Implementation tests and Google account tests are different evidence levels.

## Decision and boundary

Keep SQLite and the existing core schema canonical. Add isolated Google modules and `integration google` commands. Local `calendar` commands retain their commitment semantics. The CLI still needs no model or hosted backend; core commands remain offline. Only explicitly invoked Google operations use the network. The integration never decides when a task should be scheduled.

```text
Agent or human → local CLI → operational SQLite
                         ↓ explicit approved sync
                 deterministic projection → Google API
                                              ↓
                                Google / Notion Calendar view
```

Manual one-way projection is the smallest useful boundary. Bidirectional editing would introduce competing scheduling authority and an import/conflict model; a daemon/webhook service would violate the current deployment goal. ICS export is deferred because it does not solve reliable update, drift, or remote ownership. No Notion API is required: its [Calendar product](https://www.notion.com/product/calendar) supports connected Google accounts; actual rendering remains to be inspected live.

## Authorization and secrets

Use a user-owned Desktop OAuth client, system browser, PKCE S256, random state with callback validation, and a temporary IPv4 loopback listener. Do not implement deprecated out-of-band token paste. Google documents Desktop clients as public clients; the downloaded client secret is not a security boundary. Tokens are never printed. See [Desktop flow](https://developers.google.com/identity/protocols/oauth2/native-app).

The primary scope is `calendar.app.created`, allowing secondary calendars created by the app and their events. [Calendars.insert](https://developers.google.com/workspace/calendar/api/v3/reference/calendars/insert) and the [events methods](https://developers.google.com/workspace/calendar/api/v3/reference/events) list this scope. Do not infer compatibility from examples using the broader `calendar` scope. Store returned calendar IDs locally; do not request CalendarList access merely to discover all personal calendars. `calendars` reports the known managed IDs, not a user's full calendar list.

Optional `calendar.events.freebusy` is listed by [Freebusy.query](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query), supports selected IDs and intervals, and does not expose titles. Exclude managed calendar IDs when checking external availability to avoid counting local projections twice. Individual calendar errors are incomplete evidence, not available time. No email/profile scope is requested; browser consent is the place to verify the account, and local status cannot prove account identity. See the [scope reference](https://developers.google.com/workspace/calendar/api/auth).

Keep client config, tokens, projection preferences, mappings, and calendar IDs in `~/.syntrop-google/<absolute-workspace-path-hash>/`, separate from workspace data. Existing backup recursively copies non-database workspace files; putting secrets inside the workspace would leak them into normal backups. Use owned directories `0700`, files `0600`, refuse unsafe path types, and avoid logging raw upstream payloads. This is restricted local storage, not encrypted OS-keychain storage. Disconnect removes tokens, optionally attempts revocation, and never deletes records or calendars. A standard workspace backup does not restore Google credentials or remote mappings.

**Library decision:** Google's OAuth overview explicitly recommends established libraries. Considered `google-auth-library` for token exchange/refresh and the full `googleapis` client. Node 24's crypto, HTTP server, fetch, and browser launcher can implement this narrow Desktop flow without a generated API client or runtime dependency. Retaining built-ins accepts responsibility for nonce/state, PKCE, callback lifecycle, scope checks, refresh rotation, safe errors, timeouts, and revocation tests. Dependency count alone is not a security argument; adversarial authentication review remains a code release gate, and real consent is required before claiming live verification. A beta may disclose the user-dependent live-test blocker, as required by the release checklist; it must not claim production readiness. Revisit a maintained OAuth library if the supported flows expand. See [Google's OAuth guidance](https://developers.google.com/identity/protocols/oauth2).

## Projection contract

| Source | Destination / representation | Rule |
| --- | --- | --- |
| Work session | Focus / ordinary timed event | One stable ID per session, busy, workspace timezone |
| Local commitment | Focus / ordinary timed event | Optional projection; explicitly exclude external duplicates |
| Task deadline | Focus / all-day transparent marker | Optional; workspace date, exclusive next-day end |
| Unscheduled task without deadline | No event | Never invent a date from an estimate |
| Selected flexible habit | Habits / transparent all-day recurrence | No invented work time; weekly marker is a goal reminder |
| Selected timed habit | Habits / timed busy recurrence | Explicit time, duration, and weekly day choices |

Create **Syntrop · Focus** and **Syntrop · Habits** only during approved sync. No ACL sharing is added. Event visibility is private; that does not override access already granted by an account owner. Default titles are redacted, notes are excluded, descriptions contain only concise local references, and reminders explicitly disable inherited defaults. Plain titles and optional notifications require configuration. A Google reminder never becomes a Syntrop habit log.

Native RRULE series avoid hundreds of separate reminders. Keep a stable series anchor across sync windows. Daily is daily; a weekly target count is not a set of weekdays. Flexible weekly mode anchors to the Monday of the selected start-date week and spans seven transparent all-day dates; timed weekly mode requires explicit weekdays. Timed recurrence carries an IANA timezone so local clock time survives DST. Recurrence changes update the entire series, including historical recurrence patterns; deactivation/removal must end future reminders without deleting history. Google warns against editing every instance to change a series; see [recurrence guidance](https://developers.google.com/workspace/calendar/api/guides/recurringevents). Ambiguous or nonexistent local clock times require explicit handling, not a guessed offset.

Completed/cancelled tasks remove future deadline markers. Cancelled sessions and commitments remove future projections. Past records remain historical; sync is not a history import. Range bounds select ordinary dated events, while a selected recurring series extends beyond that range. Preview must make this series-wide effect visible. [Event fields](https://developers.google.com/workspace/calendar/api/v3/reference/events) distinguish date/dateTime, transparency, recurrence, and exclusive end.

Categories use a restrained mapping: career blue (9), OSS purple (3), learning cyan (7), review graphite (8), default lavender (1). Derive categories only from explicit local projection configuration. Google `colorId` is a palette ID, not arbitrary hex. [Colors.get](https://developers.google.com/workspace/calendar/api/v3/reference/colors/get) supports `calendar.app.created`; use returned event definitions and fall back to the calendar default if a configured ID is unavailable. Calendar and event palettes are separate. Client apps may render colors differently; do not claim UI verification from payload tests.

## Reconciliation and concurrency

The projection is identified by workspace identity, entity type, and stable source ID. Hashes produce valid deterministic event IDs using Google's permitted character set. Private extended properties carry ownership and projection fingerprint; local mappings are a cache and checkpoint, not sole ownership evidence. Fetch all pages of the managed calendars, including recurring masters and relevant tombstones. Never infer ownership from title. Compare remote owned fields against the last accepted projection; manual changes/deletion require an explicit conflict decision. Pagination follows `nextPageToken` even when a page is empty; recurring masters are retained with `singleEvents=false`, per [Events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list). See [event creation/idempotency](https://developers.google.com/workspace/calendar/api/guides/create-events) and [private properties](https://developers.google.com/workspace/calendar/api/guides/extended-properties).

An authenticated preview reads local state and Google events and returns the complete plan plus approval hash. It does not mutate Google calendars/events. Preview may refresh an access token over the network but keeps it only in memory, preserving zero local file mutations. Offline preview cannot detect remote drift and is not sufficient approval evidence. Sync re-reads state, checks the supplied hash, then creates/updates/retires only owned projections. Explicit `--resolve local` authorizes overwriting reviewed remote drift. Recurring-instance exceptions remain conflicts even with that flag, requiring resolution in Google. Use full event replacement (`PUT`) for changed owned projections so omitted color/start fields cannot survive a patch; use ETag `If-Match` on updates/deletes and stop on `412`; [resource versions](https://developers.google.com/workspace/calendar/api/guides/version-resources) describe this protection. There is no cross-service atomic transaction; partial success needs a fresh preview, not blind replay.

Deterministic insert IDs let an uncertain event-create response be checked before retry. Calendar insertion lacks an equivalent supplied deterministic ID: an uncertain result needs diagnosis, never an automatic duplicate calendar. Lost calendar IDs cannot be safely recovered by matching names. The explicit `recover --focus ID --habits ID` command reads calendar metadata and accepts only descriptions matching this workspace and role. Preserve the separate integration state. Deleted calendars, revoked scopes, and ownership mismatch stop remote writes rather than redirecting them into a personal calendar.

Use bounded exponential backoff for replay-safe HTTP 5xx/429/rate-limit responses, respect retry instructions, and report exhausted operations. Network failures are surfaced immediately because a write may already have committed; inspect a fresh preview before retrying. Do not retry authorization failures forever. See [API errors](https://developers.google.com/workspace/calendar/api/guides/errors) and [quotas](https://developers.google.com/workspace/calendar/api/guides/quota). Quotas are project/user and operational constraints, not a universal hardcoded request budget. Small manually synchronized calendars do not need a general incremental sync platform: paginated reads simplify conflict validation. If sync tokens are added later, an expired token (`410`) requires a full rescan, per [sync guidance](https://developers.google.com/workspace/calendar/api/guides/sync).

## Onboarding, test evidence, and release gate

The [setup guide](integrations/google-calendar.md) separates Cloud configuration, browser consent, local preferences, preview approval, and first publication. No account credentials are bundled. External Testing-mode Calendar refresh tokens expire after seven days; reconnect and explain this rather than claiming permanent authorization. Public distribution has verification and organizational policy constraints.

Verify five independent levels: pure mapping, mocked HTTP/OAuth behavior, fake-provider reconciliation, real account API smoke, and visible end-to-end Google/Notion workflow. A synthetic loopback callback verifies callback code, not Google's actual authorization behavior. A passing fake provider does not establish real scope compatibility or recurring-series display. In this run, user confirmed no Desktop client exists and requested setup instructions. **Real Google OAuth, live API smoke, and human-visible calendar QA remain NOT COMPLETED.**

Before declaring the integration fully verified, obtain normal consent and run a disposable synthetic workspace through calendar creation, event creation, repeated no-op sync, move, cancel, drift, recurrence, timezone, and optional free/busy. Verify returned remote IDs and inspect the actual calendar. Clean only resources created for that test. A beta publication must disclose the missing live evidence; any known critical authentication or synchronization defect blocks release. Do not represent implementation completion as production readiness.
