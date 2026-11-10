/**
 * Names that only the layout from before version 1 used on disk. They are read to bring older folios up to date
 * (legacy-layout.js) and are never written or shown; current folios are folios inside folios (SPEC 5).
 */
export const LEGACY_DIR = 'tickets';
/** Types that only older versions wrote; a folio of such a type is treated as having none. */
export const LEGACY_TYPES = Object.freeze(['ticket']);
export const currentType = (t) => (t && !LEGACY_TYPES.includes(t) ? t : undefined);
