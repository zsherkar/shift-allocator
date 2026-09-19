export function isNoAvailabilityPlaceholderSource(source: string | null | undefined): boolean {
  return source === "admin_no_availability_afp_placeholder" || source === "engine_no_availability_afp_fallback";
}

export function formatAllocationDisplayName(name: string, assignmentSource: string | null | undefined): string {
  return isNoAvailabilityPlaceholderSource(assignmentSource) ? `${name}*` : name;
}
