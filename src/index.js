// grasp — public API barrel.
// Re-exports the small set of functions that make up grasp's programmatic
// interface. Each name is implemented in its own module per SPEC.md; this
// file adds no logic of its own and no exports beyond the contract below.

export { buildIndex } from './index-build.js';
export { query } from './query.js';
export { pack } from './pack.js';
export { rank } from './rank.js';
export { outlineRepo, outlineFile } from './outline.js';
export { loadIndex, saveIndex } from './store.js';
