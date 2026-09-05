import { format as formatDate, isValid, parse } from "date-fns";
import Papa from "papaparse";

import { parseGrade, type ClimbType } from "@/lib/grades";
import { decodeHtmlEntities } from "@/lib/html-entities";
import {
  ASCENT_STYLES,
  GRADE_FEEL_VALUES,
  MAX_COMMENT_LENGTH,
  latestAcceptableSendDate,
  type AscentStyle,
  type GradeFeel,
} from "@/lib/sends";
import { CSV_UNPARSE_CONFIG } from "@/lib/sends-export";

export type ParsedCsv = {
  headers: string[];
  rows: Record<string, string>[];
  /** Human-readable parse diagnostics: malformed-CSV errors reported by the
   * parser plus any duplicate-header renames. Non-fatal — the file still
   * parsed — but shown to the user before they map columns. */
  warnings: string[];
  /** Columns computed from the file rather than read from it (see
   * deriveSourceColumns). Present on every row and mappable like a header,
   * but not part of `headers`, so a failed-rows export still matches the
   * source file column for column. */
  derived: string[];
};

export const CLIMB_TYPES = ["boulder", "sport", "trad"] as const;
/** Browser-side safety bounds, since parsing is all in-memory.
 *
 * The byte cap is the one that actually protects the parse: it is checked
 * against `file.size` before `file.text()` duplicates the file and before
 * Papa Parse sees any of it. The row cap is checked AFTER parsing — by then
 * every cell is materialized — so it is a bound on what reaches the mapping
 * UI and the import request, not on peak memory. The byte cap is what keeps
 * that survivable; a 10 MB CSV of short rows still parses a few hundred
 * thousand rows before being turned away. Moving the row cap upstream would
 * take a streaming parse (Papa's `step`/`preview` with an abort). */
export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 50_000;

/** Each distinct trimmed non-blank value in `column`, in first-seen order,
 * with how often it occurs. */
