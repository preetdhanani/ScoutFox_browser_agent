/**
 * src/background/agent/evidence.ts in isolation: what "the same site" and "the same link" mean, how numbers
 * are read in every format of the pages we meet, and the ledger that records what the engine really read.
 * The audit that uses all of this (agent/answerAudit.ts) is tested in answerAudit.test.ts.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  EvidenceLedger,
  MAX_ENTRIES,
  MAX_TEXT_CHARS,
  MAX_TOTAL_CHARS,
  amountKey,
  canonicalAmounts,
  CONDENSE_RADIUS,
  MAX_HOSTS,
  MAX_VISITS,
  condenseText,
  cutAtWord,
  durationUnitOf,
  extractDurations,
  extractMoney,
  extractPercents,
  extractUrls,
  findSnippet,
  frontDoorHost,
  hasShippingWording,
  hasUserInfo,
  hostOf,
  hostsNamedIn,
  isOriginOnly,
  ledgerFromSnapshot,
  looksLikeDomain,
  maskLinks,
  normalizeSpaces,
  normalizeUrlForMatch,
  registrableHost,
  sameAmount,
  scanNumbers,
  scanSites,
  siteOf,
  snippetWithWholeWords,
  urlCovers
} from '../../src/background/agent/evidence.ts';

const EURO = '\u20ac';
const NBSP = '\u00a0';

// ---------------------------------------------------------------------------------------------
// Sites and links
// ---------------------------------------------------------------------------------------------

describe('hostOf', () => {
  const table: Array<[string, string]> = [
    ['https://www.Frame.Work/de/en?x=1', 'www.frame.work'],
    ['HTTP://IDEALO.DE', 'idealo.de'],
    ['http://localhost:3000/x', 'localhost'],
    ['https://user:secret@shop.test:8443/a', 'shop.test'],
    ['www.idealo.de/x', 'www.idealo.de'],
    ['idealo.de', 'idealo.de'],
    ['idealo.de/preisvergleich/x', 'idealo.de'],
    ['https://a.b.c./x', 'a.b.c'],
    ['https://[::1]:8080/x', '[::1]'],
    ['chrome://newtab/', ''],
    ['chrome-extension://abcdef/page.html', ''],
    ['about:blank', ''],
    ['file:///tmp/x.html', ''],
    ['javascript:alert(1)', ''],
    ['data:text/html,hello', ''],
    ['not a url', ''],
    ['https://', ''],
    ['', ''],
    ['   ', '']
  ];
  for (const [input, expected] of table) {
    test(JSON.stringify(input), () => assert.equal(hostOf(input), expected));
  }
  test('anything that is not a string gives "" and never throws', () => {
    for (const bad of [undefined, null, 5, {}, [], Symbol.iterator] as unknown[]) assert.equal(hostOf(bad as string), '');
  });
});

describe('registrableHost', () => {
  const table: Array<[string, string]> = [
    ['www.frame.work', 'frame.work'],
    ['frame.work', 'frame.work'],
    ['shop.idealo.de', 'idealo.de'],
    ['a.b.c.example.com', 'example.com'],
    ['www.amazon.co.uk', 'amazon.co.uk'],
    ['a.b.shop.com.au', 'shop.com.au'],
    ['shop.co.jp', 'shop.co.jp'],
    ['www.example.com.br', 'example.com.br'],
    ['example.co.in', 'example.co.in'],
    ['x.y.co.nz', 'y.co.nz'],
    ['shop.com.mx', 'shop.com.mx'],
    ['a.co.za', 'a.co.za'],
    ['m.a.com.tr', 'a.com.tr'],
    ['www.a.com.sg', 'a.com.sg'],
    ['co.uk', 'co.uk'],
    ['localhost', 'localhost'],
    ['127.0.0.1', '127.0.0.1'],
    ['192.168.1.10', '192.168.1.10'],
    ['FRAME.WORK.', 'frame.work'],
    ['www.', ''],
    ['', '']
  ];
  for (const [input, expected] of table) {
    test(JSON.stringify(input), () => assert.equal(registrableHost(input), expected));
  }
  test('siteOf = registrableHost(hostOf(url))', () => {
    assert.equal(siteOf('https://www.idealo.de/preisvergleich/x'), 'idealo.de');
    assert.equal(siteOf('https://m.shop.co.uk/a'), 'shop.co.uk');
    assert.equal(siteOf('chrome://newtab'), '');
  });
});

describe('normalizeUrlForMatch', () => {
  const FC = 'frame.work/de/en/products/laptop16-amd-ai300/configuration/new';
  const table: Array<[string, string]> = [
    [`https://${FC}`, FC],
    [`http://${FC}`, FC],
    [`HTTPS://WWW.FRAME.WORK/de/en/products/laptop16-amd-ai300/configuration/new`, FC],
    [`https://www.${FC}/`, FC],
    [`https://${FC}///`, FC],
    [`https://${FC}#specs`, FC],
    [`https://${FC}?utm_source=newsletter&utm_medium=email`, FC],
    [`https://${FC}?gclid=abc&fbclid=def&mc_eid=1&ref=tw`, FC],
    [`https://${FC}?variant=2&utm_campaign=x`, `${FC}?variant=2`],
    [`https://${FC}?b=2&a=1`, `${FC}?a=1&b=2`],
    [`https://${FC}?a=1&b=2`, `${FC}?a=1&b=2`],
    ['https://frame.work:443/de', 'frame.work/de'],
    ['http://www.frame.work:80/', 'frame.work'],
    ['https://frame.work:8443/x', 'frame.work:8443/x'],
    [`${FC}`, FC],
    [`www.${FC}`, FC],
    ['https://frame.work/De/En/X', 'frame.work/De/En/X'],
    ['https://frame.work', 'frame.work'],
    ['https://frame.work/', 'frame.work'],
    ['https://shop.test:8080/a/', 'shop.test:8080/a'],
    ['  https://frame.work/x  ', 'frame.work/x'],
    ['', ''],
    ['not a url', 'not a url'],
    ['mailto:a@b.de', 'mailto:a@b.de']
  ];
  for (const [input, expected] of table) {
    test(JSON.stringify(input), () => assert.equal(normalizeUrlForMatch(input), expected));
  }
  test('a different path is a different page', () => {
    assert.notEqual(normalizeUrlForMatch('https://frame.work/de'), normalizeUrlForMatch('https://frame.work/de/en/de'));
    assert.notEqual(normalizeUrlForMatch(`https://${FC}`), normalizeUrlForMatch('https://frame.work/de/en/products/laptop16-amd-7040/configuration/new'));
  });
  test('never throws', () => {
    for (const bad of [undefined, null, 5, {}, []] as unknown[]) assert.equal(normalizeUrlForMatch(bad as string), '');
  });
  test('isOriginOnly: a front door, not a page', () => {
    assert.equal(isOriginOnly('https://www.idealo.de'), true);
    assert.equal(isOriginOnly('https://www.idealo.de/'), true);
    assert.equal(isOriginOnly('https://www.idealo.de/?utm_source=x'), true);
    assert.equal(isOriginOnly('https://www.idealo.de/preisvergleich'), false);
    assert.equal(isOriginOnly('https://www.idealo.de/?q=x'), false);
    assert.equal(isOriginOnly(''), false);
  });
});

describe('scanSites: links and site names in text', () => {
  const hosts = (text: string): string[] => scanSites(text).map((s) => s.host);
  const raws = (text: string): string[] => scanSites(text).map((s) => s.raw);

  test('links, bare domains and www. names', () => {
    const found = scanSites('See https://www.idealo.de/foo/bar?x=1. Also idealo.de and geizhals.de/preise, www.frame.work');
    assert.deepEqual(
      found.map((s) => [s.raw, s.host, s.isUrl]),
      [
        ['https://www.idealo.de/foo/bar?x=1', 'idealo.de', true],
        ['idealo.de', 'idealo.de', false],
        ['geizhals.de/preise', 'geizhals.de', true],
        ['www.frame.work', 'frame.work', false]
      ]
    );
  });
  test('offsets point at the text as written', () => {
    const text = 'Go to idealo.de now.';
    const [site] = scanSites(text);
    assert.equal(text.slice(site!.start, site!.end), 'idealo.de');
  });
  test('file names, abbreviations, versions and e-mail addresses are not sites', () => {
    assert.deepEqual(hosts('Edit page.js, notes.md, main.py, index.html and style.css, e.g. like i.e. this.'), []);
    assert.deepEqual(hosts('Write to support@idealo.de or a@b.de'), []);
    assert.deepEqual(hosts('v1.2.3 192.168.0.1 30.09.2026 2.069,00 EUR 4.5 stars'), []);
    assert.deepEqual(hosts('The price.It was 5. No.5 is sold out.'), []);
  });
  test('a domain with a known ending and any case', () => {
    assert.deepEqual(hosts('Idealo.de and IDEALO.DE and idealo.DE'), ['idealo.de', 'idealo.de']);
  });
  test('punctuation after a link is not part of it; a ")" that closes a "(" in the link is', () => {
    assert.deepEqual(raws('(https://a.de/x) and https://b.de/y. or "https://c.de/z", or https://d.de/w; https://e.de/w_(v).'), [
      'https://a.de/x',
      'https://b.de/y',
      'https://c.de/z',
      'https://d.de/w',
      'https://e.de/w_(v)'
    ]);
  });
  test('markdown and angle brackets', () => {
    assert.deepEqual(raws('[text](https://a.de/x) <https://b.de/y> **https://c.de/z**'), ['https://a.de/x', 'https://b.de/y', 'https://c.de/z']);
  });
  test('a link written right behind the closing ")" of another is found too', () => {
    assert.deepEqual(raws('[page](https://frame.work/ok)https://www.idealo.de/fake'), ['https://frame.work/ok', 'https://www.idealo.de/fake']);
  });
  test('a domain written with a path is a link; a site name inside its path is part of it', () => {
    const found = scanSites('idealo.de/preisvergleich/x and a.de/x?u=geizhals.de');
    assert.deepEqual(
      found.map((s) => [s.raw, s.isUrl]),
      [
        ['idealo.de/preisvergleich/x', true],
        ['a.de/x?u=geizhals.de', true]
      ]
    );
  });
  test('hostsNamedIn: each registrable host once, in order', () => {
    assert.deepEqual(hostsNamedIn('frame.work, then https://www.idealo.de/x and idealo.de again, then m.geizhals.de'), ['frame.work', 'idealo.de', 'geizhals.de']);
  });
  test('extractUrls returns links only', () => {
    assert.deepEqual(
      extractUrls('idealo.de and https://a.de/x and geizhals.de/y').map((s) => s.raw),
      ['https://a.de/x', 'geizhals.de/y']
    );
  });
  test('looksLikeDomain', () => {
    for (const yes of ['idealo.de', 'frame.work', 'www.geizhals.de', 'shop.co.uk', 'a.io', 'shop.test']) assert.equal(looksLikeDomain(yes), true, yes);
    for (const no of ['page.js', 'notes.md', 'e.g', 'a.b', 'Price.It', '2.069', 'no-dot', '', '.de', 'a..de']) assert.equal(looksLikeDomain(no), false, no);
  });
  test('maskLinks keeps the length and hides the digits of links only', () => {
    const text = 'EUR 5 at https://a.de/2069/x?n=1 and 2,069';
    const masked = maskLinks(text);
    assert.equal(masked.length, text.length);
    assert.ok(!/2069\/x/.test(masked));
    assert.ok(masked.startsWith('EUR 5 at '));
    assert.ok(masked.endsWith(' and 2,069'));
  });
});

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

describe('canonicalAmounts: one numeral, every format', () => {
  const table: Array<[string, number[]]> = [
    ['2,069.00', [2069]],
    ['2.069,00', [2069]],
    ['2069', [2069]],
    ['2069.00', [2069]],
    ['2 069', [2069]],
    [`2${NBSP}069,00`, [2069]],
    ["2'069.00", [2069]],
    ['1.234.567,89', [1234567.89]],
    ['1,234,567.89', [1234567.89]],
    ['12.50', [12.5]],
    ['4,99', [4.99]],
    ['0,48', [0.48]],
    ['0.123', [0.123]],
    ['1.399', [1399, 1.399]],
    ['1,399', [1399, 1.399]],
    ['12.345', [12345, 12.345]],
    ['123.456', [123456, 123.456]],
    ['1234.567', [1234.567]],
    ['EUR 2,069.00', [2069]],
    ['2.149 Euro', [2149, 2.149]],
    ['5 340', [5340]],
    ['12 34', [12]],
    ['abc', []],
    ['', []],
    ['1.2.3', []],
    ['30.09.2026', []]
  ];
  for (const [input, expected] of table) {
    test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => assert.deepEqual(canonicalAmounts(input), expected));
  }
  test('sameAmount: either reading matches, thousandths decide', () => {
    assert.equal(sameAmount([2069], [2069.0]), true);
    assert.equal(sameAmount([1399, 1.399], [1399]), true);
    assert.equal(sameAmount([1399, 1.399], [1.399]), true);
    assert.equal(sameAmount([2069], [2070]), false);
    assert.equal(sameAmount([2069, 2.069], [2070, 2.07]), false, '2.069 and 2.07 must not collide at cent precision');
    assert.notEqual(amountKey(2.069), amountKey(2.07));
    assert.equal(amountKey(12.5), amountKey(12.5));
  });
  test('never throws', () => {
    assert.deepEqual(canonicalAmounts(undefined as unknown as string), []);
    assert.deepEqual(canonicalAmounts('9'.repeat(400)), canonicalAmounts('9'.repeat(200)));
  });
});

describe('scanNumbers: money', () => {
  // [text, raw of the token, values, currency]
  const table: Array<[string, string, number[], string]> = [
    ['EUR 2,069.00', 'EUR 2,069.00', [2069], 'EUR'],
    [`${EURO}2,069`, `${EURO}2,069`, [2069, 2.069], 'EUR'],
    ['2.069,00 EUR', '2.069,00 EUR', [2069], 'EUR'],
    ['1 399 EUR', '1 399 EUR', [1399], 'EUR'],
    [`ab 1${NBSP}399 EUR`, '1 399 EUR', [1399], 'EUR'],
    ['EUR 1399', 'EUR 1399', [1399], 'EUR'],
    ['2069 Euro', '2069 Euro', [2069], 'EUR'],
    ['$1,299.99', '$1,299.99', [1299.99], 'USD'],
    ['USD 50', 'USD 50', [50], 'USD'],
    ['50 USD', '50 USD', [50], 'USD'],
    ['\u00a312.50', '\u00a312.50', [12.5], 'GBP'],
    ["CHF 2'069.00", "CHF 2'069.00", [2069], 'CHF'],
    ['2.149 Euro', '2.149 Euro', [2149, 2.149], 'EUR'],
    ['1.950 EUR', '1.950 EUR', [1950, 1.95], 'EUR'],
    ['EUR2,069', 'EUR2,069', [2069, 2.069], 'EUR'],
    ['2069EUR', '2069EUR', [2069], 'EUR'],
    ['eur 4,99', 'eur 4,99', [4.99], 'EUR'],
    ['4,99 \u20ac', '4,99 \u20ac', [4.99], 'EUR'],
    ['\u20ac 2.079,00', '\u20ac 2.079,00', [2079], 'EUR'],
    ['EUR 2 069,00', 'EUR 2 069,00', [2069], 'EUR'],
    ['Preis: 2.069,00 Euros', '2.069,00 Euros', [2069], 'EUR']
  ];
  for (const [text, raw, values, currency] of table) {
    test(JSON.stringify(text), () => {
      const money = scanNumbers(text).money.filter((t) => t.currency !== '');
      assert.equal(money.length, 1, JSON.stringify(money));
      assert.equal(money[0]?.raw, raw);
      assert.deepEqual(money[0]?.values, values);
      assert.equal(money[0]?.currency, currency);
      assert.equal(text.slice(money[0]!.start, money[0]!.end).replace(NBSP, ' '), raw);
    });
  }
  test('a malformed numeral beside a currency is still an amount (a typo for a German price)', () => {
    const [t] = extractMoney('EUR 2,149,00');
    assert.deepEqual(t?.values, [2149]);
    assert.deepEqual(extractMoney('12,34,56 EUR')[0]?.values, [1234.56]);
  });
  test('a malformed numeral with no currency is not an amount (dates, versions, addresses)', () => {
    assert.deepEqual(scanNumbers('30.09.2026 v1.2.3 192.168.0.1 1.234.5').money, []);
  });
  test('thousands written with spaces count only beside a currency: "Ryzen AI 5 340" is not 5340', () => {
    assert.deepEqual(scanNumbers('AMD Ryzen AI 5 340 16GB (2x8GB) Memory 512GB Storage Windows 11 Pro').money, []);
    assert.deepEqual(scanNumbers('Batch 1 2 3 4 5').money, []);
  });
  test('bare numbers: a price shape (thousands, two decimals, four digits) counts as an amount, small numbers never do', () => {
    const shapes = scanNumbers('Preis: 2.069,00 und 1.399 und 12.50 and 4,99 and 2069.00').money;
    assert.deepEqual(shapes.map((t) => t.raw), ['2.069,00', '1.399', '12.50', '4,99', '2069.00']);
    assert.ok(shapes.every((t) => t.currency === '' && t.priceShape));
    assert.deepEqual(scanNumbers('16GB 512GB Windows 11 Batch 3 step 2 of 5 about 4.5 stars').money, []);
    assert.deepEqual(scanNumbers('in 2026, 1999 and 2100').money, [], 'years are not amounts');
  });
  test('a price word before a bare number is noted (priceContext)', () => {
    const [a, b] = scanNumbers('Price: 2.069,00 and 12.50 more').money;
    assert.equal(a?.priceContext, true);
    assert.equal(b?.priceContext, false);
    assert.equal(scanNumbers('lab 2,069').money[0]?.priceContext, false, 'a price word is a whole word: "lab" does not end in "ab"');
    assert.equal(scanNumbers('from 4,99').money[0]?.priceContext, true);
    assert.equal(scanNumbers('ab 4,99').money[0]?.priceContext, true);
  });
  test('approximation markers: about, approx., approximately, around, roughly, circa, ca., rund, etwa, ungefaehr, ~', () => {
    const table2: Array<[string, boolean]> = [
      ['about EUR 2,070', true],
      ['approx. EUR 2,070', true],
      ['approximately EUR 2,070', true],
      ['around 2,070 EUR', true],
      ['roughly EUR 2,100', true],
      ['circa 2.070 EUR', true],
      ['ca. 2.070 EUR', true],
      ['rund 2.070 EUR', true],
      ['etwa 2.070 EUR', true],
      ['ungef\u00e4hr 2.070 EUR', true],
      ['ungefaehr 2.070 EUR', true],
      ['~2,070 EUR', true],
      ['\u22482,070 EUR', true],
      ['EUR 2,070', false],
      ['a cat 2,070 EUR', false],
      ['abc 2,070 EUR', false]
    ];
    for (const [text, expected] of table2) assert.equal(scanNumbers(text).money[0]?.approx, expected, text);
  });
  test('digits inside a link are not numbers once the links are masked', () => {
    assert.deepEqual(extractMoney('EUR 5 at https://a.de/price/2,069.00-EUR/x').map((t) => t.raw), ['EUR 5']);
  });
});

describe('scanNumbers: percentages', () => {
  const table: Array<[string, string, number]> = [
    ['+5.8% above', '5.8%', 5.8],
    ['5,8 % above', '5,8 %', 5.8],
    ['0.48%', '0.48%', 0.48],
    ['0,5 %', '0,5 %', 0.5],
    ['10 percent', '10 percent', 10],
    ['12 Prozent', '12 Prozent', 12],
    ['7 per cent', '7 per cent', 7],
    ['15%', '15%', 15],
    ['100%', '100%', 100]
  ];
  for (const [text, raw, value] of table) {
    test(JSON.stringify(text), () => {
      const [t] = extractPercents(text);
      assert.equal(t?.raw, raw);
      assert.equal(t?.value, value);
    });
  }
  test('"% Off" without a number is nothing', () => {
    assert.deepEqual(extractPercents('Base Pre-order % Off EUR 2,069'), []);
  });
  test('a marker before a percentage', () => {
    assert.equal(extractPercents('about 6% more')[0]?.approx, true);
    assert.equal(extractPercents('6% more')[0]?.approx, false);
  });
});

describe('scanNumbers: durations', () => {
  const table: Array<[string, string, number, number, string]> = [
    ['3-5 business days', '3-5 business days', 3, 5, 'bday'],
    ['3 - 5 working days', '3 - 5 working days', 3, 5, 'bday'],
    ['2 bis 5 Werktage', '2 bis 5 Werktage', 2, 5, 'bday'],
    ['3-5 Werktagen', '3-5 Werktagen', 3, 5, 'bday'],
    ['2 to 5 days', '2 to 5 days', 2, 5, 'day'],
    ['2\u20135 Tage', '2\u20135 Tage', 2, 5, 'day'],
    ['2\u20145 days', '2\u20145 days', 2, 5, 'day'],
    ['1 week', '1 week', 1, 1, 'week'],
    ['2-3 Wochen', '2-3 Wochen', 2, 3, 'week'],
    ['24 hours', '24 hours', 24, 24, 'hour'],
    ['48 Stunden', '48 Stunden', 48, 48, 'hour'],
    ['3 months', '3 months', 3, 3, 'month'],
    ['2 Jahre Garantie', '2 Jahre', 2, 2, 'year'],
    ['5 Arbeitstage', '5 Arbeitstage', 5, 5, 'bday'],
    ['in 1 day', '1 day', 1, 1, 'day'],
    ['7 workdays', '7 workdays', 7, 7, 'bday']
  ];
  for (const [text, raw, low, high, unit] of table) {
    test(JSON.stringify(text), () => {
      const [t] = extractDurations(text);
      assert.equal(t?.raw, raw);
      assert.deepEqual([t?.low, t?.high, t?.unit], [low, high, unit]);
    });
  }
  test('unit classes: business/working/Werktage are one class, days/Tage another, and they differ', () => {
    assert.equal(durationUnitOf('Werktagen'), 'bday');
    assert.equal(durationUnitOf('working days'), 'bday');
    assert.equal(durationUnitOf('Business  Days'), 'bday');
    assert.equal(durationUnitOf('Tage'), 'day');
    assert.equal(durationUnitOf('days'), 'day');
    assert.equal(durationUnitOf('weeks'), 'week');
    assert.equal(durationUnitOf('Stunden'), 'hour');
    assert.equal(durationUnitOf('kilometers'), null);
  });
  test('not durations: no unit, a date, a clock time, a count, words that only start like a unit', () => {
    for (const text of ['step 2 of 5', 'on 2026-09-30 at 14:30', '9:00-17:00', '1 source and 1 price', 'Batch 3 ships December', '3 tags', '5 daysofweek', '2 tagged', '16GB 512GB']) {
      assert.deepEqual(extractDurations(text), [], text);
    }
  });
  test('the second number of a range must not be smaller than the first', () => {
    assert.deepEqual(extractDurations('5-3 days').map((t) => [t.low, t.high]), [[3, 3]], 'only "3 days" is read, the "5-" is not a range');
  });
  test('a range with decimals is one duration as written: "2,5-3,5 Werktage" is not "3,5 Werktage"', () => {
    const rows: Array<[string, string, number, number, string]> = [
      ['Lieferung in 2,5-3,5 Werktagen', '2,5-3,5 Werktagen', 2.5, 3.5, 'bday'],
      ['delivery 2.5 to 3.5 days', '2.5 to 3.5 days', 2.5, 3.5, 'day'],
      ['1,5 bis 2 Wochen', '1,5 bis 2 Wochen', 1.5, 2, 'week'],
      ['2-3,5 Wochen', '2-3,5 Wochen', 2, 3.5, 'week'],
      ['2,5 \u2013 3,5 Tage', '2,5 \u2013 3,5 Tage', 2.5, 3.5, 'day']
    ];
    for (const [text, raw, low, high, unit] of rows) {
      const found = extractDurations(text);
      assert.equal(found.length, 1, text);
      assert.equal(found[0]?.raw, raw, text);
      assert.deepEqual([found[0]?.low, found[0]?.high, found[0]?.unit], [low, high, unit], text);
    }
    // A second number that goes on is no range: "1.000" is one thousand, not a 1.
    assert.deepEqual(extractDurations('2-1.000 days'), [], 'no range, and no duration made up of the pieces');
  });
});

// ---------------------------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------------------------

describe('cutAtWord: a value is never shown half', () => {
  test('text that fits comes back trimmed and otherwise as it was', () => {
    assert.equal(cutAtWord('  Shipping: 4,90 EUR  ', 60), 'Shipping: 4,90 EUR');
    assert.equal(cutAtWord('12345678', 8), '12345678');
    assert.equal(cutAtWord('', 10), '');
    assert.equal(cutAtWord(undefined as unknown as string, 10), '');
  });
  test('a longer text is cut between words and marked, at every length', () => {
    const text = 'Shipping: 4,90 EUR and 12.345,67 EUR on top';
    // From 12 on, the first word ("Shipping:") fits in the room; below that a single word is longer than the room (next test).
    for (let max = 12; max < text.length; max++) {
      const out = cutAtWord(text, max);
      assert.ok(out.length <= max, `${max}: "${out}"`);
      assert.ok(out.endsWith('...'), `${max}: "${out}"`);
      const kept = out.slice(0, -3);
      assert.ok(kept === '' || (text.startsWith(kept) && text[kept.length] === ' '), `${max}: "${out}" stops inside a word`);
    }
    assert.equal(cutAtWord(text, 12), 'Shipping:...');
    assert.equal(cutAtWord(text, 20), 'Shipping: 4,90...');
  });
  test('only a single word longer than the room is cut inside, and it is marked too', () => {
    assert.equal(cutAtWord('Standardversandkosten', 12), 'Standardv...');
    assert.equal(cutAtWord('Shipping: 4,90 EUR', 8), 'Shipp...');
    assert.equal(cutAtWord('abc defghijklmnop', 10), 'abc...');
  });
  test('a limit that is not a number falls back to the smallest room', () => {
    assert.equal(cutAtWord('abcdefgh', Number.NaN), 'a...');
    assert.equal(cutAtWord('abcdefgh', -5), 'a...');
  });
});

describe('snippetWithWholeWords: the words the radius cut in half are dropped', () => {
  test('a number at either end that the radius cut is dropped with its word, and the dots stay', () => {
    assert.equal(snippetWithWholeWords('...ersand: 6,90 EUR Lieferung in 3-4 Werkta...', '6,90 EUR'), '...6,90 EUR Lieferung in 3-4...');
    // "1,90" at the front may be the end of "11,90", and "12.3" at the back the start of "12.345,67": both go.
    assert.equal(snippetWithWholeWords('...1,90 EUR Versand 6,90 EUR ab 12.3...', '6,90 EUR'), '...EUR Versand 6,90 EUR ab...');
  });
  test('a snippet that is cut between words, or not cut at all, is left as it is', () => {
    assert.equal(snippetWithWholeWords('... Versand: 6,90 EUR ...', '6,90 EUR'), '... Versand: 6,90 EUR ...');
    assert.equal(snippetWithWholeWords('Versand: 6,90 EUR', '6,90 EUR'), 'Versand: 6,90 EUR');
    assert.equal(snippetWithWholeWords('', ''), '');
    assert.equal(snippetWithWholeWords(undefined as unknown as string), '');
  });
  test('the value the snippet is about is never cut away', () => {
    assert.equal(snippetWithWholeWords('...6,9', '6,90 EUR'), '...6,9');
    assert.equal(snippetWithWholeWords('6,90 EUR Versan...', '6,90 EUR'), '6,90 EUR...');
  });
});

describe('findSnippet', () => {
  const text = 'Framework Laptop 16 Configuration. Base Pre-order % Off EUR 2,069 AMD Ryzen AI 5 340 16GB (2x8GB) Memory 512GB Storage Windows 11 Pro.';
  test('a string is found as written, case does not matter', () => {
    const snip = findSnippet(text, 'eur 2,069', 12);
    assert.equal(snip, '...order % Off EUR 2,069 AMD Ryzen A...');
  });
  test('a number is found as a numeral in any format', () => {
    assert.match(findSnippet(text, 2069, 10) ?? '', /EUR 2,069/);
    assert.match(findSnippet('Preis 2.069,00 EUR ab Lager', 2069, 10) ?? '', /2\.069,00 EUR/);
    assert.match(findSnippet('Rabatt 5,8 % heute', 5.8, 10) ?? '', /5,8 %/);
  });
  test('the radius is a limit and is cut at the ends of the text', () => {
    assert.equal(findSnippet('EUR 2,069', 2069, 100), 'EUR 2,069');
    const small = findSnippet(text, 'Windows', 0);
    assert.equal(small, '...Windows...');
  });
  test('null when the value is not in the text, and never throws', () => {
    assert.equal(findSnippet(text, 'idealo'), null);
    assert.equal(findSnippet(text, 2070), null);
    assert.equal(findSnippet('', 5), null);
    assert.equal(findSnippet(text, ''), null);
    assert.equal(findSnippet(text, Number.NaN), null);
    assert.equal(findSnippet(undefined as unknown as string, 5), null);
    assert.equal(findSnippet(text, 'EUR', -5), '...EUR...');
    assert.equal(typeof findSnippet(text, 'EUR', Number.POSITIVE_INFINITY), 'string');
  });
  test('whitespace in the snippet is collapsed', () => {
    assert.equal(findSnippet('a\n\n  b   EUR 5\tc', 'EUR 5', 20), 'a b EUR 5 c');
  });
});

// ---------------------------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------------------------

const FC = 'https://frame.work/de/en/products/laptop16-amd-ai300/configuration/new';
const page = (l: EvidenceLedger, step: number, url: string, text: string, extra: { title?: string; links?: string[]; kind?: 'page' | 'text' | 'js' | 'network' } = {}) =>
  l.record({ step, kind: extra.kind ?? 'page', url, title: extra.title, text, links: extra.links });

describe('EvidenceLedger: what was opened', () => {
  test('openedHosts: registrable hosts in order of first read, each with the newest URL', () => {
    const l = new EvidenceLedger();
    page(l, 1, 'https://www.google.com/', 'Google');
    page(l, 2, 'https://frame.work/de/en/marketplace/laptops', 'Laptops');
    page(l, 3, FC, 'Configure');
    page(l, 4, 'https://www.idealo.de/x', 'idealo');
    page(l, 5, 'https://shop.idealo.de/y', 'idealo again');
    assert.deepEqual(
      l.openedHosts().map((o) => [o.host, o.url]),
      [
        ['google.com', 'https://www.google.com/'],
        ['frame.work', FC],
        ['idealo.de', 'https://shop.idealo.de/y']
      ]
    );
    assert.equal(l.hasOpened('www.idealo.de'), true);
    assert.equal(l.hasOpened('geizhals.de'), false);
    assert.equal(l.hasOpened(''), false);
  });
  test('pages that are not web pages are evidence but open no site', () => {
    const l = new EvidenceLedger();
    page(l, 1, 'chrome://newtab/', 'New tab EUR 5');
    page(l, 2, 'about:blank', 'blank');
    assert.deepEqual(l.openedHosts(), []);
    assert.equal(l.size, 2);
  });
  test('every kind of read counts: page, text, js and network', () => {
    const l = new EvidenceLedger();
    page(l, 1, 'https://a.de/x', 'snapshot', { kind: 'page' });
    page(l, 2, 'https://b.de/x', 'read_page_text result', { kind: 'text' });
    page(l, 3, 'https://c.de/x', '{"price":"2069.00"}', { kind: 'js' });
    page(l, 4, 'https://d.de/x', '[{"url":"/api"}]', { kind: 'network' });
    assert.deepEqual(l.openedHosts().map((o) => o.host), ['a.de', 'b.de', 'c.de', 'd.de']);
  });
  test('wasVisited compares normalized URLs', () => {
    const l = new EvidenceLedger();
    page(l, 1, FC, 'x');
    assert.equal(l.wasVisited(FC), true);
    assert.equal(l.wasVisited(`http://www.frame.work/de/en/products/laptop16-amd-ai300/configuration/new/?utm_source=a#specs`), true);
    assert.equal(l.wasVisited('https://frame.work/de/en/products/laptop16-amd-ai300'), false);
    assert.equal(l.wasVisited('https://frame.work/de'), false);
    assert.equal(l.wasVisited(''), false);
  });
  test('wasShown: a URL printed in page text, in the title, or listed among the links (also a relative link)', () => {
    const l = new EvidenceLedger();
    page(l, 1, FC, 'Shipping information: https://frame.work/de/en/support/shipping-and-delivery Returns: www.frame.work/de/en/support/returns.', {
      title: 'See https://frame.work/de/en/title-link',
      links: ['https://frame.work/de/en/links/one', '/de/en/links/relative', 'javascript:void(0)', '#top', 7 as unknown as string]
    });
    for (const url of [
      'https://frame.work/de/en/support/shipping-and-delivery',
      'http://www.frame.work/de/en/support/returns/',
      'https://frame.work/de/en/title-link',
      'https://frame.work/de/en/links/one',
      'https://frame.work/de/en/links/relative'
    ]) {
      assert.equal(l.wasShown(url), true, url);
    }
    assert.equal(l.wasShown('https://frame.work/de/en/support'), false, 'a prefix of a shown link is not shown');
    assert.equal(l.wasShown('https://frame.work/de/en/support/shipping'), false);
    assert.equal(l.wasVisited('https://frame.work/de/en/support/shipping-and-delivery'), false, 'shown is not visited');
  });
  test('hasShippingWording: per site and overall', () => {
    const l = new EvidenceLedger();
    page(l, 1, 'https://a.de/x', 'Price EUR 5. Add to cart.');
    page(l, 2, 'https://b.de/x', 'Versand kostenlos. Lieferzeit 2-4 Werktage.');
    assert.equal(l.hasShippingWording('a.de'), false);
    assert.equal(l.hasShippingWording('b.de'), true);
    assert.equal(l.hasShippingWording(), true);
    for (const yes of ['Free shipping', 'Versand 4,99', 'kostenlos', 'Delivery in 2 days', 'Lieferung folgt', 'Lieferzeit', 'Batch 3 ships December', 'Shipped', '3 Werktagen']) assert.equal(hasShippingWording(yes), true, yes);
    for (const no of ['Add to cart', 'freedom', 'relief', 'shipment', 'Compare laptops']) assert.equal(hasShippingWording(no), false, no);
  });
});

describe('EvidenceLedger: the numbers on the pages', () => {
  const build = (): EvidenceLedger => {
    const l = new EvidenceLedger();
    page(l, 1, FC, 'Base Pre-order 10% Off EUR 2,069. Batch 3 ships in 2-3 weeks.');
    page(l, 2, 'https://www.idealo.de/x', 'Bestpreis 2.189,00 EUR. Versand 4,99 EUR. Lieferung in 3-5 Werktagen.', { title: 'ab 2.189,00 EUR | idealo.de' });
    return l;
  };
  test('amounts: per site and overall, newest page first, with the page and the words around', () => {
    const l = build();
    assert.deepEqual(l.amounts('frame.work').map((a) => a.raw), ['EUR 2,069']);
    assert.deepEqual(
      l.amounts().map((a) => [a.host, a.value]),
      [
        ['idealo.de', 2189],
        ['idealo.de', 2189],
        ['idealo.de', 4.99],
        ['frame.work', 2069]
      ],
      'the newest page comes first, and on it the title before the text (both hold the price)'
    );
    const [first] = l.amounts('frame.work');
    assert.equal(first?.url, FC);
    assert.match(l.snippetFor(first!, 20), /10% Off EUR 2,069\./);
    assert.deepEqual(first?.keys, [amountKey(2069), amountKey(2.069)]);
  });
  test('percents and durations', () => {
    const l = build();
    assert.deepEqual(l.percents('frame.work').map((p) => p.value), [10]);
    assert.deepEqual(l.percents('idealo.de'), []);
    assert.deepEqual(l.durations('idealo.de').map((d) => [d.low, d.high, d.unit]), [[3, 5, 'bday']]);
    assert.deepEqual(l.durations('frame.work').map((d) => [d.low, d.high, d.unit]), [[2, 3, 'week']]);
    assert.deepEqual(l.durations('geizhals.de'), []);
  });
  test('a price in a JSON text result is an amount: "price":"2069.00"', () => {
    const l = new EvidenceLedger();
    page(l, 1, FC, '{"sku":"FW16-AI5-340","price":"2069.00","currency":"EUR","memory":"16GB"}', { kind: 'network' });
    assert.deepEqual(l.amounts().map((a) => a.value), [2069]);
  });
  test('model numbers and small counts are not amounts', () => {
    const l = new EvidenceLedger();
    page(l, 1, FC, 'AMD Ryzen AI 5 340 16GB (2x8GB) Memory 512GB Storage Windows 11 Pro Batch 1 Shipped Batch 2 Shipped 4.5 stars 2026');
    assert.deepEqual(l.amounts(), []);
  });
});

describe('EvidenceLedger: record, dedupe and caps', () => {
  test('nothing to store: no URL, no text and no title', () => {
    const l = new EvidenceLedger();
    assert.equal(l.record({ step: 1, kind: 'page', url: '', text: '' }), null);
    assert.equal(l.record({ step: 1, kind: 'page', url: '', title: '  ', text: '   ' }), null);
    assert.equal(l.size, 0);
  });
  test('an identical consecutive read is not stored twice: the step moves up', () => {
    const l = new EvidenceLedger();
    const first = page(l, 1, FC, 'same text');
    const again = page(l, 2, `${FC}/?utm_source=x#frag`, 'same text');
    assert.equal(l.size, 1);
    assert.equal(again, first);
    assert.equal(l.entries[0]?.step, 2);
    page(l, 3, FC, 'other text');
    page(l, 4, FC, 'same text');
    assert.equal(l.size, 3, 'only CONSECUTIVE identical reads are merged');
  });
  test('the text, title, link and URL sizes are capped; control characters become spaces', () => {
    const l = new EvidenceLedger();
    const e = l.record({ step: 1, kind: 'page', url: `https://a.de/${'x'.repeat(5000)}`, title: 't'.repeat(1000), text: `a\u0000b\u0001c${'y'.repeat(20000)}`, links: Array.from({ length: 500 }, (_v, i) => `https://a.de/${i}${'z'.repeat(1000)}`) });
    assert.ok(e);
    assert.equal(e.text.length, MAX_TEXT_CHARS);
    assert.ok(e.text.startsWith('a b c'));
    assert.equal(e.title.length, 300);
    assert.equal(e.url.length, 1500);
    assert.equal(e.links.length, 80);
    assert.ok(e.links.every((x) => x.length <= 240));
  });
  test('record never throws on odd input', () => {
    const l = new EvidenceLedger();
    for (const bad of [null, undefined, 5, 'x', [], { url: 5, text: {}, kind: 'nope', step: 'x', links: 'no' }, { url: 'https://a.de', text: 5 }]) {
      assert.doesNotThrow(() => l.record(bad as never));
    }
    const odd = l.entries.find((e) => e.host === 'a.de');
    assert.equal(odd?.text, '');
    assert.equal(odd?.kind, 'page');
  });
  test(`at most ${MAX_ENTRIES} entries: the oldest go first`, () => {
    const l = new EvidenceLedger();
    for (let i = 0; i < 100; i++) page(l, i, `https://site.test/p${i}`, `page ${i}`);
    assert.equal(l.size, MAX_ENTRIES);
    assert.equal(l.entries[0]?.url, 'https://site.test/p40');
    assert.equal(l.entries.at(-1)?.url, 'https://site.test/p99');
  });
  test('the newest entry of every host survives the cap, however old it is', () => {
    const l = new EvidenceLedger();
    page(l, 0, 'https://rare.de/once', 'the only page of rare.de');
    page(l, 1, 'https://second.de/once', 'the only page of second.de');
    for (let i = 0; i < 150; i++) page(l, i + 2, `https://busy.test/p${i}`, `page ${i}`);
    assert.equal(l.size, MAX_ENTRIES);
    assert.equal(l.hasOpened('rare.de'), true);
    assert.equal(l.hasOpened('second.de'), true);
    assert.deepEqual(l.entries.slice(0, 2).map((e) => e.host), ['rare.de', 'second.de']);
    assert.equal(l.entries.filter((e) => e.host === 'busy.test').length, MAX_ENTRIES - 2);
  });
  test(`about ${MAX_TOTAL_CHARS} characters: long pages are evicted oldest first, the newest of each host stays`, () => {
    const l = new EvidenceLedger();
    page(l, 0, 'https://keep.de/old', 'k'.repeat(5000));
    // Text that is nothing but prices, so there is no prose to cut away and a whole page has to go (see the next test for prose).
    for (let i = 0; i < 40; i++) page(l, i + 1, `https://big.test/p${i}`, `${i} `.padEnd(MAX_TEXT_CHARS, 'EUR 1 '));
    assert.ok(l.totalChars() <= MAX_TOTAL_CHARS, String(l.totalChars()));
    assert.equal(l.hasOpened('keep.de'), true);
    assert.ok(l.size < 40, 'some pages went');
    assert.equal(l.entries.at(-1)?.url, 'https://big.test/p39');
  });
  test('more hosts than fit: the caps still hold (the oldest host goes)', () => {
    const l = new EvidenceLedger();
    for (let i = 0; i < 200; i++) page(l, i, `https://host${i}.test/x`, 'y'.repeat(2000));
    assert.ok(l.size <= MAX_ENTRIES);
    assert.ok(l.totalChars() <= MAX_TOTAL_CHARS);
    assert.equal(l.hasOpened('host199.test'), true);
    assert.equal(l.hasOpened('host0.test'), false);
  });
  test('clear forgets everything', () => {
    const l = new EvidenceLedger();
    page(l, 1, FC, 'x');
    l.clear();
    assert.equal(l.size, 0);
    assert.deepEqual(l.openedHosts(), []);
    assert.equal(l.wasVisited(FC), false);
  });
});

describe('EvidenceLedger: snapshot', () => {
  const fill = (): EvidenceLedger => {
    const l = new EvidenceLedger();
    page(l, 1, FC, 'Base EUR 2,069. Ships in 2-3 weeks. 10% Off. https://frame.work/de/en/support/returns', { title: 'Configure', links: ['https://frame.work/de/en/x', '/de/en/y'] });
    page(l, 2, 'https://www.idealo.de/x', 'Bestpreis 2.189,00 EUR', { kind: 'text' });
    return l;
  };
  test('round trip through JSON: the same entries, the same answers to every query', () => {
    const l = fill();
    const json = JSON.stringify(l.toSnapshot());
    const back = EvidenceLedger.fromSnapshot(JSON.parse(json));
    assert.deepEqual(back.toSnapshot(), l.toSnapshot());
    assert.deepEqual(back.openedHosts(), l.openedHosts());
    assert.deepEqual(back.amounts(), l.amounts());
    assert.deepEqual(back.percents(), l.percents());
    assert.deepEqual(back.durations(), l.durations());
    assert.equal(back.wasVisited(FC), true);
    assert.equal(back.wasShown('https://frame.work/de/en/support/returns'), true);
    assert.equal(back.wasShown('https://frame.work/de/en/y'), true);
    assert.deepEqual(ledgerFromSnapshot(JSON.parse(json)).toSnapshot(), l.toSnapshot());
    assert.equal(JSON.stringify(back.toSnapshot()), json);
  });
  test('the snapshot is plain JSON with nothing derived in it', () => {
    const snap = fill().toSnapshot();
    assert.equal(snap.v, 1);
    assert.deepEqual(Object.keys(snap.entries[0]!).sort(), ['kind', 'links', 'step', 'text', 'title', 'url']);
    assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
  });
  test('the ledger itself is JSON too (no hidden state on the instance)', () => {
    const l = fill();
    assert.deepEqual(Object.keys(l), ['entries']);
    assert.doesNotThrow(() => JSON.stringify(l));
  });
  test('a full ledger stays well under 400 KB as JSON, even with hostile text', () => {
    const l = new EvidenceLedger();
    for (let i = 0; i < 200; i++) {
      page(l, i, `https://host${i % 30}.test/p${i}`, `"\\${'"\\'.repeat(3000)}${'\u20ac'.repeat(3000)}`, { title: '"'.repeat(300), links: Array.from({ length: 80 }, (_v, n) => `https://x.test/${'"'.repeat(200)}${n}`) });
    }
    const size = JSON.stringify(l.toSnapshot()).length;
    assert.ok(size < 400_000, `snapshot is ${size} characters`);
    assert.ok(l.size <= MAX_ENTRIES);
  });
  test('garbage in, empty or partial ledger out, never a throw', () => {
    for (const bad of [undefined, null, 5, 'x', [], {}, { entries: 'no' }, { entries: [null, 5, 'x', {}] }, { v: 99, entries: {} }]) {
      assert.doesNotThrow(() => EvidenceLedger.fromSnapshot(bad));
      assert.equal(EvidenceLedger.fromSnapshot(bad).size, 0);
    }
    const partial = EvidenceLedger.fromSnapshot({ entries: [null, { url: 'https://a.de/x', text: 'ok', kind: 'js', step: 3 }, { url: 7 }] });
    assert.deepEqual(partial.entries.map((e) => [e.host, e.kind, e.step]), [['a.de', 'js', 3]]);
  });
  test('a snapshot is capped like a live ledger (an oversized one is trimmed on load)', () => {
    const entries = Array.from({ length: 300 }, (_v, i) => ({ step: i, kind: 'page', url: `https://site.test/p${i}`, title: '', text: 'x', links: [] }));
    assert.equal(EvidenceLedger.fromSnapshot({ v: 1, entries }).size, MAX_ENTRIES);
  });
});

// ---------------------------------------------------------------------------------------------
// The second review round: links in the spellings a browser and a model use, and a ledger that keeps what it read
// ---------------------------------------------------------------------------------------------

describe('links as a browser reads them', () => {
  test('a percent-encoded address and the address as it was typed are the same page (path and query, "+" and %20 alike)', () => {
    assert.equal(normalizeUrlForMatch('https://www.idealo.de/s?q=k%C3%BChlschrank'), normalizeUrlForMatch('https://www.idealo.de/s?q=kühlschrank'));
    assert.equal(normalizeUrlForMatch('https://a.de/s?q=framework+laptop+16'), normalizeUrlForMatch('https://a.de/s?q=framework%20laptop%2016'));
    assert.equal(normalizeUrlForMatch('https://a.de/caf%C3%A9/x'), normalizeUrlForMatch('https://a.de/café/x'));
  });
  test('but an encoded separator stays a separator: "a%2Fb" is not "a/b", and a broken sequence is kept as written', () => {
    assert.notEqual(normalizeUrlForMatch('https://a.de/a%2Fb'), normalizeUrlForMatch('https://a.de/a/b'));
    assert.notEqual(normalizeUrlForMatch('https://a.de/s?x=a%26b'), normalizeUrlForMatch('https://a.de/s?x=a&b'));
    assert.doesNotThrow(() => normalizeUrlForMatch('https://a.de/s?q=%zz'));
    assert.notEqual(normalizeUrlForMatch('https://a.de/s?q=%zz'), normalizeUrlForMatch('https://a.de/s?q=zz'));
  });
  test('urlCovers: the same page with FEWER parameters (a site added one on a redirect), never with more or other ones', () => {
    assert.equal(urlCovers('a.de/s?fs=x&hloc=de', 'a.de/s?fs=x'), true);
    assert.equal(urlCovers('a.de/s?fs=x', 'a.de/s?fs=x&hloc=de'), false);
    assert.equal(urlCovers('a.de/s?fs=x', 'a.de/s?fs=y'), false);
    assert.equal(urlCovers('a.de/s', 'a.de/s'), true);
    assert.equal(urlCovers('a.de/s?fs=x', 'a.de/other'), false);
    assert.equal(urlCovers('', 'a.de/s'), false);
  });
  test('the ledger uses it: a link that dropped a parameter was visited, one that added a parameter was not', () => {
    const l = new EvidenceLedger();
    page(l, 1, 'https://geizhals.de/?fs=framework+laptop+16&hloc=de&in=', 'x');
    assert.equal(l.wasVisited('https://geizhals.de/?fs=framework+laptop+16'), true);
    assert.equal(l.wasVisited('https://geizhals.de/?fs=framework+laptop+16&hloc=at'), false);
    assert.equal(l.wasVisited('https://geizhals.de/?fs=other'), false);
  });
  test('a link with user info is never the address it reads like: "https://www.idealo.de@frame.work/x" opens frame.work', () => {
    assert.equal(hostOf('https://www.idealo.de@frame.work/x'), 'frame.work');
    assert.equal(hasUserInfo('https://www.idealo.de@frame.work/x'), true);
    assert.equal(hasUserInfo('https://user:pw@shop.test/a'), true);
    assert.equal(hasUserInfo('https://frame.work/x@y'), false);
    assert.notEqual(normalizeUrlForMatch('https://www.idealo.de@frame.work/x'), normalizeUrlForMatch('https://frame.work/x'));
    const l = new EvidenceLedger();
    page(l, 1, 'https://frame.work/x', 'x');
    assert.equal(l.wasVisited('https://www.idealo.de@frame.work/x'), false);
  });
  test('a backslash ends the host, as it does in a browser', () => {
    assert.equal(hostOf('https://www.idealo.de\\@frame.work/x'), 'www.idealo.de');
    assert.equal(hasUserInfo('https://www.idealo.de\\@frame.work/x'), false);
  });
  test('a host in other letters is its punycode form, a different site, and never silently dropped', () => {
    assert.equal(hostOf('https://www.idealö.de/x'), 'www.xn--ideal-nua.de');
    assert.equal(siteOf('https://www.idealö.de/x'), 'xn--ideal-nua.de');
    assert.deepEqual(extractUrls('see https://www.idealö.de/preisvergleich/x').map((u) => u.host), ['xn--ideal-nua.de']);
  });
  test('frontDoorHost: only a genuine front door has one (no port, no user info, no path)', () => {
    const table: Array<[string, string]> = [
      ['https://www.idealo.de', 'idealo.de'],
      ['https://idealo.de/', 'idealo.de'],
      ['http://IDEALO.DE/?utm_source=a', 'idealo.de'],
      ['https://shop.idealo.de', 'shop.idealo.de'],
      ['https://www.idealo.de.frame.work', 'idealo.de.frame.work'],
      ['https://idealo.de:8443', ''],
      ['https://user@idealo.de', ''],
      ['https://idealo.de/x', ''],
      ['https://idealo.de/?q=x', ''],
      ['not a url', '']
    ];
    for (const [url, expected] of table) assert.equal(frontDoorHost(url), expected, url);
  });
  test('shared hosting platforms are not one site: every *.myshopify.com store, *.github.io page and *.blogspot.com blog is its own', () => {
    assert.equal(registrableHost('keychron-de.myshopify.com'), 'keychron-de.myshopify.com');
    assert.equal(registrableHost('www.foo.blogspot.com'), 'foo.blogspot.com');
    assert.equal(registrableHost('a.b.github.io'), 'b.github.io');
    assert.notEqual(siteOf('https://a.myshopify.com/p'), siteOf('https://b.myshopify.com/p'));
    assert.equal(registrableHost('shop.example.co.uk'), 'example.co.uk', 'the old multi-part suffixes are unchanged');
  });
});

describe('numbers, second round', () => {
  test('"24h", "24 h" and "12 Std." are hours; a lone "h" beside no number is not', () => {
    assert.deepEqual(extractDurations('Lieferung in 24h').map((d) => [d.low, d.high, d.unit]), [[24, 24, 'hour']]);
    assert.deepEqual(extractDurations('in 24 h').map((d) => [d.low, d.high, d.unit]), [[24, 24, 'hour']]);
    assert.deepEqual(extractDurations('in 12 Std. geliefert').map((d) => [d.low, d.high, d.unit]), [[12, 12, 'hour']]);
    assert.deepEqual(extractDurations('Model H and h alone'), []);
    assert.equal(durationUnitOf('Std.'), 'hour');
    assert.equal(durationUnitOf('h'), 'hour');
  });
  test('money and percentages carry how precisely they were written', () => {
    assert.deepEqual(extractMoney('EUR 2,100').map((m) => m.decimals), [0]);
    assert.deepEqual(extractMoney('2.049,00 EUR').map((m) => m.decimals), [2]);
    assert.deepEqual(extractMoney('EUR 12.5').map((m) => m.decimals), [1]);
    assert.deepEqual(extractPercents('6% and 5.8% and 5,80 %').map((m) => m.decimals), [0, 1, 2]);
  });
  test('the ledger says whether an amount is written to the cent (a review count "1.399" is not)', () => {
    const l = new EvidenceLedger();
    page(l, 1, 'https://www.idealo.de/x', 'Bestpreis 2.049,00 EUR. 1.399 Bewertungen. 5000 mAh. 10115 Berlin.');
    const byRaw = new Map(l.amounts().map((a) => [a.raw.trim(), a]));
    assert.equal(byRaw.get('2.049,00 EUR')?.priced, true);
    assert.equal(byRaw.get('2.049,00 EUR')?.decimals, 2);
    for (const [raw, a] of byRaw) if (raw.startsWith('1.399') || raw.startsWith('5000') || raw.startsWith('10115')) assert.equal(a.priced || a.decimals >= 2, false, raw);
  });
  test('a long run of space-separated three-digit numbers is fast (it was quadratic: 95 seconds for a 300,000 character answer)', () => {
    const runs = ['1' + ' 000'.repeat(20_000), Array.from({ length: 12_000 }, (_v, i) => String(100 + ((i * 37) % 900))).join(' ')];
    for (const text of runs) {
      const t0 = Date.now();
      scanNumbers(text);
      assert.ok(Date.now() - t0 < 500, `${Date.now() - t0} ms for ${text.length} characters`);
    }
  });
  test('thousands written with spaces still work, up to five groups', () => {
    assert.deepEqual(extractMoney('1 399 EUR').map((m) => m.values), [[1399]]);
    assert.deepEqual(extractMoney('1 234 567 890 123 456 EUR').map((m) => m.values), [[1234567890123456]]);
  });
});

describe('EvidenceLedger: what it keeps when it is full', () => {
  const PRICE_PAGE = 'https://frame.work/de/en/products/laptop16-amd-ai300/configuration/new';
  const prose = (n: number): string => `${'The Framework Laptop 16 is a modular laptop that you can repair and upgrade yourself. '.repeat(70)}${n}`.slice(0, 5900);

  test('condenseText keeps the lines around every number and every link, and drops the prose between', () => {
    const text = `${prose(0)} Base Pre-order EUR 2,069 and more prose. ${prose(1)} See https://frame.work/de/en/support/returns ${prose(2)}`;
    const short = condenseText(text);
    assert.ok(short.length < text.length / 4, `${short.length} of ${text.length}`);
    assert.match(short, /EUR 2,069/);
    assert.match(short, /https:\/\/frame\.work\/de\/en\/support\/returns/);
    assert.ok(short.includes(' ... '));
    assert.equal(condenseText('no numbers or links here at all'), '');
    assert.equal(condenseText('EUR 5'), 'EUR 5', 'it is never longer than the text');
    assert.equal(condenseText(undefined as never), '');
    assert.ok(CONDENSE_RADIUS > 0);
  });
  test('an old page that holds the price is cut down before it is dropped: the price is still found after 40 more reads', () => {
    const l = new EvidenceLedger();
    page(l, 1, PRICE_PAGE, `${prose(0)} Base Pre-order EUR 2,069 ${prose(1)}`);
    for (let i = 0; i < 40; i++) page(l, i + 2, `https://frame.work/de/en/marketplace/p${i}`, prose(i));
    assert.ok(l.totalChars() <= MAX_TOTAL_CHARS, String(l.totalChars()));
    assert.equal(l.wasVisited(PRICE_PAGE), true);
    assert.equal(l.amounts().some((a) => a.value === 2069 && a.url === PRICE_PAGE), true, 'the price of the first page survived');
  });
  test('which pages and sites were read does not depend on the text that fits: 150 sites and 500 pages later they still count', () => {
    const l = new EvidenceLedger();
    page(l, 0, PRICE_PAGE, 'EUR 2,069');
    for (let i = 0; i < 150; i++) page(l, i + 1, `https://host${i}.test/x`, 'y'.repeat(3000));
    for (let i = 0; i < 300; i++) page(l, 200 + i, `https://busy.test/p${i}`, 'z');
    assert.equal(l.hasOpened('host140.test'), true);
    assert.equal(l.hasOpened('host149.test'), true);
    assert.ok(l.openedHosts().length <= MAX_HOSTS);
    assert.equal(l.wasVisited('https://busy.test/p299'), true);
    assert.ok(MAX_VISITS >= 400);
  });
  test('the visit list and the redirect list survive a snapshot, and an old snapshot without them still loads', () => {
    const l = new EvidenceLedger();
    l.record({ step: 1, kind: 'page', url: 'https://x.com/home', title: 'X', text: 'hello', via: ['twitter.com'] });
    for (let i = 0; i < 80; i++) page(l, i + 2, `https://site${i}.test/x`, 'y'.repeat(3000));
    const snap = JSON.parse(JSON.stringify(l.toSnapshot()));
    assert.ok(Array.isArray(snap.visits));
    const back = EvidenceLedger.fromSnapshot(snap);
    assert.equal(back.hasOpened('twitter.com'), true);
    assert.equal(back.hasOpened('x.com'), true);
    assert.equal(back.wasVisited('https://x.com/home'), true);
    const old = EvidenceLedger.fromSnapshot({ v: 1, entries: snap.entries });
    assert.equal(old.hasOpened('site79.test'), true, 'a snapshot from before the visit list is rebuilt from its entries');
  });
  test('a site the tab was sent to and landed elsewhere (twitter.com -> x.com) counts as opened through the page it landed on', () => {
    const l = new EvidenceLedger();
    l.record({ step: 1, kind: 'page', url: 'https://x.com/home', title: 'X', text: 'Price EUR 5', via: ['twitter.com'] });
    assert.equal(l.hasOpened('twitter.com'), true);
    assert.equal(l.hasOpened('x.com'), true);
    assert.deepEqual(l.openedHosts().map((o) => o.host), ['x.com', 'twitter.com']);
    assert.equal(l.amounts('twitter.com').length, 1, 'its pages are the pages it led to');
    assert.equal(l.hasOpened('t.co'), false);
    l.record({ step: 2, kind: 'page', url: 'https://x.com/home', title: 'X', text: 'Price EUR 5', via: ['twitter.com', 'twitter.com', 'x.com', 5 as never] });
    assert.equal(l.entries[0]?.via.length, 1, 'no duplicates, and never its own site');
  });
  test('hasHostname: a tab stood on exactly this hostname (shop.idealo.de is not idealo.de)', () => {
    const l = new EvidenceLedger();
    page(l, 1, 'https://www.idealo.de/x', 'a');
    assert.equal(l.hasHostname('idealo.de'), true);
    assert.equal(l.hasHostname('www.idealo.de'), true);
    assert.equal(l.hasHostname('shop.idealo.de'), false);
    assert.equal(l.hasHostname(5 as never), false);
  });
});

// ---------------------------------------------------------------------------------------------
// Hostile input: nothing throws and everything is fast, on a 50,000 character string
// ---------------------------------------------------------------------------------------------

describe('pathological input', () => {
  const N = 50_000;
  const repeat = (unit: string): string => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  const inputs: Record<string, string> = {
    letters: repeat('a'),
    spaces: repeat(' '),
    nbsp: repeat(NBSP),
    dots: repeat('.'),
    commas: repeat('1,'),
    decimals: repeat('1.'),
    spaced: repeat('1 '),
    apostrophes: repeat("1'"),
    'scheme only': repeat('http://'),
    'unbalanced closers': `https://${repeat(')')}`,
    'glued links': repeat('https://a.de/x)'),
    www: repeat('www.'),
    labels: repeat('a.'),
    'labels two': repeat('a.b.'),
    currencies: repeat('EUR '),
    'currency and digit': repeat('EUR 1 '),
    'euro amounts': repeat(`${EURO}1,000.00 `),
    pipes: repeat('|'),
    'table rows': repeat('| a | b |\n'),
    bold: repeat('**'),
    hashes: repeat('#'),
    newlines: repeat('\n'),
    ranges: repeat('3-5 days '),
    'dash numbers': repeat('1-'),
    percents: repeat('5% '),
    markers: repeat('about '),
    emails: repeat('a@b.de '),
    'euro signs': repeat(EURO),
    emoji: repeat('\u{1F600}'),
    'zero width': repeat('\u200b'),
    nulls: repeat('\u0000'),
    quotes: repeat('"'),
    brackets: repeat('[](('),
    mixed: repeat('idealo.de EUR 2.189,00 (https://www.idealo.de/x?a=1) 3-5 Werktage 5,8 %. Free shipping. ')
  };
  for (const [name, text] of Object.entries(inputs)) {
    test(`${name}: no throw, under a second`, () => {
      const t0 = Date.now();
      scanNumbers(text);
      scanSites(text);
      maskLinks(text);
      normalizeUrlForMatch(text);
      hostOf(text);
      registrableHost(text);
      canonicalAmounts(text);
      findSnippet(text, 2069);
      findSnippet(text, 'x');
      const l = new EvidenceLedger();
      l.record({ step: 1, kind: 'page', url: 'https://x.de/', title: text, text, links: [text, text] });
      l.wasShown(text);
      l.amounts();
      l.percents();
      l.durations();
      EvidenceLedger.fromSnapshot(JSON.parse(JSON.stringify(l.toSnapshot())));
      const took = Date.now() - t0;
      assert.ok(took < 1000, `${name} took ${took} ms`);
    });
  }
  test('normalizeSpaces keeps the length', () => {
    assert.equal(normalizeSpaces(`a${NBSP}b\u202fc\u2009d`), 'a b c d');
    assert.equal(normalizeSpaces(inputs.nbsp ?? '').length, N);
  });
});
