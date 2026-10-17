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
  eventLabelId?: string;
  reminders?: { useDefault: boolean; overrides?: { method: string; minutes: number }[] };
  extendedProperties?: { private?: Record<string, string> };
  [key: string]: unknown;
};
export type GoogleEventLabel = {
  id: string;
  name?: string;
  backgroundColor: string;
};
export type HabitDisplay = {
  mode: 'none' | 'flexible' | 'timed' | 'tasks';
  startDate?: string;
  time?: string;
  duration?: number;
  weekdays?: string[];
  reminderMinutes?: number;
  horizonDays?: number;
  changedAt?: string;
};
export type PresentationLabel = {
  name: string;
  color: string;
  colorId?: string;
};
export type ProjectPresentation = {
  label?: string;
  shortName?: string;
};
export type TaskPresentation = {
  shortTitle?: string;
  label?: string;
  publish?: boolean;
  scheduledDate?: string;
};
export type HabitPresentation = {
  shortName?: string;
  label?: string;
};
export type PresentationConfig = {
  version: number;
  updatedAt?: string;
  theme?: {
    name?: string;
    style?: string;
    sessionPrefix?: 'project' | 'label' | 'none';
    labels?: Record<string, PresentationLabel>;
  };
  defaults?: {
    sessionLabel?: string;
    commitmentLabel?: string;
    deadlineLabel?: string;
    habitLabel?: string;
  };
  projects?: Record<string, ProjectPresentation>;
  tasks?: Record<string, TaskPresentation>;
  habits?: Record<string, HabitPresentation>;
};
export type TasksPolicyConfig = {
  enabled: boolean;
  mode: 'actionable' | 'scheduled' | 'selected' | 'ready' | 'none';
  taskIds?: string[];
  projectIds?: string[];
  includeBacklog?: boolean;
  habitHorizonDays?: number;
  lists?: {
    tasks?: string;
    habits?: string;
  };
};
export type StandingAuthorization = {
  autoSync: boolean;
  autoReconcile: boolean;
  updatedAt?: string;
};
export type ProjectionConfig = {
  workspaceId: string;
  titleMode: 'redacted' | 'titles';
  deadlines: boolean;
  commitments: boolean;
  habits: Record<string, HabitDisplay>;
  categories: Record<string, string>;
  excludeCommitments: string[];
  presentation?: PresentationConfig;
  tasksPolicy?: TasksPolicyConfig;
  standingAuth?: StandingAuthorization;
};
export type Snapshot = {
  timezone: string;
  tasks: Row[];
  projects: Row[];
  work_sessions: Row[];
  calendar_events: Row[];
  habits: Row[];
  task_dependencies?: Row[];
  habit_occurrences?: Row[];
};
export type Projection = {
  key: string;
  calendar: 'focus' | 'habits';
  sourceVersion: number;
  event: GoogleEvent;
};
export type GoogleTaskList = {
  id?: string;
  etag?: string;
  title?: string;
  updated?: string;
  selfLink?: string;
};
export type GoogleTask = {
  id?: string;
  etag?: string;
  title?: string;
  notes?: string;
  status?: 'needsAction' | 'completed';
  due?: string;
  completed?: string;
  deleted?: boolean;
  hidden?: boolean;
  updated?: string;
  parent?: string;
  position?: string;
  webViewLink?: string;
  [key: string]: unknown;
};
export type TaskListRole = 'tasks' | 'habits';
export type TaskProjection = {
  key: string;
  list: TaskListRole;
  kind: 'task' | 'habit-task';
  entityId: string;
  occurrenceDate?: string;
  scheduledDate?: string;
  sourceVersion: number;
  task: GoogleTask;
};
export interface GoogleTransport {
  request<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T>;
}
