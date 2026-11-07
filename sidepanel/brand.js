/**
 * sidepanel/brand.js
 * The Tarka mark: the yantra, two interlocking triangles around one lit dot.
 *
 * Tarka is Sanskrit for logic or reasoning. The mark is a yantra: an upward and a downward
 * triangle interlocked around a single filled dot at the centre, the conclusion the reasoning
 * converges on. The same shape appears in two places: in the header, next to the name, and in
 * the middle of the panel, above "What would you like to automate?". Those two are built in two
 * different files (the static HTML and the renderer in sidepanel.js), so the shape lives here
 * and both read it from here. tests/sidepanel/brand.test.js proves the static HTML carries this
 * exact shape, so the two copies cannot drift apart.
 */

/**
 * The Tarka mark: two interlocked triangles with a filled dot at their centre.
 *
 * The size comes from CSS (.logo-icon svg and .empty-glyph svg), so one shape serves both places
 * and the mark stays the same mark wherever it appears.
 */
export const BRAND_MARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 1.6 21 17.2H3Z"/><path d="M12 22.4 3 6.8h18Z"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/></svg>';