function countValues(rows: Record<string, string>[], column: string | null): Map<string, number> {
  const counts = new Map<string, number>();
  if (!column) return counts;
  for (const row of rows) {
    const value = (row[column] ?? "").trim();
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

/** Every distinct, trimmed, non-blank value in `column` across `rows` — used
 * to build the value-mapping step's list of ascent-style/climb-type values
 * the user needs to map. */
export function distinctValues(rows: Record<string, string>[], column: string | null): string[] {
  return [...countValues(rows, column).keys()];
}

/** distinctValues with how often each value occurs, most common first — the
 * value-mapping step shows the count beside each value so a one-off typo and
 * the file's main ascent style don't read as equally weighty. */
export function valueCounts(
  rows: Record<string, string>[],
  column: string | null,
): { value: string; count: number }[] {
  return [...countValues(rows, column)]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);
}

const MAX_PARSE_ERROR_WARNINGS = 5;

/**
 * Real-world exports (like Sendage's) sometimes have metadata lines before
 * the actual header row (an attribution line, an export date, a blank
 * line). Rather than assuming row 0 is always the header, this detects the
 * header row as the first row whose column count matches the most common
 * column count across all rows — i.e. the shape of the real data table.
 */
export function parseCsvText(text: string): ParsedCsv {
  const result = Papa.parse<string[]>(text, { skipEmptyLines: true });
  const warnings: string[] = [];

  // "UndetectableDelimiter" only means papaparse fell back to a comma — it
  // fires for any empty or single-column file, so it's noise rather than a
  // sign of a malformed file. Everything else (unterminated quotes, etc.)
  // is worth showing.
  const parseErrors = result.errors.filter((e) => e.code !== "UndetectableDelimiter");
  for (const err of parseErrors.slice(0, MAX_PARSE_ERROR_WARNINGS)) {
    warnings.push(err.row != null ? `Row ${err.row + 1}: ${err.message}` : err.message);
  }
  if (parseErrors.length > MAX_PARSE_ERROR_WARNINGS) {
    warnings.push(`…and ${parseErrors.length - MAX_PARSE_ERROR_WARNINGS} more parse issues`);
  }

  const rawRows = result.data;
  if (rawRows.length === 0) return { headers: [], rows: [], warnings, derived: [] };

  const lengthCounts = new Map<number, number>();
  for (const r of rawRows) {
    lengthCounts.set(r.length, (lengthCounts.get(r.length) ?? 0) + 1);
  }
  let modeLength = rawRows[0].length;
  let modeCount = -1;
  for (const [length, count] of lengthCounts) {
    if (count > modeCount) {
      modeCount = count;
      modeLength = length;
    }
  }

  const headerIndex = rawRows.findIndex((r) => r.length === modeLength);
  const rawHeaders = rawRows[headerIndex] ?? [];

  // Duplicate header names would silently collapse into one field (each row
  // object is keyed by header name) and produce duplicate React keys in the
  // mapping UI — rename repeats deterministically instead, skipping over any
  // name another header already holds.
  const used = new Set<string>();
  const headers = rawHeaders.map((header) => {
    if (!used.has(header)) {
      used.add(header);
      return header;
    }
    let n = 2;
    let renamed = `${header} (${n})`;
    while (used.has(renamed) || rawHeaders.includes(renamed)) {
      n += 1;
      renamed = `${header} (${n})`;
    }
    used.add(renamed);
    warnings.push(`Duplicate column "${header}" renamed to "${renamed}"`);
    return renamed;
  });

  const rows = rawRows.slice(headerIndex + 1).map((r) => {
    const row: Record<string, string> = {};
    for (const [i, h] of headers.entries()) {
      row[h] = r[i] ?? "";
    }
    return row;
  });

  return { headers, rows, warnings, derived: [] };
}

export type ColumnMapping = {
  date: string | null;
  ascentStyle: string | null;
  climbName: string | null;
  /** The area a climb is in, matched exactly against the climb's own area or
   * any ancestor. Optional: a file without one (KAYA's, say) is matched on
   * climb name alone and the wizard's match step settles any ties. */
  areaName: string | null;
  /** Columns that only *hint* at where a climb is — KAYA's boulder-name
   * "location" and its "country", a Sendage "Country". Never required to
   * match, only used to break ties between same-named climbs; a hint that
   * matches nothing is ignored rather than failing the row. */
  areaHints: string[];
  climbType: string | null; // optional — tiebreaker only
  grade: string | null; // optional
  suggestedGrade: string | null; // optional — takes precedence over `grade` for the send's suggested grade
  gradeFeel: string | null; // optional
  rating: string | null; // optional
  comment: string | null; // optional
};

/** The single-column fields of a ColumnMapping — everything but areaHints. */
export type FieldKey = Exclude<keyof ColumnMapping, "areaHints">;

export const REQUIRED_COLUMN_KEYS: readonly FieldKey[] = ["ascentStyle", "climbName"];

/** The required fields (per REQUIRED_COLUMN_KEYS) that aren't mapped to a
 * CSV column yet. The wizard's columns step blocks Next and names these
 * until the user maps each one — an unmapped ascent style would otherwise
 * only surface three steps later as "0 rows ready". */
export function missingRequiredColumns(mapping: ColumnMapping): FieldKey[] {
  return REQUIRED_COLUMN_KEYS.filter((key) => !mapping[key]);
}

// Order matters: more specific aliases are matched first so, e.g., "Climb
// Type" is claimed before ascentStyle's generic "type" fallback would
// otherwise grab it.
const FIELD_ORDER: FieldKey[] = [
  "date",
  "climbType",
  "ascentStyle",
  "climbName",
  "areaName",
  "suggestedGrade",
  "grade",
  "gradeFeel",
  "rating",
  "comment",
];

// Matched against normalizeHeader's output, so "ascent_type", "Ascent-Type"
// and "Ascent Type" all read as "ascent type" — one spelling per alias here.
const HEADER_ALIASES: Record<FieldKey, string[]> = {
  date: ["date sent", "send date", "ascent date", "date"],
  climbType: ["climb type", "discipline"],
  ascentStyle: [
    "send type",
    "ascent type",
    "ascent style",
    "completion type",
    "tick type",
    "style",
    "type",
  ],
  climbName: ["climb name", "route name", "problem name", "climb", "route", "problem", "name"],
  areaName: ["area name", "area", "crag", "location", "sector"],
  // A third-party log's one grade column is the grade the climber logged,
  // i.e. betabook's suggested grade, so the bare "grade" belongs here. The
  // posted-grade field only claims a bare "Grade" once a more specific header
  // has taken this one (a betabook export has both).
  suggestedGrade: ["suggested grade", "personal grade", "my grade", "grade", "difficulty"],
  grade: ["posted grade", "climb grade", "route grade", "guidebook grade", "grade"],
  gradeFeel: ["grade feel", "stiffness", "feel"],
  rating: ["rating", "your stars", "stars"],
  comment: ["comments", "comment", "notes"],
};

/** Columns that place a climb only loosely — a country or state names a
 * subtree thousands of climbs wide, so they're offered as tie-breaking hints
 * rather than as the area itself. */
const HINT_ALIASES = ["country", "state", "province", "region"];

/** Header text reduced to the form the alias tables are written in: lower
 * case, with underscores and hyphens read as spaces, so an export's
 * `climb_name` finds the "climb name" alias. */
export function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

/** Which app produced the file, when its header row gives it away. Drives a
 * preset column mapping and a per-source note in the wizard; "unknown" falls
 * back to the alias tables above. */
export type ImportSource = "betabook" | "kaya" | "sendage" | "mountainproject" | "unknown";

export const IMPORT_SOURCE_LABELS: Record<ImportSource, string> = {
  betabook: "betabook export",
  kaya: "KAYA export",
  sendage: "Sendage export",
  mountainproject: "Mountain Project export",
  unknown: "CSV",
};

/** Header sets that identify a source. Each is a few headers no other export
 * shares, tested as a subset so an export that gains a column still matches. */
const SOURCE_SIGNATURES: Record<Exclude<ImportSource, "unknown">, string[]> = {
  betabook: ["date sent", "ascent style", "climb name", "area name"],
  kaya: ["ascent type", "climb name", "stiffness"],
  sendage: ["send type", "climb", "climb type", "area"],
  mountainproject: ["route", "lead style", "route type", "your stars"],
};

/** Mountain Project splits the ascent style across two columns: "Lead Style"
 * (Onsight/Flash/Redpoint/Pinkpoint/Fell/Hung) for leads, and "Style" alone
 * for everything else (Send/Flash/Attempt for boulders, TR, Follow, Solo).
 * This derived column takes "Lead Style" when present and "Style" otherwise,
 * so one value-mapping covers every row. */
export const MP_ASCENT_COLUMN = "Lead Style or Style";

/** Adds the per-source derived columns (see ParsedCsv.derived) to a parsed
 * file. Returns the input untouched for sources that need none. */
export function deriveSourceColumns(parsed: ParsedCsv, source: ImportSource): ParsedCsv {
  if (source !== "mountainproject") return parsed;
  const find = (name: string) => parsed.headers.find((h) => normalizeHeader(h) === name);
  const leadStyle = find("lead style");
  const style = find("style");
  if (
    !leadStyle ||
    !style ||
    parsed.headers.includes(MP_ASCENT_COLUMN) ||
    parsed.derived.includes(MP_ASCENT_COLUMN)
  ) {
    return parsed;
  }
  return {
    ...parsed,
    derived: [...parsed.derived, MP_ASCENT_COLUMN],
    rows: parsed.rows.map((row) => ({
      ...row,
      [MP_ASCENT_COLUMN]: (row[leadStyle] ?? "").trim() || (row[style] ?? "").trim(),
    })),
  };
}

export function detectImportSource(headers: string[]): ImportSource {
  const normalized = new Set(headers.map(normalizeHeader));
  for (const [source, signature] of Object.entries(SOURCE_SIGNATURES)) {
    if (signature.every((h) => normalized.has(h))) return source as ImportSource;
  }
  return "unknown";
}

function emptyMapping(): ColumnMapping {
  return {
    date: null,
    ascentStyle: null,
    climbName: null,
    areaName: null,
    areaHints: [],
    climbType: null,
    grade: null,
    suggestedGrade: null,
    gradeFeel: null,
    rating: null,
    comment: null,
  };
}

/** Case-insensitive/trimmed match against the header aliases, adjusted per
 * detected source; the wizard pre-fills the mapping UI with this, and the
 * user can override any of it. `headers` should include any derived columns
 * (see deriveSourceColumns) so a preset can claim them.
 *
 * KAYA's "location" is the boulder, not an area, so as an Area column it
 * would fail nearly every row. It becomes a hint instead, with "country".
 *
 * Mountain Project's "Rating" is the route's grade and "Your Stars" the star
 * rating, the reverse of what the alias table would guess, and its
 * "Location" is a full " > " path, which the hint matching splits. */
export function guessColumnMapping(headers: string[]): ColumnMapping {
  const mapping = emptyMapping();
  const source = detectImportSource(headers);

  const claimed = new Set<string>();
  const normalized = headers.map((h) => ({ raw: h, norm: normalizeHeader(h) }));
  const claim = (norm: string): string | null => {
    const match = normalized.find((h) => !claimed.has(h.raw) && h.norm === norm);
    if (!match) return null;
    claimed.add(match.raw);
    return match.raw;
  };

  if (source === "kaya") {
    // Claimed up front so the generic pass below can't hand "location" to
    // areaName. KAYA's "color", "gym" and "attempts" have no betabook field.
    mapping.areaHints = ["location", "country"].flatMap((h) => claim(h) ?? []);
  }

  if (source === "mountainproject") {
    mapping.ascentStyle = claim(normalizeHeader(MP_ASCENT_COLUMN));
    mapping.climbType = claim("route type");
    mapping.grade = claim("rating");
    mapping.suggestedGrade = claim("your rating");
    mapping.rating = claim("your stars");
    const location = claim("location");
    mapping.areaHints = location ? [location] : [];
  }

  for (const field of FIELD_ORDER) {
    // A preset's choice stands; the generic alias for "style" would
    // otherwise take Mountain Project's raw "Style" back from the derived
    // column above.
    if (mapping[field]) continue;
    for (const alias of HEADER_ALIASES[field]) {
      const raw = claim(alias);
      if (raw) {
        mapping[field] = raw;
        break;
      }
    }
  }

  for (const alias of HINT_ALIASES) {
    const raw = claim(alias);
    if (raw) mapping.areaHints.push(raw);
  }

  return mapping;
}

/**
 * How to read an all-numeric date. This is the only genuinely ambiguous
 * choice — "05/06/2019" is May 6th to an American export and June 5th to a
 * European one, and nothing in the file can settle it — so it's the only
 * thing the wizard asks the user about. Every other shape below carries its
 * own field order and is parsed regardless of this setting.
 */
export type DateFormat = "iso" | "mdy" | "dmy";

/**
 * Formats that can't be misread: the month is spelled out, or the year comes
 * first. Tried for every DateFormat, so a file that mixes (say) ISO rows into
 * an otherwise MM/DD/YYYY export still imports cleanly.
 *
 * date-fns' numeric tokens tolerate missing zero-padding ("2019-1-5" parses
 * under "yyyy-MM-dd") and month names are matched case-insensitively, so each
 * entry covers more than its literal spelling. "MMM" and "MMMM" don't
 * substitute for each other, though, so abbreviated and full month names are
 * listed separately.
 */
const UNAMBIGUOUS_FORMATS = [
  "yyyy-MM-dd", // ISO 8601, and what an ISO timestamp reduces to once its time part is stripped
  "yyyy/MM/dd",
  "yyyy.MM.dd",
  "yyyyMMdd", // ISO 8601 basic
  "EEE MMM d yyyy", // JS Date#toString: "Tue Oct 15 2019 00:00:00 GMT+0000 (GMT+00:00)"
  "EEE, MMM d yyyy", // the same with the weekday punctuated: "Tue, Oct 15 2019"
  "EEE, d MMM yyyy", // RFC 1123 / Date#toUTCString: "Tue, 15 Oct 2019 00:00:00 GMT"
  "MMMM d, yyyy", // "October 15, 2019"
  "MMM d, yyyy", // "Oct 15, 2019"
  "MMMM d yyyy",
  "MMM d yyyy",
  "d MMMM yyyy", // "15 October 2019"
  "d MMM yyyy",
  "d-MMM-yyyy", // "15-Oct-2019" — Excel's default rendering of a text date
  "MMM-d-yyyy",
];

/** All-numeric formats, read according to the user's DateFormat choice.
 * Two-digit years are mapped to the nearest century by date-fns (69 -> 1969,
 * 26 -> 2026), which matches how spreadsheets read them. */
const AMBIGUOUS_FORMATS: Record<DateFormat, string[]> = {
  // ISO's numeric shapes are unambiguous, so they're already covered above.
  iso: [],
  mdy: ["M/d/yyyy", "M-d-yyyy", "M.d.yyyy", "M/d/yy", "M-d-yy", "M.d.yy"],
  dmy: ["d/M/yyyy", "d-M-yyyy", "d.M.yyyy", "d/M/yy", "d-M-yy", "d.M.yy"],
};

// A trailing timezone name in parens, as JS Date#toString emits:
// "(GMT+00:00)", "(Pacific Daylight Time)".
const TZ_NAME_RE = /\s*\([^)]*\)\s*$/;

