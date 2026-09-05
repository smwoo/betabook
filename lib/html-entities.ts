/** ISO-8859-1 entity names in code point order, so `nbsp` is 160 and `yuml`
 * is 255 — the block PHP's `htmlentities()` encodes wholesale, which is how a
 * third-party export turns "é" into "&eacute;". */
const LATIN1_NAMES =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml".split(
    " ",
  );

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  OElig: "Œ",
  oelig: "œ",
  Scaron: "Š",
  scaron: "š",
  Yuml: "Ÿ",
  fnof: "ƒ",
  circ: "ˆ",
  tilde: "˜",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  dagger: "†",
  Dagger: "‡",
  bull: "•",
  hellip: "…",
  permil: "‰",
  prime: "′",
  Prime: "″",
  lsaquo: "‹",
  rsaquo: "›",
  oline: "‾",
  frasl: "⁄",
  euro: "€",
  trade: "™",
  larr: "←",
  uarr: "↑",
  rarr: "→",
  darr: "↓",
  harr: "↔",
  minus: "−",
  lowast: "∗",
  radic: "√",
  infin: "∞",
  ne: "≠",
  le: "≤",
  ge: "≥",
  sdot: "⋅",
  loz: "◊",
  spades: "♠",
  clubs: "♣",
  hearts: "♥",
  diams: "♦",
};

for (const [index, name] of LATIN1_NAMES.entries()) {
  NAMED_ENTITIES[name] = String.fromCharCode(160 + index);
}

/** Lone surrogates, NUL and out-of-range code points have no character to
 * decode to; the entity text stands rather than becoming a broken string. */
function fromCodePoint(code: number): string | null {
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return null;
  if (code >= 0xd800 && code <= 0xdfff) return null;
  return String.fromCodePoint(code);
}

const ENTITY_RE = /&(#[Xx][0-9A-Fa-f]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g;

function decodeOnce(text: string): string {
  return text.replace(ENTITY_RE, (match: string, body: string) => {
    if (!body.startsWith("#")) return NAMED_ENTITIES[body] ?? match;
    const hex = body[1] === "x" || body[1] === "X";
    const digits = hex ? body.slice(2) : body.slice(1);
    return fromCodePoint(Number.parseInt(digits, hex ? 16 : 10)) ?? match;
  });
}

/** Some exporters run their text through an encoder twice ("&amp;rsquo;"), so
 * one pass isn't always enough; the cap stops a deliberately written
 * "&amp;amp;amp;…" from unravelling indefinitely. */
const MAX_PASSES = 3;

/**
 * Turns HTML entities back into the characters they stand for, so a
 * third-party export's "One of the best climbs I&rsquo;ve ever done" reads as
 * the apostrophe the climber typed. Text that isn't a well-formed entity
 * ("Cams #3 & #4") and named entities outside the table are left as they are.
 *
 * For cleaning up text that was never meant to be HTML in the first place.
 * The result is stored and rendered as plain text, so decoding "&lt;" back to
 * "<" is safe here in a way it wouldn't be if the output reached markup.
 */
export function decodeHtmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  let decoded = text;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const next = decodeOnce(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}
