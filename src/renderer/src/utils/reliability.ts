/** Returns true when an async response still belongs to the latest request. */
export function isLatestSequence(request: number, latest: number): boolean {
  return request === latest;
}

/**
 * Keep the database response authoritative while retaining optimistic messages
 * that have not appeared in the database yet.
 */
export function reconcilePendingMessages<T extends { role: string; content: string }>(
  remote: T[],
  pending: T[],
): { messages: T[]; pending: T[] } {
  const remaining = [...pending];
  for (const message of remote) {
    const index = remaining.findIndex(
      (candidate) => candidate.role === message.role && candidate.content === message.content,
    );
    if (index >= 0) remaining.splice(index, 1);
  }
  return { messages: [...remote, ...remaining], pending: remaining };
}
