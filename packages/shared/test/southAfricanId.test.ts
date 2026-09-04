import { describe, expect, it } from 'vitest';
import {
  describeSouthAfricanId,
  findSouthAfricanIds,
  hasValidIdChecksum,
  parseSouthAfricanId,
} from '../src/southAfricanId';

/** Born 1980-01-01, sequence 5009 (male), citizen. Checksum 7. */
const VALID = '8001015009087';
const AT = new Date('2026-09-03T00:00:00Z');

/** Appends the Luhn digit, so the fixtures below state the meaningful digits only. */
function withChecksum(twelve: string): string {
  for (let d = 0; d <= 9; d++) {
    const candidate = twelve + String(d);
    if (hasValidIdChecksum(candidate)) return candidate;
  }
  throw new Error(`no checksum digit completes ${twelve}`);
}

describe('hasValidIdChecksum', () => {
  it('accepts a well-formed number', () => {
    expect(hasValidIdChecksum(VALID)).toBe(true);
  });

  it('rejects every single-digit change to it', () => {
    // This is the property the whole autofill rests on: an OCR misread of one digit
    // must not survive, because a misread that survives fills in someone else's
    // identity and looks exactly as convincing as the truth.
    for (let i = 0; i < 13; i++) {
      for (let d = 0; d <= 9; d++) {
        const mutated = VALID.slice(0, i) + String(d) + VALID.slice(i + 1);
        if (mutated === VALID) continue;
        expect(hasValidIdChecksum(mutated), mutated).toBe(false);
      }
    }
  });

  it('rejects adjacent transpositions, except the 09/90 pair Luhn is blind to', () => {
    // Luhn cannot see a 0 and a 9 swap places: doubling 0 gives 0, and doubling 9
    // digit-sums back to 9, so the total is unchanged. It is a real limit of the
    // check and it is pinned here rather than papered over — the OCR path compensates
    // by refusing to suggest anything when it finds more than one candidate.
    const blindSpots: string[] = [];
    for (let i = 0; i < 12; i++) {
      const pair = VALID.slice(i, i + 2);
      const swapped = VALID.slice(0, i) + VALID[i + 1] + VALID[i] + VALID.slice(i + 2);
      if (swapped === VALID) continue;
      if (pair === '09' || pair === '90') {
        blindSpots.push(swapped);
        continue;
      }
      expect(hasValidIdChecksum(swapped), swapped).toBe(false);
    }
    // And the blind spot really is one, so nobody later mistakes it for a gap in the
    // test rather than a property of the algorithm.
    expect(blindSpots.length).toBeGreaterThan(0);
    expect(blindSpots.every(hasValidIdChecksum)).toBe(true);
  });

  it('rejects anything that is not thirteen digits', () => {
    for (const bad of ['', '800101500908', '80010150090870', '800101500908A', 'A04512399', ' ']) {
      expect(hasValidIdChecksum(bad), bad).toBe(false);
    }
  });
});

describe('parseSouthAfricanId', () => {
  it('reads the date, gender and citizenship out of the digits', () => {
    expect(parseSouthAfricanId(VALID, AT)).toEqual({
      value: VALID,
      dateOfBirth: '1980-01-01',
      gender: 'male',
      citizenship: 'citizen',
    });
  });

  it('tolerates the spaces a document prints the number with', () => {
    expect(parseSouthAfricanId('800101 5009 08 7', AT)?.value).toBe(VALID);
  });

  it('splits gender at sequence 5000', () => {
    expect(parseSouthAfricanId(withChecksum('800101499908'), AT)?.gender).toBe('female');
    expect(parseSouthAfricanId(withChecksum('800101500008'), AT)?.gender).toBe('male');
  });

  it('reads the citizenship digit', () => {
    expect(parseSouthAfricanId(withChecksum('800101500918'), AT)?.citizenship).toBe(
      'permanent-resident',
    );
  });

  it('puts a year that has not happened yet in the previous century', () => {
    // "88" in 2026 is 1988, not 2088. "05" is 2005, which has happened.
    expect(parseSouthAfricanId(withChecksum('880101500908'), AT)?.dateOfBirth).toBe('1988-01-01');
    expect(parseSouthAfricanId(withChecksum('050101500908'), AT)?.dateOfBirth).toBe('2005-01-01');
  });

  it('reports a null date rather than a rolled-over one for an impossible date', () => {
    // 31 February passes the checksum happily; `Date` would silently make it 2 March.
    const parsed = parseSouthAfricanId(withChecksum('800231500908'), AT);
    expect(parsed).not.toBeNull();
    expect(parsed?.dateOfBirth).toBeNull();
  });

  it('returns null for a number that fails the checksum', () => {
    expect(parseSouthAfricanId('8801015009087', AT)).toBeNull();
  });
});

describe('findSouthAfricanIds', () => {
  it('finds the number inside OCR noise', () => {
    const ocr = 'Identity Number / Identiteitsnommer\n0 0 010 8001015009087 01 1988';
    expect(findSouthAfricanIds(ocr)).toEqual([VALID]);
  });

  it('finds it when the document printed it in groups', () => {
    expect(findSouthAfricanIds('800101 5009 087')).toEqual([VALID]);
    expect(findSouthAfricanIds('800101-5009-087')).toEqual([VALID]);
  });

  it('finds it on a line that also carries the label', () => {
    expect(findSouthAfricanIds('Identity Number 8001015009087')).toEqual([VALID]);
  });

  it('handles a multi-line OCR page', () => {
    const page = [
      'REPUBLIC OF SOUTH AFRICA',
      'Surname MOKOENA',
      'Identity Number / Identiteitsnommer',
      '8001015009087',
      'Date of Birth 01 JAN 1980',
    ].join('\n');
    expect(findSouthAfricanIds(page)).toEqual([VALID]);
  });

  it('finds nothing in a barcode payload it cannot read', () => {
    // What an encrypted smart-ID or licence barcode looks like once a scanner has
    // stringified it: bytes, not a number.
    expect(findSouthAfricanIds('ÒZ±q')).toEqual([]);
  });

  it('does not invent a number out of a long digit run', () => {
    expect(findSouthAfricanIds('1111111111111111111111')).toEqual([]);
  });

  it('returns each distinct match once', () => {
    expect(findSouthAfricanIds(`${VALID} and again ${VALID}`)).toEqual([VALID]);
  });
});

describe('describeSouthAfricanId', () => {
  it('reads as something an operator can check against the card', () => {
    expect(describeSouthAfricanId(parseSouthAfricanId(VALID, AT)!)).toBe(
      '8001015009087 · born 1980-01-01 · male',
    );
  });
});
