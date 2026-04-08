/**
 * Check if a container is insightd infrastructure based on its labels.
 */
export function isInternalContainer(labels: string | null | undefined): boolean {
  if (!labels) return false;
  try {
    const parsed = typeof labels === 'string' ? JSON.parse(labels) : labels;
    return parsed['insightd.internal'] === 'true';
  } catch {
    return false;
  }
}
