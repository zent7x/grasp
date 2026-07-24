// db.js — a tiny fake database client for the sample fixture repo.

export class Database {
  connect() {
    this.connected = true;
    return this.connected;
  }

  query(sql) {
    if (!this.connected) {
      throw new Error('not connected');
    }
    return { sql, rows: [] };
  }
}
