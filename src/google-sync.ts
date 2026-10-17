import { createHash } from 'node:crypto';
import { LifeError } from './db.ts';
import { addDays, dateKey, localDate } from './time.ts';
import {
  COLORS,
  desiredCalendarLabels,
  eventFingerprint,
  eventIdentity,
  labelIdentity,
  nearestColorId,
  projectEvents,
} from './google-projection.ts';
import type {
  GoogleEvent,
  GoogleEventLabel,
  GoogleTransport,
  Projection,
  ProjectionConfig,
  Snapshot,
} from './google-types.ts';

export type CalendarRole = 'focus' | 'habits';
export type CalendarRegistry = {
  workspaceId: string;
  focus?: string;
  habits?: string;
  pending?: CalendarRole;
  labelCapability?: 'supported' | 'unsupported';
  labels?: Record<string, GoogleEventLabel>;
};
export type Mapping = {
  calendarId: string;
  eventId: string;
  hash: string;
  etag?: string;
  sourceVersion: number;
  lastSync: string;
  stopped?: boolean;
};
export type MappingState = Record<string, Mapping>;
export type SyncAction = {
  kind: 'create' | 'update' | 'cancel' | 'unchanged' | 'conflict' | 'skip';
  key: string;
  calendar: CalendarRole;
  remoteId?: string;
  etag?: string;
  event?: GoogleEvent;
  reason?: string;
  sourceVersion?: number;
  stopped?: boolean;
};
export type SyncPlan = {
  from: string;
  through: string;
  approval: string;
  calendarsToCreate: CalendarRole[];
  actions: SyncAction[];
  summary: Record<string, number>;
  labelsToSync?: GoogleEventLabel[];
  labelMode?: 'custom-labels' | 'colorId-fallback' | 'palette';
};
const encoded = encodeURIComponent;
export const calendarPath = (id: string) => `/calendars/${encoded(id)}`;
export const eventPath = (calendar: string, event?: string) =>
  `${calendarPath(calendar)}/events${event ? `/${encoded(event)}` : ''}`;
const statusOf = (error: unknown) => Number((error as { status?: number }).status);
const owned = (event: GoogleEvent, workspace: string, key?: string) =>
  event.extendedProperties?.private?.syntrop_workspace === workspace &&
  (!key || event.extendedProperties?.private?.syntrop_key === key);

export async function listEvents(
  provider: GoogleTransport,
  calendar: string,
): Promise<GoogleEvent[]> {
  const result: GoogleEvent[] = [];
  const seen = new Set<string>();
  let token = '';
  do {
    if (seen.has(token) || seen.size >= 100)
      throw new LifeError(
        'GOOGLE_PAGINATION',
        'Calendar pagination did not terminate within 100 pages',
      );
    seen.add(token);
    const query = new URLSearchParams({
      singleEvents: 'false',
      showDeleted: 'true',
      maxResults: '2500',
    });
    if (token) query.set('pageToken', token);
    const page = await provider.request<{ items?: GoogleEvent[]; nextPageToken?: string }>(
      'GET',
      `${eventPath(calendar)}?${query}`,
    );
    result.push(...(page.items ?? []));
    token = page.nextPageToken ?? '';
  } while (token);
  return result;
}

