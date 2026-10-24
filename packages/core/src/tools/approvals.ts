import type { Approval } from '../shared/contracts';
import { HermesError } from '../shared/errors';
import type { HermesStore } from '../persistence/store';
import type { Telemetry } from '../observability/telemetry';

type Decision = 'approved' | 'denied';

/**
 * Bridges persisted approval requests and the in-flight tool calls waiting for them.
 * A decision only unblocks the exact approval id; consumption is checked separately against
 * the tool id and input hash (see HermesStore.consumeApproval).
 */
export class ApprovalBroker {
  private readonly waiters = new Map<
    string,
    { missionId: string; resolve: (d: Decision) => void; reject: (e: Error) => void }
  >();

  constructor(
    private readonly store: HermesStore,
    private readonly telemetry: Telemetry,
  ) {}

  wait(approval: Approval, signal: AbortSignal): Promise<Decision> {
    return new Promise<Decision>((resolve, reject) => {
      const onAbort = () => {
        this.waiters.delete(approval.id);
        reject(new HermesError('CANCELLED', 'Attente d’approbation annulée'));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.set(approval.id, {
        missionId: approval.missionId,
        resolve: (d) => {
          signal.removeEventListener('abort', onAbort);
          resolve(d);
        },
        reject,
      });
    });
  }

  decide(id: string, decision: Decision): Approval {
    const approval = this.store.decideApproval(id, decision);
    this.telemetry.record({
      missionId: approval.missionId,
      taskId: approval.taskId,
      toolId: approval.toolId,
      category: 'security',
      level: decision === 'approved' ? 'info' : 'warn',
      type: `approval.${decision}`,
      message: `${decision === 'approved' ? 'Approuvé' : 'Refusé'} par l’utilisateur : ${approval.description}`,
      data: { approvalId: id },
    });
    const waiter = this.waiters.get(id);
    this.waiters.delete(id);
    waiter?.resolve(decision);
    return approval;
  }

  isWaiting(id: string): boolean {
    return this.waiters.has(id);
  }
}
