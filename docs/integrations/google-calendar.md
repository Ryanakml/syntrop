# Google Calendar integration (beta)

Syntrop keeps the schedule locally and publishes an approved projection into two Google calendars: **Syntrop · Focus** and **Syntrop · Habits**. Core task, scheduling, habit, review, backup, and validation commands work offline. Sync is manual and one way; Google edits are conflicts to review, not changes imported into Syntrop.

**Live Google test not completed:** the implementation has no account-owner OAuth client or consent yet. Offline tests do not verify Google's consent screen, the actual granted permissions, or the displayed calendar. Complete the setup below before attempting live verification. This limitation is a release-readiness concern, not a production-readiness claim.

## Quick start

Use Node 24 and run `npm ci` in the repository. Examples use `node src/cli.ts`; an installed `syntrop` command is equivalent. Add `--workspace /absolute/path` before `integration` to select a workspace other than `~/.syntrop`. Use the same workspace for every step.

1. Follow **Create your Google OAuth client** below. Keep its JSON file outside the repository and Syntrop workspace.
2. Register that local file, then connect through your normal browser:

   ```sh
   node src/cli.ts integration google setup --client /absolute/path/desktop-client.json
   node src/cli.ts integration google connect
   node src/cli.ts integration google status
   ```

3. Choose what to publish. Titles are redacted by default; explicitly opt in to readable task/habit titles if suitable for your calendar:

   ```sh
   node src/cli.ts integration google configure --title-mode titles --deadlines true --commitments true
   node src/cli.ts integration google habit --id HABIT_ID --mode flexible --start-date 2026-10-17
   ```

   Habit publication and deadline markers are off by default; local commitments are included by default. Habit selection is per habit. Replace `HABIT_ID` using `habit list`; these are examples, not records to copy into your workspace.
4. Read the preview. It reads Google state but creates no calendars or events. Replace the dates with your intended inclusive range (1–90 days; default today through six days later):

   ```sh
   node src/cli.ts --json integration google preview --from 2026-10-17 --through 2026-10-23
   ```

5. Inspect the exact titles, dates, creates, updates, removals, and conflicts. Only after approving them, use the returned approval hash with the **same date range**:

   ```sh
   node src/cli.ts --json integration google sync --from 2026-10-17 --through 2026-10-23 --approve PLAN_HASH
   ```

   Replace `PLAN_HASH` with the actual preview hash. Sync checks fresh local and remote state; a changed plan needs a new preview and approval. The first approved sync creates each dedicated calendar when it has events to publish. Connecting alone uploads no schedule.
6. Open Google Calendar using the Google account you selected during consent. Show both Syntrop calendars in the calendar list. On mobile, enable those calendars in the menu; app refresh/sync can take time. In Notion Calendar, connect the same Google account and enable those calendars. There is no separate Syntrop-to-Notion API or Notion credential requirement.

Authenticated preview makes zero local file or remote calendar mutations; a refreshed access token is used only in memory. An offline preview is available with `preview --offline`. It shows intended local representations, cannot detect Google edits, and cannot authorize a remote sync.

## Create your Google OAuth client

