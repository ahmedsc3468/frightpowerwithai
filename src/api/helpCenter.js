import { getJson, postJson } from './http';

export function searchHelpCenter({ q, k = 10, kind = 'all' } = {}) {
  const params = new URLSearchParams();
  if (q != null) params.set('q', String(q));
  params.set('k', String(k));
  if (kind) params.set('kind', String(kind));
  return getJson(`/help-center/search?${params.toString()}`, { requestLabel: 'GET /help-center/search' });
}

export function getHelpCenterContent(id) {
  return getJson(`/help-center/content/${encodeURIComponent(id)}`, { requestLabel: 'GET /help-center/content' });
}

export function getPopularHelpCenter(type = 'article', limit = 6) {
  const params = new URLSearchParams();
  params.set('type', type);
  params.set('limit', String(limit));
  return getJson(`/help-center/popular?${params.toString()}`, { requestLabel: 'GET /help-center/popular' });
}

export function listFaqItems() {
  return getJson('/help-center/faqs', { requestLabel: 'GET /help-center/faqs' });
}

export function recordHelpCenterInteraction(payload) {
  return postJson('/help-center/interactions', payload, { requestLabel: 'POST /help-center/interactions' });
}

export function askHelpCenterAi(message) {
  return postJson('/help-center/ai', { message }, { requestLabel: 'POST /help-center/ai', timeoutMs: 45000 });
}

export function listHelpCenterHistory({ q = '', limit = 50 } = {}) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  params.set('limit', String(limit));
  return getJson(`/help-center/history?${params.toString()}`, { requestLabel: 'GET /help-center/history' });
}

export function listMySupportTickets(limit = 50) {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  return getJson(`/help-center/tickets?${params.toString()}`, { requestLabel: 'GET /help-center/tickets' });
}
