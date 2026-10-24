import type { MissionStatus, TaskStatus } from './contracts';
import { HermesError } from './errors';

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['ready', 'blocked', 'cancelled'],
  ready: ['running', 'blocked', 'cancelled'],
  // running -> ready: paused or interrupted before completion, the task will be re-run.
  running: ['waiting_approval', 'completed', 'failed', 'cancelled', 'blocked', 'ready'],
  waiting_approval: ['running', 'failed', 'cancelled', 'blocked', 'ready'],
  failed: ['ready'],
  blocked: ['ready', 'cancelled', 'failed'],
  completed: [],
  cancelled: [],
};

const MISSION_TRANSITIONS: Record<MissionStatus, readonly MissionStatus[]> = {
  planning: ['planned', 'failed', 'cancelled'],
  planned: ['running', 'cancelled'],
  running: ['paused', 'interrupted', 'completed', 'failed', 'cancelled'],
  paused: ['running', 'cancelled', 'interrupted'],
  interrupted: ['running', 'cancelled', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function canTransitionMission(from: MissionStatus, to: MissionStatus): boolean {
  return MISSION_TRANSITIONS[from].includes(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new HermesError('INVALID_TRANSITION', `Transition de tâche refusée : ${from} -> ${to}`);
  }
}

export function assertMissionTransition(from: MissionStatus, to: MissionStatus): void {
  if (!canTransitionMission(from, to)) {
    throw new HermesError('INVALID_TRANSITION', `Transition de mission refusée : ${from} -> ${to}`);
  }
}

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled'];
export const TERMINAL_MISSION_STATUSES: readonly MissionStatus[] = ['completed', 'failed', 'cancelled'];
