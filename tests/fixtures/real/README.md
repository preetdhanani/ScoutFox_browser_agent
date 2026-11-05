# The real-page corpus

This directory holds recorded REAL pages: the serialized DOM (`<name>.html.gz`), the visible
text at capture time (`<name>.txt`) and metadata (`<name>.json`), plus the shared
`manifest.json`, `expectations.json` and `baseline.json`. The pages are committed, so the
replay job never fetches the live web.

- `node tests/e2e/record-real.mjs` records every manifest page in a real Chromium
  (`--only=a,b` for single pages). It fetches the live web on purpose, scrubs personal data
  and caps every file.
- `node tests/e2e/replay-real.mjs` (or `npm run test:replay`) replays the corpus through the
  real content scripts of the built extension in headless Chromium: no live fetches, the
  recorded DOM served from a local server with its scripts stripped. It asserts the
  hand-written expectations in `expectations.json`, the no-silent-cut rule (a snapshot that
  shows less than the whole page must say so with the truncation note) and the baseline
  alarm: a drop in extracted text length or element count beyond the tolerance in
  `baseline.json` fails the job.
- `node tests/e2e/replay-real.mjs --update-baseline` stores the current counts as the
  baseline. Run it after a corpus refresh, never to silence an alarm.
- `node --test tests/realCorpus.test.js` audits the committed corpus without a browser and
  runs in the normal `npm test` suite.

## Rules

1. Every new live bug contributes its page: when a defect is found on a live site, add that
   page to `manifest.json`, record it with the recorder, write its expectations next to the
   fix, and add the regression to the replay. The corpus is the regression suite for
   extractor and perception defects that unit tests on hand-written pages cannot see.
2. Expectations name what must survive extraction, not what the page currently produces: a
   line the model must be able to read on a page larger than the snapshot cap is asserted
   with `full-text-contains` (the paged read reaches it); `page-text-contains` is only for
   lines that belong in the snapshot head.
3. A corpus refresh re-records the pages and updates the baseline in the same change, so the
   nightly replay never compares new pages against an old baseline.
4. Personal data never reaches this directory: the recorder runs with a fresh profile and no
   sign-in, the scrubber replaces emails, phone-like digit runs and opaque tokens, and the
   audit in `npm test` re-checks every committed page.
