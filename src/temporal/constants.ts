/**
 * Temporal task queue and workflow ID constants.
 */

export const DEFAULT_TASK_QUEUE = 'hotel-offers';

/**
 * Builds a deterministic, injective workflow ID from the normalized city name (Decision I8).
 * Injective: uses encodeURIComponent so distinct cities never collide (spaces vs hyphens, etc.).
 */
export function buildWorkflowId(normalizedCity: string): string {
  return `hotels-${encodeURIComponent(normalizedCity)}`;
}