// A trailing time, with an optional timezone glued to it: " 00:00:00",
// "T00:00:00.000Z", " 00:00:00 GMT+0000", " 2:05 PM". The timezone is only
// stripped as part of a time so that the "-2019" in "15-Oct-2019" can't be
// mistaken for a UTC offset.
const TIME_RE =
  /[T\s]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:[AP]\.?M\.?)?\s*(?:(?:GMT|UTC|UT)?\s*(?:Z|[+-]\d{1,2}:?\d{2})?)\s*$/i;

/**
 * Reduces a timestamp to the civil date it displays, dropping the time and
 * timezone. Deliberately takes the date *as written* rather than converting
 * to UTC: a log line reading "Tue Oct 15 2019 ... GMT-0700" is a send on
 * October 15th to the person who logged it, and shifting it to the 16th
 * because of an offset would be wrong. Sends are stored as civil dates, with
 * no time, for the same reason.
 */
function stripTimeSuffix(value: string): string {
  return value.replace(TZ_NAME_RE, "").replace(TIME_RE, "").trim();
}

// date-fns spells September "Sep"; "Sept" is common enough in hand-written
// logs to be worth normalizing rather than rejecting.
const SEPT_RE = /\bSept\b/gi;

// `parse` fills in any field its format doesn't cover from this date. Every
// format above supplies year, month and day, so it only ever contributes the
// time of day — but it's fixed rather than `new Date()` to keep parsing
// independent of when it runs.
const REFERENCE_DATE = new Date(2000, 0, 1);

