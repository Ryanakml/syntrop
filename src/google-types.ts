import type { Row } from './core.ts';
export type GoogleEvent = {
  id?: string;
  etag?: string;
  status?: string;
  summary?: string;
  description?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  recurrence?: string[];
  transparency?: string;
  visibility?: string;
  colorId?: string;
  reminders?: { useDefault: boolean; overrides?: { method: string; minutes: number }[] };
  extendedProperties?: { private?: Record<string, string> };
  [key: string]: unknown;
};
export type HabitDisplay = {
  mode: 'none' | 'flexible' | 'timed';
  startDate?: string;
  time?: string;
  duration?: number;
  weekdays?: string[];
  reminderMinutes?: number;
};
export type ProjectionConfig = {
  workspaceId: string;
  titleMode: 'redacted' | 'titles';
  deadlines: boolean;
  commitments: boolean;
  habits: Record<string, HabitDisplay>;
  categories: Record<string, 'career' | 'oss' | 'learning' | 'review' | 'default'>;
  excludeCommitments: string[];
};
export type Snapshot = {
  timezone: string;
  tasks: Row[];
  projects: Row[];
  work_sessions: Row[];
  calendar_events: Row[];
  habits: Row[];
};
export type Projection = {
  key: string;
  calendar: 'focus' | 'habits';
  sourceVersion: number;
  event: GoogleEvent;
};
export interface GoogleTransport {
  request<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T>;
}
