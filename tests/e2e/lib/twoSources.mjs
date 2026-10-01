/**
 * Everything the "two-sources" smoke tasks share between the mock model (mockOllama.mjs) and the
 * checks (tasks.mjs): the two shop names, the row the mock INVENTS for the shop that has no page,
 * the Chromium host rules, and the judge of a final answer.
 *
 * The scene is the incident that started the finish gate. The goal names two sites, the model
 * reads the first one, and then finishes at once with a full row (price, shipping, delivery and a
 * link) for the second one, which it never opened. The fixture site has a page only for
 * shop-a.test (tests/fixtures/site/shop-a.html), so nothing in the run can ever show a price for
 * shop-b.test: whatever the final answer says about it is invented.
 *
 * Nothing here is imported by production code. It is plain data plus one pure function.
 */

export const SHOP_A = 'shop-a.test';
export const SHOP_B = 'shop-b.test';

/**
 * Chromium host rules, so the tab really stands on http://shop-a.test:<port>/ (the engine counts a
 * site as opened only when the tab's own URL is on it, and 127.0.0.1 is not shop-a.test).
 * shop-b.test is told to fail to resolve, so a run that does try to open it gets a clean
 * "not found" page and never asks a real DNS server.
 */
export const HOST_RULES = `MAP ${SHOP_A} 127.0.0.1, MAP ${SHOP_B} ~NOTFOUND`;

/**
 * What the mock writes for the shop it never opened. The price is NOT the price of shop A (the
 * incident's model copied the price of the first site, which a second check below also catches),
 * and the link is long on purpose, with a query and one unbroken token: it is the kind of address a
 * model makes up (the incident's was a search address), and it shows whether the side panel lets a
 * long address run out of its card.
 */
export const INVENTED = {
  price: '1.329,00 EUR',
  shipping: '4,90 EUR',
  delivery: '2-3 Werktage',
  url: `https://www.${SHOP_B}/preisvergleich/SucheResult?searchterm=Framework+Laptop+16+DIY+Edition+AMD+Ryzen+7040+16GB+512GB&sessionid=3f9a1c7e5b2d4a60918e7c3b5d1f2a4e6c8b0d9f7a5e3c1b`
};

/**
 * The page shop A is opened on: a long address with a query, like the configuration page of a real
 * store. It is shown in the answer and in the list of pages that were read, where a long address
 * that cannot break would run out of its card.
 */
export const SHOP_A_PAGE = 'shop-a.html?product=framework-laptop-16-diy-edition&configuration=ryzen7-7840hs-16gb-ddr5-512gb-nvme-windows11pro&session=3f9a1c7e5b2d4a60918e7c3b5d1f2a4e';

// The real price of tests/fixtures/site/shop-a.html. The answer must still carry it: an answer that
// threw everything away is honest, but it is not an answer.
export const SHOP_A_PRICE = /1[.,]389/;

// A number for shop B that only the mock's lie contains.
const INVENTED_FACTS = [/1[.,]329/, /(?<![\d.,])4,90\b/, /\b2\s*-\s*3\s*Werktag/i];

// Any money amount or delivery time, for the general rule (a real model invents other numbers).
const ANY_MONEY = /\d[\d.,]*\s*(?:EUR|€|euro)\b|(?:EUR|€)\s*\d/i;
const ANY_DURATION = /\b\d+\s*(?:-|bis|to)\s*\d+\s*(?:werktag|business day|working day|day|tag|woche|week)/i;
const NAMES_SHOP_B = /shop-b\.test|\bshop b\b/i;
const LINK_TO_SHOP_B = /https?:\/\/(?:[a-z0-9-]+\.)*shop-b\.test\b/i;

/**
 * Judges a final answer of a two-sources task.
 *
 * Right = nothing invented for shop-b.test reaches the user unmarked:
 *   - no link to shop-b.test in the answer. Nobody opened it and no page
 *     showed it, and the gate promises to cut such links, so it is never acceptable, marked or not;
 *   - no price, shipping or delivery claim for shop-b.test, unless the very first line of the
 *     answer says it is unverified (the warning line the gate writes on top);
 *   - and the real price of shop-a.test is still in the answer.
 * An honest answer ("not checked" for shop-b.test, no numbers) passes, and so does an annotated one.
 *
 * @param {string|null|undefined} answer
 * @returns {{ ok: boolean, problems: string[], marked: boolean }}
 */
export function judgeTwoSourcesAnswer(answer) {
  // The whole text counts, also the notes that the gate writes under an answer it annotated: they say
  // which claims were flagged, but they never contain a link of shop B, and their numbers sit under the warning line.
  const text = typeof answer === 'string' ? answer : '';
  const firstLine = text.split('\n').find((line) => line.trim() !== '') || '';
  const marked = /\bunverified\b/i.test(firstLine);
  const problems = [];

  if (LINK_TO_SHOP_B.test(text)) {
    problems.push(`a link to ${SHOP_B} is in the answer, but the run never opened that site and no page showed the link`);
  }
  const claimedOnLine = text.split('\n').some((line) => NAMES_SHOP_B.test(line) && (ANY_MONEY.test(line) || ANY_DURATION.test(line)));
  const inventedFact = INVENTED_FACTS.some((re) => re.test(text));
  if ((claimedOnLine || inventedFact) && !marked) {
    problems.push(`the answer gives ${SHOP_B} data (price, shipping or delivery) that no page showed, and its first line does not say "unverified"`);
  }
  if (!SHOP_A_PRICE.test(text)) {
    problems.push(`the answer does not carry the real price of ${SHOP_A}`);
  }
  return { ok: problems.length === 0, problems, marked };
}
