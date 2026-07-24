# sample

A tiny fixture repo used by grasp's test suite.

It has a basic login and database layer: `src/auth.js` handles login/logout,
`src/db.js` provides a minimal database client, and `src/api/routes.js` wires
them together behind an HTTP route. A Python migration script under
`scripts/` rounds out the multi-language coverage.