// Only the initial publication window is bounded. Previously managed records
// remain reconciled when moved outside that window; history is never swept.
function desiredForTracked(
  snapshot: Snapshot,
  config: ProjectionConfig,
  key: string,
  colors: Record<string, unknown>,
  activeLabelIds?: Record<string, string>,
): Projection | undefined {
  const [type, id] = key.split(':');
  const record =
    type === 'session'
      ? snapshot.work_sessions.find((r) => r.id === id)
      : type === 'commitment'
        ? snapshot.calendar_events.find((r) => r.id === id)
        : type === 'deadline'
          ? snapshot.tasks.find((r) => r.id === id)
          : undefined;
  if (!record) return undefined;
  const instant = String(type === 'deadline' ? (record.due_at ?? '') : (record.start_at ?? ''));
  if (!instant) return undefined;
  const date = localDate(instant, snapshot.timezone);
  return projectEvents(snapshot, config, date, addDays(date, 1), colors, activeLabelIds).find(
    (item) => item.key === key,
  );
}
function retired(snapshot: Snapshot, config: ProjectionConfig, key: string): boolean {
  const [type, id] = key.split(':');
  if (type === 'session') {
    const row = snapshot.work_sessions.find((r) => r.id === id);
    if (!row) return false;
    const task = snapshot.tasks.find((t) => t.id === row.task_id);
    const project = task?.project_id
      ? snapshot.projects.find((p) => p.id === task.project_id)
      : undefined;
    return (
      row.status === 'cancelled' ||
      !task ||
      ['done', 'cancelled'].includes(String(task.status)) ||
      Boolean(project && project.status !== 'active')
    );
  }
  if (type === 'commitment') {
    const row = snapshot.calendar_events.find((r) => r.id === id);
    return Boolean(
      row &&
      (row.status === 'cancelled' ||
        !config.commitments ||
        config.excludeCommitments.includes(id!)),
    );
  }
  if (type === 'deadline') {
    const row = snapshot.tasks.find((r) => r.id === id);
    return Boolean(
      row &&
      (!config.deadlines || !row.due_at || ['done', 'cancelled'].includes(String(row.status))),
    );
  }
  if (type === 'habit') {
    const row = snapshot.habits.find((r) => r.id === id);
    return Boolean(
      row &&
      (!row.active ||
        !config.habits[id!] ||
        config.habits[id!]?.mode === 'none' ||
        config.habits[id!]?.mode === 'tasks'),
    );
  }
  return false;
}
function unexpectedExtras(event: GoogleEvent): boolean {
  return Boolean(
    (Array.isArray(event.attendees) && event.attendees.length) ||
    event.location ||
    (Array.isArray(event.attachments) && event.attachments.length) ||
    event.conferenceData ||
    (event.eventType && event.eventType !== 'default'),
  );
}

/** Merge workspace-managed custom labels with any unrelated existing calendar labels. */
export function mergeCalendarLabels(
  existing: GoogleEventLabel[],
  wanted: Record<string, GoogleEventLabel>,
  workspaceId: string,
): GoogleEventLabel[] {
  const managedIds = new Set(Object.keys(wanted).map((key) => labelIdentity(workspaceId, key)));
  const preserved = existing.filter((item) => item.id && !managedIds.has(item.id));
  const merged = [...preserved, ...Object.values(wanted)];
  if (Object.keys(wanted).length > 25 || merged.length > 200)
    throw new LifeError('VALIDATION', 'Google Calendar supports at most 25 custom eventLabels');
  return merged;
}

function fallbackColorForKey(
  snapshot: Snapshot,
  config: ProjectionConfig,
  key: string,
  colors: Record<string, unknown>,
): string | undefined {
  const [type, id] = key.split(':');
  let labelKey = 'default';
  let fallback = COLORS.default!;
  if (type === 'session') {
    const session = snapshot.work_sessions.find((s) => String(s.id) === id);
    const task = session
      ? snapshot.tasks.find((t) => String(t.id) === String(session.task_id))
      : undefined;
    const projectId = task?.project_id ? String(task.project_id) : '';
    labelKey =
      (task ? config.presentation?.tasks?.[String(task.id)]?.label : undefined) ??
      config.presentation?.projects?.[projectId]?.label ??
      config.categories[projectId] ??
      config.presentation?.defaults?.sessionLabel ??
      'default';
  } else if (type === 'commitment') {
    labelKey = config.presentation?.defaults?.commitmentLabel ?? 'default';
  } else if (type === 'deadline') {
    labelKey = config.presentation?.defaults?.deadlineLabel ?? 'review';
    fallback = '8';
  } else if (type === 'habit') {
    labelKey =
      config.presentation?.habits?.[id!]?.label ??
      config.presentation?.defaults?.habitLabel ??
      'habit';
    fallback = '10';
  }
  const custom = config.presentation?.theme?.labels?.[labelKey];
  const colorId = custom
    ? (custom.colorId ?? nearestColorId(custom.color, colors))
    : (COLORS[labelKey] ?? fallback);
  return Object.hasOwn(colors, colorId) ? colorId : undefined;
}

