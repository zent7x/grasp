// routes.js — HTTP route registration for the sample fixture repo.

import { login } from '../auth.js';
import { Database } from '../db.js';

export function registerRoutes(app) {
  const db = new Database();
  db.connect();

  app.post('/login', (req, res) => {
    const result = login(req.body.user);
    res.json(result);
  });

  return db;
}
