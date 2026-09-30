// Every memory table keys rows by a `uuid` column. PostgREST rejects a
// non-UUID literal in an id filter with "invalid input syntax for type uuid",
// which fails the whole request, so one mistyped caller id would hide every
// valid id in the same lookup. Such an id cannot match a row, so it is dropped
// before the request and simply yields no row.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(id: string): boolean {
  return UUID_PATTERN.test(id)
}

export function onlyUuids(ids: readonly string[]): string[] {
  return ids.filter(isUuid)
}