/** Returns an ISO YYYY-MM-DD string, or null if unparseable/blank under the given format. */
export function parseDateWithFormat(raw: string, format: DateFormat): string | null {
  const trimmed = stripTimeSuffix(raw.trim()).replace(SEPT_RE, "Sep");
  if (!trimmed) return null;

  for (const pattern of [...UNAMBIGUOUS_FORMATS, ...AMBIGUOUS_FORMATS[format]]) {
    // `parse` anchors on the whole string — trailing junk fails the match —
    // and rejects impossible dates like 2019-02-30, so a valid result here
    // means the value really was that format.
    const parsed = parse(trimmed, pattern, REFERENCE_DATE);
    if (isValid(parsed) && isPlausibleYear(parsed)) return formatDate(parsed, "yyyy-MM-dd");
  }

  return null;
}

// No one logs a send from year 19, so an implausible year means a token ate
// the wrong digits and the next format should get a shot. date-fns' "yyyy"
// matches 1-4 digits, so without this "10/15/19" would parse as year 19 under
// "M/d/yyyy" instead of falling through to "M/d/yy" and its 2019.
function isPlausibleYear(date: Date): boolean {
  const year = date.getFullYear();
  return year >= 1900 && year <= 2100;
}

/** How many of a date column's distinct values to look at when detecting the
 * format and deciding whether to ask about it. Enough to catch a stray
 * numeric row in an otherwise named-month file; small enough that a
 * 50,000-row import doesn't parse every value three times. */
