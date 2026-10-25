// src/shared/build.ts
// Which build is this? vite.config.mjs injects __SCOUTFOX_BUILD__ ("<ISO time> <git short hash>[-dirty]") into the
// bundles it builds. Sources imported directly by Node (the unit tests) have no such constant, so it is read behind a
// typeof guard: a bare reference would throw a ReferenceError there.
//
// Why it exists: the loaded extension is whatever was last built AND reloaded, not what is in the editor. A log line with
// the build time tells a pasted log apart from "the code I just changed" in one glance. With nothing committed the
// `-dirty` hash is the same for every build, so the time is what tells builds apart.

declare const __SCOUTFOX_BUILD__: string | undefined;

export const IS_BUILD: boolean = typeof __SCOUTFOX_BUILD__ !== 'undefined';

export const BUILD_STAMP: string = IS_BUILD ? (__SCOUTFOX_BUILD__ as string) : 'not a build (run from source)';
