// auth.js — login/logout helpers and token config for the sample fixture repo.

export function login(user) {
  if (!user) {
    throw new Error('user is required');
  }
  return { user, token: 'tok_' + user, expiresIn: TOKEN_TTL };
}

export function logout() {
  return { ok: true };
}

export const TOKEN_TTL = 3600;