export const DATE_SAMPLE_SIZE = 25;

/**
 * Whether the user actually has to be asked how to read this column's dates.
 * True only if some value is genuinely ambiguous — it reads as one date
 * under "month first" and a different one under "day first", the way
 * "05/06/2019" does. Everything else answers itself: "2019-09-22" and
 * "Sun Sep 22 2019" parse the same way whatever the setting is, and
 * "22/09/2019" only parses one way, so detectDateFormat can settle it
 * without bothering the user.
 */
export function needsDateFormatChoice(sampleValues: string[]): boolean {
  return sampleValues.some((value) => {
    if (!value.trim()) return false;
    const asMdy = parseDateWithFormat(value, "mdy");
    const asDmy = parseDateWithFormat(value, "dmy");
    return asMdy !== null && asDmy !== null && asMdy !== asDmy;
  });
}

/** Tries each candidate format against the sample values, returns whichever
 * parses the most of them (ties favor "iso"). Values in an unambiguous format
 * parse under all three candidates, so they tie and leave the choice to
 * whatever all-numeric values are in the sample — which is exactly the
 * decision the setting exists to make. */
export function detectDateFormat(sampleValues: string[]): DateFormat {
  const candidates: DateFormat[] = ["iso", "mdy", "dmy"];
  let best: DateFormat = "iso";
  let bestScore = -1;

  for (const format of candidates) {
    const score = sampleValues.filter(
      (v) => v.trim() && parseDateWithFormat(v, format) !== null,
    ).length;
    if (score > bestScore) {
      bestScore = score;
      best = format;
    }
  }

  return best;
}

// A time of day other than midnight inside a date value: "16:42:54" in
// "Wed Sep 02 2026 16:42:54 GMT+0000".
const NON_MIDNIGHT_TIME_RE = /\b(?!00:00(?::00)?\b)\d{1,2}:\d{2}(?::\d{2})?\b/;

/** Date values that stand in for "no date". KAYA writes the export time on
 * sends logged without a date, so every undated send shares one timestamp to
 * the second. Real values are midnight (date-only logs) or unique per row.
 * Returned with counts so the wizard can offer to import those rows undated
 * instead of all dated today. */
export function findPlaceholderTimestamps(
  rows: Record<string, string>[],
  dateColumn: string | null,
): { value: string; count: number }[] {
  return valueCounts(rows, dateColumn).filter(
    ({ value, count }) => count >= 2 && NON_MIDNIGHT_TIME_RE.test(value),
  );
}

export type AscentStyleMapping = Record<string, AscentStyle | "skip">;
export type ClimbTypeMapping = Record<string, ClimbType | "skip">;
export type GradeFeelMapping = Record<string, GradeFeel | "skip">;

// Other apps' words for the three styles. "Pinkpoint" is a redpoint on
// pre-placed gear; Mountain Project's "Send" is a boulder redpoint and a
// bare "Lead" is a lead with no style given, which is a redpoint far more
// often than not. Non-sends (TR, Follow, Attempt, Fell/Hung) stay unmapped
// so they default to skipping the row.
const ASCENT_STYLE_ALIASES: Record<string, AscentStyle> = {
  "red point": "redpoint",
  pinkpoint: "redpoint",
  "pink point": "redpoint",
  send: "redpoint",
  lead: "redpoint",
  "on sight": "onsight",
  "on-sight": "onsight",
};

/** Pre-fills the value-mapping step's ascent-style dropdowns by matching
 * each distinct CSV value against a known ascent style; anything that
 * doesn't match defaults to "skip" for the user to resolve manually. */
export function guessAscentStyleMapping(values: string[]): AscentStyleMapping {
  const mapping: AscentStyleMapping = {};
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    const match = ASCENT_STYLES.find((t) => t === normalized) ?? ASCENT_STYLE_ALIASES[normalized];
    mapping[value] = match ?? "skip";
  }
  return mapping;
}

const CLIMB_TYPE_ALIASES: Record<string, ClimbType> = {
  bouldering: "boulder",
  traditional: "trad",
};

/** Same as guessAscentStyleMapping, but for the (optional, tiebreaker-only)
 * climb-type column. A value can list several types ("Trad, Sport" or
 * "Sport, TR" on Mountain Project); the first recognized one wins. */
