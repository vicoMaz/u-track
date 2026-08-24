// Type-checking a procedure argument's value against what SCC's own catalog says
// that argument is, so a mistyped value is caught in the form instead of coming
// back as an opaque 500 from the scheduler.
//
// Split out of Scheduler.js purely so this part is unit-testable: Scheduler.js
// pulls in the store and the whole gantt/pass stack, none of which a value check
// needs. Scheduler.js owns detecting WHICH kind a parameter is (it already has
// _scalarTypeLabel and the _isProcParam* sniffers for that, and they feed the
// type chip beside every field); this module owns deciding whether a given value
// fits that kind.
//
// The `kind` strings are exactly the labels _scalarTypeLabel produces — the same
// words shown in the chip next to the argument's name — so an error message here
// and the label the operator is reading always agree.

// The integer types SCC's catalog actually uses, with the range each one can
// hold. Java's own widths: a value outside them is a guaranteed rejection at the
// far end (SCC reflectively invokes the underlying method), so it's worth
// catching here rather than sending.
//
// long is the exception: its true range (±2^63) is far wider than a JS number
// can represent exactly, so it's bounded by Number.MAX_SAFE_INTEGER instead —
// past that the value in the form has already lost precision and whatever gets
// sent is not the number the operator typed.
const INT_RANGES = {
  byte:  [-128, 127],
  short: [-32768, 32767],
  int:   [-2147483648, 2147483647],
  long:  [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
};

const FLOAT_KINDS = new Set(['double', 'float']);

// A number the operator is part-way through typing: a lone sign, a bare decimal
// point, or an exponent with no digits yet. Not valid, but not WRONG either —
// flagging "-" red the instant someone starts typing "-5" is noise, so the live
// (per-keystroke) pass lets these through and only the submit-time pass rejects
// them. Anything that isn't even a number-shaped prefix ("abc", "1.2.3") is red
// immediately, which is the case worth catching early.
const PARTIAL_NUMBER = /^[+-]?(\d*\.?\d*)([eE][+-]?\d*)?$/;

/**
 * Checks one argument value against its declared type.
 *
 * @param kind  the type label from _scalarTypeLabel ('long', 'enum', 'boolean',
 *              'datetime', 'string', … or an unrecognized type's own raw name)
 * @param raw   the value as the form holds it — normally a string, since that is
 *              what every input element gives back
 * @param opts.live       true for the per-keystroke pass, which tolerates
 *                        half-typed values (see PARTIAL_NUMBER)
 * @param opts.enumValues the allowed values, when the catalog listed any
 * @returns null when the value is acceptable, else a short reason, phrased for
 *          a tooltip on the field itself
 */
export function argValueError(kind, raw, { live = false, enumValues = null } = {}) {
  // Empty is "not filled in", never a type error. Deliberate: plenty of
  // arguments ship a null default and are meant to stay empty (subscheduleId
  // when nothing is being sub-scheduled, every enum the catalog sends with no
  // resolved value), and those schedule fine today. Rejecting empty here would
  // block working procedures on a type check that has nothing wrong to report.
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;

  // Enum first, and by the listed values rather than by `kind`: enumValues is
  // the harder fact. Some enum parameters come through with a type this app
  // does not recognize as an enum at all, and the list of allowed values is
  // still right there in the catalog entry.
  if (Array.isArray(enumValues) && enumValues.length) {
    if (enumValues.some(v => String(v) === s)) return null;
    // Typing into the combo passes through every prefix of the value being
    // searched for; those are not mistakes yet.
    if (live && enumValues.some(v => String(v).toLowerCase().startsWith(s.toLowerCase()))) return null;
    return `not one of the ${enumValues.length} allowed values`;
  }

  if (kind === 'boolean') {
    const low = s.toLowerCase();
    return (low === 'true' || low === 'false') ? null : `expected true or false, got "${s}"`;
  }

  if (kind in INT_RANGES || FLOAT_KINDS.has(kind)) {
    // Half-typed numbers: quiet while live, rejected at submit.
    if (PARTIAL_NUMBER.test(s) && !Number.isFinite(Number(s))) {
      return live ? null : `expected ${kind}, got "${s}"`;
    }
    const n = Number(s);
    if (!Number.isFinite(n)) return `expected ${kind}, got "${s}"`;
    if (FLOAT_KINDS.has(kind)) return null;
    if (!Number.isInteger(n)) return `expected a whole ${kind}, got "${s}"`;
    const [min, max] = INT_RANGES[kind];
    if (n < min || n > max) {
      return kind === 'long'
        ? `too large to send exactly (beyond ±${Number.MAX_SAFE_INTEGER})`
        : `out of range for ${kind} (${min}…${max})`;
    }
    return null;
  }

  // 'datetime' is absent on purpose: its field is a picker that parses and
  // reformats on every commit and reverts anything unparseable to its last good
  // value, so it cannot be holding a bad string by the time this runs. Its
  // seconds-offset box IS checked — Scheduler passes that one through as 'int'.
  //
  // 'string', and any type this app does not recognize, accept anything: with no
  // idea what the far end wants, a guess here would reject values that work.
  return null;
}
