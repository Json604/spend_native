export type AppliedOperation<T> = { opId: string; outcome: T };

/** Small model of the database's UNIQUE(op_id) + stored outcome behavior. */
export class IdempotencyStore<T> {
  private readonly outcomes = new Map<string, T>();

  apply(opId: string, fn: () => T): { outcome: T; replay: boolean } {
    const previous = this.outcomes.get(opId);
    if (previous !== undefined) return { outcome: previous, replay: true };
    const outcome = fn();
    this.outcomes.set(opId, outcome);
    return { outcome, replay: false };
  }
}
