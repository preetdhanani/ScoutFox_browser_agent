/**
 * Switches zod's code generation off. This has to be the FIRST import of every entry that bundles
 * zod: the service worker (background/background.js) and the side panel (sidepanel/sidepanel.js).
 *
 * Why: zod 4 can compile an object schema into a function with `new Function(...)`, and it probes
 * once whether that is allowed. The extension CSP (`script-src 'self'`) forbids it. The probe's
 * error is caught, but the browser still reports a `securitypolicyviolation`. With
 * `jitless: true`, zod skips the probe and never compiles, and parses the slow but safe way.
 *
 * Why first: zod reads `globalThis.__zod_globalConfig` once, when its core module runs, and keeps
 * that object. It keeps ours only if ours is there before, and an ES module import runs its module
 * before the next import's. scripts/build.mjs checks the order in the built worker
 * ("zod is jitless before any library code"). Nothing here may import anything.
 *
 * The call to `new Function` still exists in the bundle (zod's code is not removed), it just never
 * runs. scripts/evalscan.mjs allows exactly those places in node_modules/zod and no others.
 */
(globalThis as typeof globalThis & { __zod_globalConfig?: { jitless?: boolean } }).__zod_globalConfig = { jitless: true };