export function guessClimbTypeMapping(values: string[]): ClimbTypeMapping {
  const mapping: ClimbTypeMapping = {};
  for (const value of values) {
    let match: ClimbType | undefined;
    for (const token of value.toLowerCase().split(/\s*[,/]\s*/)) {
      const trimmed = token.trim();
      match = CLIMB_TYPES.find((t) => t === trimmed) ?? CLIMB_TYPE_ALIASES[trimmed];
      if (match) break;
    }
    mapping[value] = match ?? "skip";
  }
  return mapping;
}

// Mountain Project appends a protection rating to some route grades
// ("5.9 R", "5.10c PG13"); it says nothing about difficulty.
const PROTECTION_SUFFIX_RE = /\s+(?:PG-?13|R|X)$/i;

/** Grade text as the grade tables expect it. */
function cleanGradeText(raw: string): string | null {
  return raw.replace(PROTECTION_SUFFIX_RE, "").trim() || null;
}

export type GradeScale = "native" | "converted";

/** Which notation a grade column is written in, by which set of tables reads
 * more of its values: V-scale/YDS ("V4", "5.11a") or Font/French ("6A",
 * "6c+"). A tie, or a column with no readable grade, stays native. */
export function detectGradeScale(values: string[]): GradeScale {
  let native = 0;
  let converted = 0;
  for (const value of values) {
    const text = cleanGradeText(value);
    if (!text) continue;
    if (parseGrade("boulder", text) !== null || parseGrade("sport", text) !== null) native += 1;
    if (
      parseGrade("boulder", text, "converted") !== null ||
      parseGrade("sport", text, "converted") !== null
    ) {
      converted += 1;
    }
  }
  return converted > native ? "converted" : "native";
}

// Mountain Project writes an area as its whole path from the root
// ("International > North America > Canada > … > Campground Wall").
const AREA_PATH_SEPARATOR_RE = /\s+>\s+/;

/** A hint cell as one or more area names, most specific first. A path splits
 * into its segments leaf-first, so the hint matching tries the wall before
 * the country; a plain name is itself. */
export function splitAreaHint(value: string): string[] {
  return value
    .split(AREA_PATH_SEPARATOR_RE)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .toReversed();
}

// Other sites rarely use betabook's own low/solid/high wording — soft/stiff
// is the more common phrasing — so the guess covers the unambiguous
// synonyms. Deliberately excludes terms like "sandbagged", which people use
// to mean opposite things; those fall through to "skip" for the user to
// decide rather than being guessed wrong. The signed numbers are KAYA's
// "stiffness" (0 = fair; the sign follows the word, so negative is soft).
const GRADE_FEEL_ALIASES: Record<string, GradeFeel> = {
  soft: "low",
  easy: "low",
  fair: "solid",
  accurate: "solid",
  stiff: "high",
  hard: "high",
  "-1": "low",
  "0": "solid",
  "1": "high",
};

/** Same as guessAscentStyleMapping, but for the optional grade-feel column.
 * Unmapped values fall back to the "solid" default rather than failing the
 * row — grade feel is never required. */
export function guessGradeFeelMapping(values: string[]): GradeFeelMapping {
  const mapping: GradeFeelMapping = {};
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    const match = GRADE_FEEL_VALUES.find((t) => t === normalized) ?? GRADE_FEEL_ALIASES[normalized];
    mapping[value] = match ?? "skip";
  }
  return mapping;
}

export type NormalizedImportRow = {
  /** Index into ParsedCsv.rows — the wizard keys per-row decisions by it. */
  rowIndex: number;
  climbName: string;
  /** Null when no Area column is mapped or the cell is blank; the match step
   * then resolves the climb on name alone. */
  areaName: string | null;
  /** Non-blank values of the mapped hint columns, in column order, with a
   * path value split into its segments leaf-first (see splitAreaHint). For
   * the match step's tie-breaking, never a requirement. */
  areaHints: string[];
  climbTypeHint: ClimbType | null; // from ClimbTypeMapping, tiebreaker only
  ascentStyle: AscentStyle;
  dateSent: string | null; // ISO if present; blank in the CSV -> null, not a failure
  rating: number | null;
  comment: string | null; // truncated to MAX_COMMENT_LENGTH here, not rejected
  /** The text that becomes the send's suggested grade — from the Suggested
   * Grade column when one is mapped (where third-party exports' lone grade
   * column lands: it's the grade the climber logged), else from the posted
   * Grade column, which only a betabook export carries separately. */
  gradeText: string | null;
  /** What a null gradeText means for the send's suggested grade:
   * "posted-grade" — only a Grade column was mapped, so fall back to the
   * climb's posted grade (the pre-existing semantics for third-party CSVs);
   * "no-suggestion" — a Suggested Grade column was mapped and this row's
   * cell was blank, so record no suggestion at all. The latter is what lets
   * a betabook export round-trip losslessly instead of silently replacing
   * every blank suggested grade with the climb's posted grade. */
  blankGradeMeans: "posted-grade" | "no-suggestion";
  /** The climb's grade as the file states it, when a posted Grade column is
   * mapped. Never written to the send; it stands in for a blank gradeText
   * when matching (a Mountain Project row rarely has a grade of the
   * climber's own, but always has the route's). */
  postedGradeText: string | null;
  gradeFeel: GradeFeel; // optional CSV column; defaults to "solid" if absent/unrecognized
  raw: Record<string, string>; // the original CSV row, kept for a failed-rows export identical to the source
};

