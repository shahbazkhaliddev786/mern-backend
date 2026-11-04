// Record ids (spec 023): UUIDs, as Postgres generates them (gen_random_uuid). Anything else is
// rejected before it reaches a query, so a malformed id is "not found", never a database error.

export const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isId = (value: unknown): value is string => typeof value === 'string' && ID_PATTERN.test(value);