export async function planSync(
  provider: GoogleTransport,
  snapshot: Snapshot,
  config: ProjectionConfig,
  registry: CalendarRegistry,
  mappings: MappingState,
  from: string,
  through: string,
  resolveLocal = false,
  now = new Date().toISOString(),
): Promise<SyncPlan> {
  if (registry.workspaceId !== config.workspaceId)
    throw new LifeError('CONFLICT', 'Calendar registry belongs to another workspace');
  if (registry.pending)
    throw new LifeError(
      'GOOGLE_RECOVERY',
      `Calendar creation result is uncertain for ${registry.pending}; recover its calendar ID before retrying`,
    );
  let colors: Record<string, unknown> = {};
  try {
    colors =
      (await provider.request<{ event?: Record<string, unknown> }>('GET', '/colors')).event ?? {};
  } catch (error) {
    if (![403, 404].includes(statusOf(error))) throw error;
  }

  const wantedLabels = desiredCalendarLabels(config);
  const hasCustomLabels = Object.keys(wantedLabels).length > 0;
  const useCustomLabels = hasCustomLabels && registry.labelCapability !== 'unsupported';
  const activeLabelIds = useCustomLabels
    ? Object.fromEntries(Object.entries(wantedLabels).map(([k, v]) => [k, v.id]))
    : undefined;

  const desired = new Map(
    projectEvents(snapshot, config, from, through, colors, activeLabelIds).map((item) => [
      item.key,
      item,
    ]),
  );
  const remoteByRole: Record<CalendarRole, GoogleEvent[]> = { focus: [], habits: [] };
  for (const role of ['focus', 'habits'] as const)
    if (registry[role]) remoteByRole[role] = await listEvents(provider, registry[role]!);
  const actions: SyncAction[] = [];
  for (const role of ['focus', 'habits'] as const) {
    const remotes = remoteByRole[role];
    const keys = new Set(
      [...desired.values()].filter((x) => x.calendar === role).map((x) => x.key),
    );
    for (const event of remotes)
      if (owned(event, config.workspaceId))
        keys.add(event.extendedProperties!.private!.syntrop_key!);
    for (const [key, map] of Object.entries(mappings))
      if (map.calendarId === registry[role]) keys.add(key);
    for (const key of [...keys].sort()) {
      const map = mappings[key];
      const matches = remotes.filter((e) => owned(e, config.workspaceId, key));
      const active = matches.filter((e) => e.status !== 'cancelled');
      const remote =
        active[0] ??
        matches.find((e) => e.id === map?.eventId) ??
        (map ? remotes.find((e) => e.id === map.eventId) : undefined) ??
        matches[0] ??
        remotes.find((e) => e.id === eventIdentity(config.workspaceId, key));
      let wanted = desired.get(key);
      if (!wanted && !key.startsWith('habit:'))
        wanted = desiredForTracked(snapshot, config, key, colors, activeLabelIds);
      const base: SyncAction = {
        kind: 'skip',
        key,
        calendar: role,
        remoteId: remote?.id ?? map?.eventId,
        etag: remote?.etag,
      };
      const exceptions = remote?.id ? remotes.some((e) => e.recurringEventId === remote.id) : false;
      if (active.length > 1 || exceptions) {
        actions.push({
          ...base,
          kind: 'conflict',
          reason:
            active.length > 1
              ? 'Multiple managed events share this source key'
              : 'Recurring instance was edited; resolve exceptions in Google before syncing this series',
        });
        continue;
      }
      if (remote && remote.status !== 'cancelled' && !owned(remote, config.workspaceId, key)) {
        actions.push({
          ...base,
          kind: 'conflict',
          reason: 'Remote identity is not owned by this workspace',
        });
        continue;
      }
      const baseline = map?.hash ?? remote?.extendedProperties?.private?.syntrop_hash;
      const drift =
        remote &&
        remote.status !== 'cancelled' &&
        ((baseline && eventFingerprint(remote) !== baseline) ||
          (map?.etag && remote.etag !== map.etag) ||
          unexpectedExtras(remote));
      if (drift && !resolveLocal) {
        actions.push({
          ...base,
          kind: 'conflict',
          reason:
            'Remote edit detected; preview with --resolve local only to explicitly restore local projection',
        });
        continue;
      }
      if (wanted) {
        const event = structuredClone(wanted.event);
        if (remote?.status === 'cancelled' || (!remote && map)) {
          if (!resolveLocal) {
            actions.push({
              ...base,
              kind: 'conflict',
              reason:
                'Managed event was deleted remotely; explicit --resolve local is required to recreate',
            });
            continue;
          }
          event.id = eventIdentity(
            config.workspaceId,
            `${key}:restore:${remote?.id ?? map!.eventId}`,
          );
          actions.push({
            ...base,
            kind: 'create',
            remoteId: undefined,
            etag: undefined,
            event,
            sourceVersion: wanted.sourceVersion,
          });
          continue;
        }
        if (!remote) {
          actions.push({ ...base, kind: 'create', event, sourceVersion: wanted.sourceVersion });
          continue;
        }
        event.id = remote.id;
        if (drift && resolveLocal) {
          event.attendees = [];
          event.location = '';
          event.attachments = [];
          event.conferenceData = null;
        }
        actions.push({
          ...base,
          kind:
            eventFingerprint(remote) === eventFingerprint(event) && !drift ? 'unchanged' : 'update',
          event,
          sourceVersion: wanted.sourceVersion,
        });
      } else if (remote && remote.status !== 'cancelled' && retired(snapshot, config, key)) {
        if (map?.stopped || remote.extendedProperties?.private?.syntrop_stopped === '1') {
          actions.push({ ...base, kind: 'unchanged', stopped: true, event: remote });
          continue;
        }
        if (remote.recurrence?.length) {
          const id = key.split(':')[1];
          const row = snapshot.habits.find((r) => r.id === id);
          const display = config.habits[id!];
          if (display?.mode === 'tasks' && display.startDate) {
            const taskStart = dateKey(display.startDate);
            const remoteStartDate = remote.start?.dateTime
              ? localDate(remote.start.dateTime, snapshot.timezone)
              : (remote.start?.date ?? taskStart);
            if (remoteStartDate >= taskStart) {
              actions.push({
                ...base,
                kind: 'cancel',
                reason:
                  'Habit migrated to native Google Tasks; no prior Calendar occurrences to preserve',
              });
              continue;
            }
            const dayBefore = addDays(taskStart, -1).replace(/-/g, '');
            const untilValue = remote.start?.date ? dayBefore : `${dayBefore}T235959Z`;
            const event = structuredClone(remote);
            event.recurrence = remote.recurrence
              .filter((r) => r.startsWith('RRULE:'))
              .map((r) => r.replace(/;(UNTIL|COUNT)=[^;]*/g, '') + `;UNTIL=${untilValue}`);
            event.extendedProperties = {
              private: { ...remote.extendedProperties?.private, syntrop_stopped: '1' },
            };
            event.extendedProperties.private!.syntrop_hash = eventFingerprint(event);
            actions.push({
              ...base,
              kind: 'update',
              event,
              stopped: true,
              reason:
                'Stop future Calendar habit reminders from task start date, preserve prior history',
            });
            continue;
          }
          const changed = !row?.active
            ? String(row?.updated_at ?? now)
            : ((display as { changedAt?: string } | undefined)?.changedAt ??
              String(row?.updated_at ?? now));
          const cutoff = new Date(
            Math.min(new Date(changed).getTime(), new Date(now).getTime()) - 1000,
          )
            .toISOString()
            .replace(/[-:]/g, '')
            .replace(/\.\d{3}Z$/, 'Z');
          const event = structuredClone(remote);
          if (
            (remote.start?.dateTime &&
              new Date(remote.start.dateTime).getTime() > new Date(changed).getTime()) ||
            (remote.start?.date && remote.start.date >= localDate(changed, snapshot.timezone))
          ) {
            actions.push({
              ...base,
              kind: 'cancel',
              reason: 'No historical occurrences to preserve',
            });
            continue;
          }
          event.recurrence = remote.recurrence
            .filter((r) => r.startsWith('RRULE:'))
            .map(
              (r) =>
                r.replace(/;(UNTIL|COUNT)=[^;]*/g, '') +
                `;UNTIL=${remote.start?.date ? localDate(changed, snapshot.timezone).replace(/-/g, '') : cutoff}`,
            );
          event.extendedProperties = {
            private: { ...remote.extendedProperties?.private, syntrop_stopped: '1' },
          };
          event.extendedProperties.private!.syntrop_hash = eventFingerprint(event);
          actions.push({
            ...base,
            kind: 'update',
            event,
            stopped: true,
            reason: 'Stop future habit reminders, preserve prior series history',
          });
        } else {
          const end =
            remote.end?.dateTime ?? (remote.end?.date ? `${remote.end.date}T00:00:00Z` : now);
          actions.push({
            ...base,
            kind: (
              remote.end?.date
                ? remote.end.date > localDate(now, snapshot.timezone)
                : new Date(end).getTime() > new Date(now).getTime()
            )
              ? 'cancel'
              : 'skip',
            reason: (
              remote.end?.date
                ? remote.end.date > localDate(now, snapshot.timezone)
                : new Date(end).getTime() > new Date(now).getTime()
            )
              ? 'Local lifecycle/configuration removed future projection'
              : 'Past history retained',
          });
        }
      } else
        actions.push({
          ...base,
          kind: 'skip',
          reason: 'Outside current publication scope, absent local source, or retained history',
        });
    }
  }
  const calendarsToCreate = (['focus', 'habits'] as const).filter(
    (role) => !registry[role] && actions.some((a) => a.calendar === role && a.kind === 'create'),
  );
  const summary = Object.fromEntries(
    ['create', 'update', 'cancel', 'unchanged', 'skip', 'conflict'].map((kind) => [
      kind,
      actions.filter((a) => a.kind === kind).length,
    ]),
  );
  const approval = createHash('sha256')
    .update(JSON.stringify({ from, through, registry, config, actions, calendarsToCreate }))
    .digest('hex');
  return {
    from,
    through,
    approval,
    calendarsToCreate: [...calendarsToCreate],
    actions,
    summary,
    ...(hasCustomLabels
      ? {
          labelsToSync: Object.values(wantedLabels),
          labelMode: useCustomLabels ? 'custom-labels' : 'colorId-fallback',
        }
      : {}),
  };
}