export type InvalidImportRow = {
  rowIndex: number;
  raw: Record<string, string>;
  reason: string;
};

/** One kind of silent value adjustment normalizeImportRows makes to rows it
 * still counts as valid — surfaced on the review step so lossy coercions
 * (invalid rating dropped, unrecognized grade dropped, unknown grade feel
 * defaulted, overlong comment truncated) aren't presented as "ready"
 * without comment. */
export type CoercionWarning = {
  field: "suggestedGrade" | "rating" | "gradeFeel" | "comment";
  message: string;
  count: number;
  /** The first few affected rows, pre-formatted for display (e.g. `Row 4: "banana"`). */
  examples: string[];
};

const WARNING_EXAMPLE_LIMIT = 3;

const COERCION_MESSAGES: Record<CoercionWarning["field"], string> = {
  suggestedGrade: "unrecognized grade, imported without a suggested grade",
  rating: "invalid rating, imported without a rating",
  gradeFeel: 'unmapped grade feel, imported as "solid"',
  comment: `comment longer than ${MAX_COMMENT_LENGTH} characters, truncated`,
};

/** Whether grade text will resolve to a grade ordinal server-side. With a
 * climb-type hint the exact grade table is known; without one, text that
 * parses in neither the boulder nor the rope table is certain to come back
 * null. (Text that parses in only one table can still miss if the climb
 * resolves to the other discipline — that can't be known client-side.) */
function gradeTextParses(
  text: string,
  climbTypeHint: ClimbType | null,
  preference: "native" | "converted",
): boolean {
  if (climbTypeHint) return parseGrade(climbTypeHint, text, preference) !== null;
  return (
    parseGrade("boulder", text, preference) !== null ||
    parseGrade("sport", text, preference) !== null
  );
}

export type NormalizeOptions = {
  today?: string;
  gradeScalePreference?: "native" | "converted";
  /** Raw date values to read as "no date" — see findPlaceholderTimestamps. */
  undatedValues?: Iterable<string>;
};

/**
 * Applies column mapping + value mappings + date format to every parsed CSV
 * row. Never touches the database — climb resolution happens in the match
 * step. Returns both buckets so the wizard can show "N rows ready, M rows
 * can't be imported" before the user ever clicks Finalize, plus per-field
 * coercion warnings for the value adjustments made to rows in the valid
 * bucket.
 */
