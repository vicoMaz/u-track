import { describe, it, expect } from 'vitest';
import { argValueError } from '../src/ui/procArgTypes.js';

describe('argValueError — empty and missing', () => {
  it('accepts empty, null and undefined for every kind', () => {
    for (const kind of ['long', 'int', 'double', 'boolean', 'enum', 'string']) {
      expect(argValueError(kind, '')).toBeNull();
      expect(argValueError(kind, '   ')).toBeNull();
      expect(argValueError(kind, null)).toBeNull();
      expect(argValueError(kind, undefined)).toBeNull();
    }
  });
});

describe('argValueError — integers', () => {
  it('accepts whole numbers, with or without a sign', () => {
    expect(argValueError('long', '42')).toBeNull();
    expect(argValueError('long', '-42')).toBeNull();
    expect(argValueError('long', '+42')).toBeNull();
    expect(argValueError('int', ' 7 ')).toBeNull();
  });

  it('rejects non-numeric text', () => {
    expect(argValueError('long', 'abc')).toMatch(/expected long/);
    expect(argValueError('int', '12a')).toMatch(/expected int/);
    expect(argValueError('int', '1.2.3')).toMatch(/expected int/);
  });

  it('rejects a fractional value for an integer type', () => {
    expect(argValueError('long', '1.5')).toMatch(/whole long/);
    expect(argValueError('byte', '0.1')).toMatch(/whole byte/);
  });

  it('enforces each integer width', () => {
    expect(argValueError('byte', '127')).toBeNull();
    expect(argValueError('byte', '128')).toMatch(/out of range for byte/);
    expect(argValueError('byte', '-128')).toBeNull();
    expect(argValueError('byte', '-129')).toMatch(/out of range for byte/);
    expect(argValueError('short', '32767')).toBeNull();
    expect(argValueError('short', '32768')).toMatch(/out of range for short/);
    expect(argValueError('int', '2147483647')).toBeNull();
    expect(argValueError('int', '2147483648')).toMatch(/out of range for int/);
  });

  it('rejects a long past the exactly-representable range', () => {
    expect(argValueError('long', '9007199254740991')).toBeNull();
    expect(argValueError('long', '90071992547409910')).toMatch(/too large to send exactly/);
  });
});

describe('argValueError — floats', () => {
  it('accepts fractional and exponent forms', () => {
    expect(argValueError('double', '1.5')).toBeNull();
    expect(argValueError('double', '-0.25')).toBeNull();
    expect(argValueError('float', '1e3')).toBeNull();
    expect(argValueError('double', '2147483648.5')).toBeNull(); // no width limit
  });

  it('rejects non-numeric text', () => {
    expect(argValueError('double', 'x')).toMatch(/expected double/);
  });
});

describe('argValueError — half-typed numbers', () => {
  it('tolerates a value still being typed in the live pass', () => {
    for (const partial of ['-', '+', '.', '-.', '1e', '1e-', '']) {
      expect(argValueError('long', partial, { live: true })).toBeNull();
      expect(argValueError('double', partial, { live: true })).toBeNull();
    }
  });

  it('rejects the same values at submit time', () => {
    expect(argValueError('long', '-')).toMatch(/expected long/);
    expect(argValueError('double', '1e')).toMatch(/expected double/);
  });

  it('still rejects text that is not number-shaped, even live', () => {
    expect(argValueError('long', 'abc', { live: true })).toMatch(/expected long/);
    expect(argValueError('int', '1.2.3', { live: true })).toMatch(/expected int/);
  });
});

describe('argValueError — booleans', () => {
  it('accepts true/false in any case', () => {
    expect(argValueError('boolean', 'true')).toBeNull();
    expect(argValueError('boolean', 'FALSE')).toBeNull();
  });

  it('rejects anything else', () => {
    expect(argValueError('boolean', 'yes')).toMatch(/expected true or false/);
    expect(argValueError('boolean', '1')).toMatch(/expected true or false/);
  });
});

describe('argValueError — enums', () => {
  const enumValues = ['SEND_NOW', 'SEND_NOW_AND_VERIFY', 'SCHEDULE_SLOW_PUS'];

  it('accepts a listed value', () => {
    expect(argValueError('enum', 'SEND_NOW', { enumValues })).toBeNull();
    expect(argValueError('enum', ' SCHEDULE_SLOW_PUS ', { enumValues })).toBeNull();
  });

  it('rejects a value that is not listed', () => {
    expect(argValueError('enum', 'SEND_LATER', { enumValues })).toMatch(/not one of the 3 allowed values/);
  });

  it('is case-sensitive on a committed value', () => {
    expect(argValueError('enum', 'send_now', { enumValues })).toMatch(/not one of/);
  });

  it('tolerates a prefix while the operator is typing in the combo', () => {
    expect(argValueError('enum', 'SEND', { enumValues, live: true })).toBeNull();
    expect(argValueError('enum', 'sched', { enumValues, live: true })).toBeNull();
    expect(argValueError('enum', 'ZZZ', { enumValues, live: true })).toMatch(/not one of/);
  });

  it('checks the listed values even when the type is not recognized as an enum', () => {
    expect(argValueError('ArgumentView', 'NOPE', { enumValues })).toMatch(/not one of/);
    expect(argValueError('long', 'SEND_NOW', { enumValues })).toBeNull();
  });
});

describe('argValueError — types with nothing to check', () => {
  it('accepts anything for a string', () => {
    expect(argValueError('string', 'whatever ¯\\_(ツ)_/¯')).toBeNull();
  });

  it('accepts anything for a datetime (its own widget guarantees the format)', () => {
    expect(argValueError('datetime', 'not a date')).toBeNull();
  });

  it('accepts anything for a type this app does not recognize', () => {
    expect(argValueError('ArgumentView', '{"a":1}')).toBeNull();
    expect(argValueError('', 'x')).toBeNull();
  });
});