You create this once for a personal installation. You need a Google account with access to [Google Cloud Console](https://console.cloud.google.com/). Workspace administrators may restrict project creation or OAuth access.

1. In the project selector at the top, select your project or choose **New project**. A name such as `Syntrop personal` is sufficient; select the created project before continuing.
2. Open **APIs & Services → Library**, search **Google Calendar API**, open it, and select **Enable**. If already enabled, no change is needed.
3. Open **Google Auth platform → Branding**. If shown, select **Get Started**. Enter an app name (for example `Syntrop personal`), your support email, and contact email. Choose **External** for a personal Google account. **Internal** is only appropriate for an eligible Workspace organization. Finish the required policy acknowledgement. Existing projects may label this area **OAuth consent screen** instead.
4. Under **Google Auth platform → Audience**, leave a personal test installation in **Testing** and use **Test users → Add users** to add the exact Google email you will use during connection. Save. Organizational policy may require administrator help.
5. Under **Data Access → Add or remove scopes**, add `https://www.googleapis.com/auth/calendar.app.created`. Optionally add `https://www.googleapis.com/auth/calendar.events.freebusy` only if you want external availability. Save. Do not substitute full Calendar or event-reading scopes. These choices match the [scope contract](https://developers.google.com/workspace/calendar/api/auth).
6. Open **Google Auth platform → Clients → Create client**. Select application type **Desktop app**, give it a name, and select **Create**. Download the client JSON. Some console versions expose the equivalent action under **APIs & Services → Credentials → Create credentials → OAuth client ID**. Do not create a Web application or service account. The Desktop flow uses a temporary loopback listener; no hosted redirect URL is needed.
7. Store the JSON in a private directory outside this repository and your Syntrop workspace, then run `setup --client` from the quick start. Keep the downloaded original private too. Never paste its contents, authorization codes, access tokens, or refresh tokens into chat, issues, screenshots, or terminal logs.

These menu labels follow [Google's consent setup guide](https://developers.google.com/workspace/guides/configure-oauth-consent) and [Desktop OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app), checked 2026-10-17. Console labels can vary by account and rollout; use the equivalent Branding, Audience, Data Access, and Desktop client pages.

## Consent, account choice, and token lifetime

`connect` opens the system browser, uses PKCE S256 plus a fresh state value, and receives Google's callback on `127.0.0.1` at a temporary port. Keep the terminal running until it completes. No passwords or tokens are entered into Syntrop. Browser consent shows the selected account; verify it there. Local `status` does not independently verify account email or current remote access: Syntrop requests no identity/profile scopes.

Default permission is `calendar.app.created`, for secondary calendars created by the app. Existing personal calendar events are not read. `connect --freebusy` requests that permission **plus** `calendar.events.freebusy`; installed-app scope changes require a new consent flow rather than an assumed silent upgrade. The optional permission reveals occupied intervals, not event titles or descriptions.

Google may show an unverified-app warning for your own test client. Check the project/client and account before continuing; organization policy can prohibit it. Public distribution and production consent have separate Google verification rules. Publishing status is not the same as successful verification; this guide does not promise unrestricted use of an unverified shared client.

An External app in Testing normally receives refresh tokens that expire after **seven days** for these Calendar scopes. Reconnect when required. Tokens can also become invalid after revocation, inactivity, token limits, or admin policy changes. Moving a client to Production is a deliberate Google Cloud decision that may require verification, not a Syntrop fix for expiry. See [Google's token lifecycle guidance](https://developers.google.com/identity/protocols/oauth2).

## What appears on the calendar

| Local record | Projection | Availability |
| --- | --- | --- |
| Scheduled work session | Timed event in Focus; separate event per session | Busy |
| Selected local calendar commitment | Timed event in Focus | Busy |
| Optional task deadline | All-day marker in Focus, date derived in workspace timezone | Free |
| Task without session/deadline | Nothing | No invented appointment |
| Habit mode `none` | Nothing; default for unselected habits | No effect |
| Habit mode `flexible` | Native all-day recurring reminder in Habits | Free |
| Habit mode `timed` | Native recurring event at explicitly configured time/duration | Busy |

All-day ends are exclusive: a marker for October 23 ends October 24. Deadlines never reserve the estimated task duration. Completed/cancelled tasks lose future deadline markers; previous markers remain history. Cancelled future sessions/commitments are removed from the projection on the next approved sync. Existing meetings on another calendar are not automatically imported or deduplicated by title; exclude their local copies before publishing to avoid a second visual copy:

```sh
node src/cli.ts integration google configure --exclude-commitments COMMITMENT_ID,OTHER_ID
```

This option replaces the entire exclusion list; an empty string clears it. It changes projection settings, not local commitments.

Daily flexible reminders need a start date, not a clock time. Timed habits additionally need `--time HH:MM --duration MINUTES`. Weekly timed habits need explicit `--weekdays MO,TU`; a weekly target count alone does not choose weekdays. Flexible weekly reminders occupy an all-day week strip from Monday through Sunday, transparently; the configured start date selects that week. They express a weekly goal, not a promise to perform it on a particular day. Changing recurrence updates its managed series, including its historical pattern; do not use Google to record habit completion. `habit log` remains the only tracking record. Habit deactivation or mode `none` stops future reminders while preserving past occurrences according to sync's retirement policy.

Events are private and descriptions contain concise local references, not task notes, journal entries, or knowledge files. Redacted titles still reveal schedule timing and type. `--title-mode titles` sends selected record titles to Google and any viewers with access to those calendars. Avoid sharing those calendars if the information is private. Reminders are disabled by default rather than inheriting Google defaults, preventing duplicate notifications. Event colors indicate configured project categories; frontends can render colors differently. To configure them, create a private JSON file mapping existing project IDs to `career`, `oss`, `learning`, `review`, or `default`, then run `configure --categories /absolute/path/categories.json`. This replaces the category mapping. `integration google colors` reads Google's supported palettes; `integration google calendars` shows only locally registered managed calendar IDs.

## Preview, drift, and recovery

Run preview before each sync. Sync owns only events marked with this workspace's identity in the two managed calendars. It never edits an unrelated event just because its title matches. Moving a local session updates the same remote ID. Previously managed records remain reconciled if moved outside the selected date window; the range bounds initial publication, not cancellation/update ownership. Deterministic IDs and private ownership metadata allow recovery when local mapping entries are lost; preserve the integration state directory and client identity.

External edits and deleted events are reported as drift. Review them before choosing local authority with `preview --resolve local`, then approve that new plan using `sync --resolve local --approve PLAN_HASH` with the same dates. This explicitly restores the local projection; it does not import the Google edit. Recurring-instance exceptions always require resolution in Google; `--resolve local` does not override them. Changed owned events are fully replaced with `PUT`; ETag conditions reject intervening remote edits. If a sync partly succeeds, inspect a new preview before retrying; operations are not one atomic transaction.

Do not delete integration state to fix a sync error. Lost calendar IDs cannot safely be rediscovered merely by calendar name under the narrow scope. Copy the actual ID from the intended calendar's Google settings, then recover the local registry:

```sh
node src/cli.ts integration google recover --focus FOCUS_CALENDAR_ID --habits HABITS_CALENDAR_ID
```

Supply only the roles that exist. Recovery reads metadata and accepts only calendars whose description carries this workspace's ownership marker; it creates no remote calendars. It is not a way to adopt a personal calendar. A missing managed calendar or an uncertain calendar-creation response needs diagnosis; blind retries could create another calendar. No background daemon, continuous sync, push subscription, broad personal-calendar import, or full bidirectional editing is provided.

## Optional external availability

Connect with `--freebusy`, then request a bounded interval using explicit offset timestamps:

```sh
node src/cli.ts integration google connect --freebusy
node src/cli.ts --json integration google availability --calendars primary --start 2026-10-19T09:00:00+07:00 --end 2026-10-19T18:00:00+07:00
```

For another calendar, copy its Calendar ID from Google Calendar settings; comma-separate IDs with `--calendars`. The narrow default scope does not enumerate all personal calendars. The command rejects managed projection calendar IDs so their sessions are not counted twice. A returned error is unknown availability, not a free interval. This operation does not create sessions or alter Syntrop records.

## Storage and disconnect

Credentials, projection settings, managed calendar IDs, and reconciliation state live outside the operational workspace, under `~/.syntrop-google/<workspace-path-hash>/`. Directories use mode `0700`, files `0600`; local files are not OS-keychain encryption. Protect your user account and disk. Standard Syntrop workspace backups do not include this separate directory. Repository packaging must not include your downloaded client file. Moving/restoring a workspace to a different absolute path requires deliberate integration setup; ordinary operational backups are not credential backups.

```sh
node src/cli.ts integration google disconnect
node src/cli.ts integration google disconnect --revoke
```

Default disconnect removes local tokens. `--revoke` also attempts Google revocation and reports failures. Neither command deletes local operational records or remote calendars/events. To remove remote projections, review/delete only the dedicated Syntrop calendars in Google Calendar yourself. Reconnecting a different account should use a deliberately separate integration/workspace; do not reuse old managed calendar IDs blindly.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| API disabled / access not configured | Enable Google Calendar API in the same Cloud project as the downloaded client. |
| Access denied / not an approved tester | Add the exact browser account under Audience → Test users; check Workspace admin policy. |
| Invalid client / redirect mismatch | Download a **Desktop app** client JSON from that project and rerun setup; Web clients use a different flow. |
| Browser callback fails / times out | Keep CLI running locally, allow browser access to loopback, retry connect; remote/headless SSH is not the supported onboarding flow. |
| Wrong Google account | Check the account in browser consent. Disconnect and reconnect deliberately; status does not prove email. |
| `invalid_grant` / expired refresh token | Reconnect. Testing-mode seven-day expiry is expected; also check revocation/admin restrictions. |
| Missing scopes / permission denied | Reconnect with required permissions; use `--freebusy` only when needed. Inspect whether a managed calendar was deleted or access changed. |
| Missing managed calendar | Stop and inspect Google Calendar and local state. Do not substitute another personal calendar or blindly recreate all calendars. |
| Remote drift / precondition failure | Preview again, inspect the edit, explicitly choose local resolution only if appropriate. |
| Rate limit / quota | Wait and rerun preview. Retries are bounded; do not repeatedly recreate credentials or calendars. |
| Network/partial sync failure | No offline success is implied. Inspect the new preview to see which writes succeeded before retrying. |
| Duplicate event concern | Preserve mapping/config, preview ownership-marked events, and inspect IDs. Never remove unrelated events by title. |
| Calendar visible on web but not phone/Notion | Verify same account, show both calendars, refresh frontend; inspect web view first. |

## Live acceptance still required

Use a separate synthetic workspace and account-owner consent first. Verify real calendar creation, a session and habit series, repeat sync without duplicates, move/cancel, external edit detection, timezone, optional free/busy, and visible web/mobile rendering. Record exact command/API outcomes separately from UI inspection. Remove only disposable resources created for that test. Publish real schedules only after reviewing their actual projected titles/counts and obtaining permission. See [technical design and research](../calendar-design.md).