export async function applySync(
  provider: GoogleTransport,
  plan: SyncPlan,
  registry: CalendarRegistry,
  mappings: MappingState,
  timezone: string,
  saveRegistry: (value: CalendarRegistry) => void,
  saveMappings: (value: MappingState) => void,
  options: { snapshot?: Snapshot; config?: ProjectionConfig; skipHabitRetire?: boolean } = {},
): Promise<Record<string, unknown>> {
  const summary = {
    created: 0,
    updated: 0,
    cancelled: 0,
    unchanged: 0,
    skipped: 0,
    conflicted: 0,
    failed: 0,
  };
  const failures: { key: string; code: string }[] = [];
  for (const role of plan.calendarsToCreate) {
    registry.pending = role;
    saveRegistry(registry);
    const calendar = await provider.request<{ id: string }>('POST', '/calendars', {
      summary: `Syntrop · ${role === 'focus' ? 'Focus' : 'Habits'}`,
      description: `Syntrop managed projection ${registry.workspaceId} ${role}`,
      timeZone: timezone,
    });
    if (!calendar.id)
      throw new LifeError(
        'GOOGLE_RECOVERY',
        'Calendar creation response has no ID; inspect Google Calendar settings before recovery',
      );
    registry[role] = calendar.id;
    delete registry.pending;
    saveRegistry(registry);
  }

  let colors: Record<string, unknown> = {};
  const wantedLabels = options.config ? desiredCalendarLabels(options.config) : {};
  let labelFallbackActive = registry.labelCapability === 'unsupported';

  if (Object.keys(wantedLabels).length > 0 && registry.focus) {
    try {
      colors =
        (await provider.request<{ event?: Record<string, unknown> }>('GET', '/colors')).event ?? {};
    } catch {
      /* ignore optional palette fetch failure during fallback preparation */
    }
    const labelsUnchanged =
      registry.labelCapability === 'supported' &&
      JSON.stringify(registry.labels ?? {}) === JSON.stringify(wantedLabels);

    if (!labelsUnchanged && registry.labelCapability !== 'unsupported') {
      try {
        const calMeta = await provider.request<{
          labelProperties?: { eventLabels?: GoogleEventLabel[] };
        }>('GET', calendarPath(registry.focus));
        const existingLabels = calMeta.labelProperties?.eventLabels ?? [];
        const merged = mergeCalendarLabels(existingLabels, wantedLabels, registry.workspaceId);
        const patched = await provider.request<{
          labelProperties?: { eventLabels?: GoogleEventLabel[] };
        }>('PATCH', calendarPath(registry.focus), {
          labelProperties: { eventLabels: merged },
        });
        const returnedIds = new Set(
          (patched.labelProperties?.eventLabels ?? []).map((item) => item.id),
        );
        const allPresent = Object.values(wantedLabels).every((item) => returnedIds.has(item.id));
        if (allPresent) {
          registry.labelCapability = 'supported';
          registry.labels = wantedLabels;
          saveRegistry(registry);
        } else {
          registry.labelCapability = 'unsupported';
          registry.labels = wantedLabels;
          saveRegistry(registry);
          labelFallbackActive = true;
        }
      } catch {
        registry.labelCapability = 'unsupported';
        registry.labels = wantedLabels;
        saveRegistry(registry);
        labelFallbackActive = true;
      }
    }
  }

  for (const action of plan.actions) {
    if (
      options.skipHabitRetire &&
      action.key.startsWith('habit:') &&
      (action.kind === 'cancel' || action.stopped)
    ) {
      summary.skipped++;
      continue;
    }
    if (action.kind === 'conflict') {
      summary.conflicted++;
      continue;
    }
    if (action.kind === 'skip') {
      summary.skipped++;
      continue;
    }
    const calendar = registry[action.calendar];
    if (!calendar) {
      summary.failed++;
      failures.push({ key: action.key, code: 'MISSING_CALENDAR' });
      continue;
    }
    try {
      if (action.kind === 'cancel') {
        await provider.request(
          'DELETE',
          eventPath(calendar, action.remoteId!) + '?sendUpdates=none',
          undefined,
          { 'If-Match': action.etag ?? '' },
        );
        try {
          const remaining = await provider.request<GoogleEvent>(
            'GET',
            eventPath(calendar, action.remoteId!),
          );
          if (remaining.status !== 'cancelled')
            throw new LifeError('GOOGLE_VERIFY', 'Cancellation verification failed');
        } catch (error) {
          if (![404, 410].includes(statusOf(error))) throw error;
        }
        delete mappings[action.key];
        saveMappings(mappings);
        summary.cancelled++;
        continue;
      }

      let effectiveEvent = action.event ? structuredClone(action.event) : undefined;
      if (effectiveEvent && labelFallbackActive && effectiveEvent.eventLabelId) {
        delete effectiveEvent.eventLabelId;
        if (options.snapshot && options.config) {
          const colorId = fallbackColorForKey(options.snapshot, options.config, action.key, colors);
          if (colorId) effectiveEvent.colorId = colorId;
        }
        if (effectiveEvent.extendedProperties?.private) {
          delete effectiveEvent.extendedProperties.private.syntrop_label;
          effectiveEvent.extendedProperties.private.syntrop_hash = eventFingerprint(effectiveEvent);
        }
      }

      if (action.kind !== 'unchanged' || (labelFallbackActive && action.event?.eventLabelId)) {
        const isCreate = action.kind === 'create';
        const method = isCreate ? 'POST' : 'PUT';
        const useLabelParam = Boolean(effectiveEvent?.eventLabelId);
        const path =
          eventPath(calendar, isCreate ? undefined : action.remoteId!) +
          `?sendUpdates=none&conferenceDataVersion=1${useLabelParam ? '&eventLabelVersion=1' : ''}`;
        const sendBody = (evt: GoogleEvent) =>
          Object.fromEntries(
            Object.entries(evt).filter(([field]) =>
              [
                'id',
                'summary',
                'description',
                'start',
                'end',
                'recurrence',
                'transparency',
                'visibility',
                'colorId',
                'eventLabelId',
                'reminders',
                'extendedProperties',
              ].includes(field),
            ),
          );
        try {
          await provider.request(
            method,
            path,
            sendBody(effectiveEvent ?? {}),
            !isCreate ? { 'If-Match': action.etag ?? '' } : undefined,
          );
        } catch (error) {
          if (isCreate && statusOf(error) === 409) {
            /* handled by readback verification */
          } else if (useLabelParam && [400, 403].includes(statusOf(error)) && effectiveEvent) {
            // Provider rejected eventLabelVersion=1 / eventLabelId; fallback to colorId
            labelFallbackActive = true;
            registry.labelCapability = 'unsupported';
            saveRegistry(registry);
            delete effectiveEvent.eventLabelId;
            if (options.snapshot && options.config) {
              const colorId = fallbackColorForKey(
                options.snapshot,
                options.config,
                action.key,
                colors,
              );
              if (colorId) effectiveEvent.colorId = colorId;
            }
            if (effectiveEvent.extendedProperties?.private) {
              delete effectiveEvent.extendedProperties.private.syntrop_label;
              effectiveEvent.extendedProperties.private.syntrop_hash =
                eventFingerprint(effectiveEvent);
            }
            const fallbackPath =
              eventPath(calendar, isCreate ? undefined : action.remoteId!) +
              '?sendUpdates=none&conferenceDataVersion=1';
            await provider.request(
              method,
              fallbackPath,
              sendBody(effectiveEvent),
              !isCreate ? { 'If-Match': action.etag ?? '' } : undefined,
            );
          } else {
            throw error;
          }
        }
      }
      const eventId = effectiveEvent?.id ?? action.remoteId!;
      let actual = await provider.request<GoogleEvent>('GET', eventPath(calendar, eventId));
      if (effectiveEvent?.eventLabelId && !actual.eventLabelId) {
        // Provider accepted request but ignored eventLabelId; downgrade to colorId fallback
        labelFallbackActive = true;
        registry.labelCapability = 'unsupported';
        saveRegistry(registry);
        delete effectiveEvent.eventLabelId;
        if (options.snapshot && options.config) {
          const colorId = fallbackColorForKey(options.snapshot, options.config, action.key, colors);
          if (colorId) effectiveEvent.colorId = colorId;
        }
        if (effectiveEvent.extendedProperties?.private) {
          delete effectiveEvent.extendedProperties.private.syntrop_label;
          effectiveEvent.extendedProperties.private.syntrop_hash = eventFingerprint(effectiveEvent);
        }
        await provider.request(
          'PUT',
          eventPath(calendar, eventId) + '?sendUpdates=none&conferenceDataVersion=1',
          Object.fromEntries(
            Object.entries(effectiveEvent).filter(([field]) =>
              [
                'id',
                'summary',
                'description',
                'start',
                'end',
                'recurrence',
                'transparency',
                'visibility',
                'colorId',
                'reminders',
                'extendedProperties',
              ].includes(field),
            ),
          ),
          actual.etag ? { 'If-Match': actual.etag } : undefined,
        );
        actual = await provider.request<GoogleEvent>('GET', eventPath(calendar, eventId));
      }
      if (
        !owned(actual, registry.workspaceId, action.key) ||
        actual.status === 'cancelled' ||
        unexpectedExtras(actual) ||
        (effectiveEvent && eventFingerprint(actual) !== eventFingerprint(effectiveEvent))
      )
        throw new LifeError('GOOGLE_VERIFY', 'Remote event did not match the approved projection');
      mappings[action.key] = {
        calendarId: calendar,
        eventId,
        hash: eventFingerprint(actual),
        etag: actual.etag,
        sourceVersion: action.sourceVersion ?? mappings[action.key]?.sourceVersion ?? 1,
        lastSync: new Date().toISOString(),
        ...(action.stopped ? { stopped: true } : {}),
      };
      saveMappings(mappings);
      if (action.kind === 'create') summary.created++;
      else if (action.kind === 'update') summary.updated++;
      else summary.unchanged++;
    } catch (error) {
      const status = statusOf(error);
      if (status === 412) summary.conflicted++;
      else summary.failed++;
      failures.push({
        key: action.key,
        code: status
          ? `HTTP_${status}`
          : error instanceof LifeError
            ? error.code
            : 'GOOGLE_NETWORK',
      });
    }
  }
  return {
    ...summary,
    failures,
    manualSync: true,
    ...(Object.keys(wantedLabels).length > 0
      ? {
          labelMode:
            registry.labelCapability === 'supported' ? 'custom-labels' : 'colorId-fallback',
        }
      : {}),
  };
}
