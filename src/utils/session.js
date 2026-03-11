const SESSION_ID_KEY = 'fp_session_id';

// Used to avoid spamming signOut/redirect loops.
const FORCE_LOGOUT_FLAG = '__fp_forcing_logout';

export function isSessionRevokedMessage(message) {
  const m = String(message || '').toLowerCase();
  if (!m) return false;
  return (
    m.includes('session revoked') ||
    m.includes('session not found') ||
    m.includes('session expired')
  );
}

export function isAccountDeletedMessage(message) {
  const m = String(message || '').toLowerCase();
  if (!m) return false;
  return (
    m.includes('user profile not found') ||
    m.includes('account deleted') ||
    m.includes('account removed') ||
    m.includes('profile missing')
  );
}

export async function forceLogoutToLogin(reason = 'session_revoked') {
  try {
    if (typeof window !== 'undefined') {
      if (window[FORCE_LOGOUT_FLAG]) return;
      window[FORCE_LOGOUT_FLAG] = true;
    }
  } catch {
    // ignore
  }

  clearSessionId();

  try {
    const { auth } = await import('../firebase');
    const { signOut } = await import('firebase/auth');
    try {
      await signOut(auth);
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }

  try {
    const path = String(window?.location?.pathname || '').toLowerCase();
    const loginRoute = path.startsWith('/super-admin')
      ? '/super-admin/login'
      : path.startsWith('/admin')
        ? '/admin/login'
        : '/login';

    const qs = new URLSearchParams();
    if (reason) qs.set('reason', String(reason));
    const next = `${loginRoute}${qs.toString() ? `?${qs.toString()}` : ''}`;
    if (String(window?.location?.pathname || '') !== loginRoute) {
      window.location.assign(next);
    } else {
      // Already on login page; still refresh state.
      window.location.reload();
    }
  } catch {
    // ignore
  }
}

export function getSessionId() {
  try {
    return localStorage.getItem(SESSION_ID_KEY) || null;
  } catch {
    return null;
  }
}

export function setSessionId(sessionId) {
  try {
    if (!sessionId) return;
    localStorage.setItem(SESSION_ID_KEY, String(sessionId));
  } catch {
    // ignore
  }
}

export function clearSessionId() {
  try {
    localStorage.removeItem(SESSION_ID_KEY);
  } catch {
    // ignore
  }
}
