// query.js — load the persisted index for `root` and rank it against `task`.
// Per SPEC.md: query(root, task, opts) -> { results, index }. Throws a helpful
// error (telling the user to run `grasp index`) if no index has been built yet.

import { loadIndex } from './store.js';
import { rank } from './rank.js';

export async function query(root, task, opts) {
  const index = await loadIndex(root);
  if (!index) {
    throw new Error(
      'No grasp index found for this repo. Run `grasp index` first to build one.'
    );
  }
  const results = rank(index, task, opts);
  return { results, index };
}