// oxlint-disable-next-line complexity -- one coercion + validation branch per mapped CSV column
export function normalizeImportRows(
  parsed: ParsedCsv,
  mapping: ColumnMapping,
  ascentStyleMapping: AscentStyleMapping,
  climbTypeMapping: ClimbTypeMapping,
  gradeFeelMapping: GradeFeelMapping,
  dateFormat: DateFormat,
  options: NormalizeOptions = {},
): { valid: NormalizedImportRow[]; invalid: InvalidImportRow[]; warnings: CoercionWarning[] } {
  const {
    today = new Date().toISOString().slice(0, 10),
    gradeScalePreference = "native",
    undatedValues = [],
  } = options;
  const undated = new Set(undatedValues);
  const valid: NormalizedImportRow[] = [];
  const invalid: InvalidImportRow[] = [];
  // One day past UTC today, since a client's local today can be ahead of
  // UTC's — see latestAcceptableSendDate.
  const latestDateSent = latestAcceptableSendDate(today);

  const warningBuckets = new Map<CoercionWarning["field"], { count: number; examples: string[] }>();
  const warn = (field: CoercionWarning["field"], rowIndex: number, example: string) => {
    const bucket = warningBuckets.get(field) ?? { count: 0, examples: [] };
    bucket.count += 1;
    if (bucket.examples.length < WARNING_EXAMPLE_LIMIT) {
      bucket.examples.push(`Row ${rowIndex + 1}: ${example}`);
    }
    warningBuckets.set(field, bucket);
  };

  for (const [rowIndex, row] of parsed.rows.entries()) {
    const fail = (reason: string) => invalid.push({ rowIndex, raw: row, reason });
    const cell = (column: string | null) => (column ? (row[column] ?? "").trim() : "");
    /** Sendage stores its text HTML-encoded and exports it that way, so prose
     * arrives as "I&rsquo;ve" and names as "Salt &amp; Pepper". Only the
     * free-text fields are decoded: a value-mapped cell is a key into a
     * mapping built from the raw text, and `raw` has to keep matching the
     * source file for the failed-rows export. */
    const textCell = (column: string | null) => decodeHtmlEntities(cell(column));

    const climbName = textCell(mapping.climbName);
    if (!climbName) {
      fail("Missing climb name");
      continue;
    }

    const areaName = textCell(mapping.areaName) || null;
    const areaHints = mapping.areaHints.flatMap((column) => splitAreaHint(textCell(column)));

    const rawAscentStyle = cell(mapping.ascentStyle);
    const mappedAscentStyle = rawAscentStyle ? ascentStyleMapping[rawAscentStyle] : undefined;
    if (!mappedAscentStyle || mappedAscentStyle === "skip") {
      fail(
        rawAscentStyle ? `Unmapped ascent style value "${rawAscentStyle}"` : "Missing ascent style",
      );
      continue;
    }

    const rawDate = cell(mapping.date);
    let dateSent: string | null = null;
    if (rawDate && !undated.has(rawDate)) {
      dateSent = parseDateWithFormat(rawDate, dateFormat);
      if (dateSent === null) {
        fail(`Unparseable date "${rawDate}"`);
        continue;
      }
      if (dateSent > latestDateSent) {
        fail(`Date "${rawDate}" is in the future`);
        continue;
      }
    }

    const rawClimbType = cell(mapping.climbType);
    const mappedClimbType = rawClimbType ? climbTypeMapping[rawClimbType] : undefined;
    const climbTypeHint: ClimbType | null =
      mappedClimbType && mappedClimbType !== "skip" ? mappedClimbType : null;

    const rawRating = cell(mapping.rating);
    const ratingNum = rawRating ? Number(rawRating) : null;
    const rating =
      ratingNum !== null && Number.isInteger(ratingNum) && ratingNum >= 1 && ratingNum <= 5
        ? ratingNum
        : null;
    // Zero or negative is an app's "not rated" (Mountain Project exports -1),
    // not a rating that failed to parse, so it drops silently.
    if (rawRating && rating === null && !(ratingNum !== null && ratingNum <= 0)) {
      warn("rating", rowIndex, `"${rawRating}"`);
    }

    const rawComment = textCell(mapping.comment);
    if (rawComment.length > MAX_COMMENT_LENGTH) {
      warn("comment", rowIndex, `${rawComment.length} characters`);
    }
    const comment = rawComment
      ? rawComment.length > MAX_COMMENT_LENGTH
        ? rawComment.slice(0, MAX_COMMENT_LENGTH)
        : rawComment
      : null;

    // The Suggested Grade column, when mapped, is authoritative for the
    // send's suggested grade; the Grade column only fills that role when no
    // Suggested Grade column exists (see NormalizedImportRow.blankGradeMeans).
    const gradeColumn = mapping.suggestedGrade ?? mapping.grade;
    const blankGradeMeans = mapping.suggestedGrade
      ? ("no-suggestion" as const)
      : ("posted-grade" as const);
    const gradeText = cleanGradeText(cell(gradeColumn));
    if (gradeText && !gradeTextParses(gradeText, climbTypeHint, gradeScalePreference)) {
      warn("suggestedGrade", rowIndex, `"${gradeText}"`);
    }
    const postedGradeText = cleanGradeText(cell(mapping.grade));

    const rawGradeFeel = cell(mapping.gradeFeel);
    const mappedGradeFeel = rawGradeFeel ? gradeFeelMapping[rawGradeFeel] : undefined;
    // Unmapped or explicitly ignored grade feel falls back to the "solid"
    // default — unlike ascent style, it never invalidates a row. It does
    // warn, though: the file said something about this send's grade feel and
    // the import is dropping it.
    const feelDropped = !mappedGradeFeel || mappedGradeFeel === "skip";
    const gradeFeel: GradeFeel = feelDropped ? "solid" : mappedGradeFeel;
    if (rawGradeFeel && feelDropped) warn("gradeFeel", rowIndex, `"${rawGradeFeel}"`);

    valid.push({
      rowIndex,
      climbName,
      areaName,
      areaHints,
      climbTypeHint,
      ascentStyle: mappedAscentStyle,
      dateSent,
      rating,
      comment,
      gradeText,
      blankGradeMeans,
      postedGradeText,
      gradeFeel,
      raw: row,
    });
  }

  const warnings: CoercionWarning[] = (
    ["suggestedGrade", "rating", "gradeFeel", "comment"] as const
  ).flatMap((field) => {
    const bucket = warningBuckets.get(field);
    return bucket ? [{ field, message: COERCION_MESSAGES[field], ...bucket }] : [];
  });

  return { valid, invalid, warnings };
}

/** One row that didn't import, with why — whatever stage stopped it. */
export type FailedImportRow = {
  raw: Record<string, string>;
  reason: string;
};

const REASON_COLUMN = "Import Failure Reason";

/**
 * Builds a CSV of every row that couldn't be imported so the user can review
 * and fix them outside the wizard. Every row's original CSV columns/values
 * are carried through unchanged (via each row's own `raw`), with one column
 * appended explaining why it failed — the export otherwise matches the
 * source file exactly, so it can be edited and re-uploaded as-is.
 */
export function buildFailedRowsCsv(headers: string[], failures: FailedImportRow[]): string {
  const fields = [...headers, REASON_COLUMN];
  const data = failures.map(({ raw, reason }) => [...headers.map((h) => raw[h] ?? ""), reason]);
  return Papa.unparse({ fields, data }, CSV_UNPARSE_CONFIG);
}
