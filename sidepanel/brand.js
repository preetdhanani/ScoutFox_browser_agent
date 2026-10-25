/**
 * sidepanel/brand.js
 * The ScoutFox mark: a fox head, drawn in one line.
 *
 * The same shape appears in two places: in the header, next to the name, and in the middle of the
 * panel, above "What would you like to automate?". Those two are built in two different files (the
 * static HTML and the renderer in sidepanel.js), so the shape lives here and both read it from
 * here. tests/sidepanel/brand.test.js proves the static HTML carries this exact shape, so the
 * two copies cannot drift apart.
 */

/**
 * The fox head, as a line drawing with two eyes.
 *
 * The size comes from CSS (.logo-icon svg and .empty-glyph svg), so one shape serves both places
 * and the mark stays the same mark wherever it appears.
 */
export const FOX_MARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.2 3 8.6 8.4 5.6 11.2Q6.6 17 12 21.6Q17.4 17 18.4 11.2L15.4 8.4 20.8 3 15.2 6.2Q12 5.2 8.8 6.2Z"/><circle cx="9.5" cy="12.8" r="1" fill="currentColor" stroke="none"/><circle cx="14.5" cy="12.8" r="1" fill="currentColor" stroke="none"/></svg>';
