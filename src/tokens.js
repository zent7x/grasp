// src/tokens.js
// Token estimation and greedy budget-fitting utilities.
//
// Token estimate convention (see SPEC.md "Global conventions"):
//   Math.ceil(text.length / 4) everywhere.

/**
 * Estimate the token count of a string of text.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Greedily select the prefix of `items` whose cumulative `sizeFn(item)` stays
 * within `budget`.
 *
 * Prefix semantics (SPEC.md clarification #8): iterate `items` in order and
 * stop at the FIRST item whose addition would push the cumulative size above
 * `budget`; that item and all items after it (in original order) go to
 * `dropped`. `used` is the summed size of `included` only.
 *
 * @param {Array<any>} items
 * @param {number} budget
 * @param {(item: any) => number} sizeFn
 * @returns {{ included: Array<any>, dropped: Array<any>, used: number }}
 */
export function fitToBudget(items, budget, sizeFn) {
  const included = [];
  const dropped = [];
  let used = 0;
  let stopped = false;

  for (const item of items) {
    if (stopped) {
      dropped.push(item);
      continue;
    }
    const size = sizeFn(item);
    if (used + size > budget) {
      stopped = true;
      dropped.push(item);
      continue;
    }
    included.push(item);
    used += size;
  }

  return { included, dropped, used };
}
