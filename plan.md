## Plan: Production-Level Performance Optimization for FreightPower

**Context**: Website suffers from slow loading due to excessive backend requests, unnecessary auto-reloads, and lack of optimization. Currently in testing phase on localhost, expecting 1000-10000 users with 50-200 concurrent. Priority features: Admin Dashboard, Marketplace, Load Management, Messaging.

**TL;DR**: Fix critical auto-reload & circular dependency bugs → implement request caching & code splitting → optimize backend queries with pagination → add build optimizations → add monitoring.

---

## Phase 1: Critical Bug Fixes (Frontend) 🔴

**Stop the bleeding - fix issues causing unnecessary reloads/re-renders**

1. **Remove window.location.reload() in Verification**
   - [src/components/verification/Verification.jsx](src/components/verification/Verification.jsx#L155) - Replace button reload with state-based resend OTP call
   - Add proper error handling and loading state

2. **Fix circular dependencies in DocumentVault**
   - [src/components/carrier/DocumentVault.jsx](src/components/carrier/DocumentVault.jsx#L280-340)
   - Move `currentUser` out of `fetchComplianceScore` and `fetchDocuments` callback dependencies
   - Pass `currentUser` as parameter instead of capturing from closure
   - Extract interval logic optimization to avoid refreshAll dependency

3. **Optimize AdminDashboard useEffect chains** 
   - [src/components/admin/AdminDashboard.jsx](src/components/admin/AdminDashboard.jsx#L109-247)
   - Consolidate overlapping effects
   - Move 30s notification polling to React Query with stale-time
   - Add debounce optimization for search queries (already at 300ms, verify it works properly)

4. **Replace force-logout full page reload**
   - [src/utils/session.js](src/utils/session.js#L63-66) - Replace `window.location.assign()` and `window.location.reload()` with React Router navigation
   - Update [src/api/http.js](src/api/http.js#L66,151) to use navigate callback pattern instead of direct window manipulation

---

## Phase 2: Frontend Data Fetching & Caching 🚀

**Zero-infrastructure solution using TanStack Query (React Query)**

5. **Install and configure TanStack Query v5**
   - Add `@tanstack/react-query` and `@tanstack/react-query-devtools`
   - Wrap app with `QueryClientProvider` in [src/main.jsx](src/main.jsx)
   - Configure defaults: `staleTime: 5 * 60 * 1000` (5min), `gcTime: 10 * 60 * 1000` (10min), `retry: 1`

6. **Create query hooks for admin features** (*depends on 5*)
   - Create `src/hooks/queries/useAdminDashboard.js` - wrap dashboard metrics API
   - Create `src/hooks/queries/useUsers.js` - wrap user list with pagination support
   - Create `src/hooks/queries/useNotifications.js` - replace 30s polling with `refetchInterval`
   - Implement in [src/components/admin/AdminDashboard.jsx](src/components/admin/AdminDashboard.jsx)

7. **Create query hooks for marketplace** (*depends on 5*)
   - Create `src/hooks/queries/useMarketplaceServices.js` - driver/shipper listings
   - Keep Firestore real-time listener for favorites (already well-implemented)
   - Implement in [src/components/driver/Marketplace.jsx](src/components/driver/Marketplace.jsx) and shipper equivalent

8. **Create query hooks for load management** (*depends on 5*)
   - Create `src/hooks/queries/useLoads.js` - with filters, pagination
   - Create `src/hooks/queries/useLoadDetails.js` - single load with subcollections
   - Implement prefetching on hover for load details
   - Target [src/components/driver/](src/components/driver/) and [src/components/carrier/](src/components/carrier/) load components

9. **Create query hooks for messaging** (*depends on 5*)
   - Create `src/hooks/queries/useMessages.js` - with infinite scroll support
   - Implement optimistic updates for sent messages
   - Target [src/components/driver/Messaging.jsx](src/components/driver/Messaging.jsx) and related

10. **Implement request deduplication**
    - Update [src/api/http.js](src/api/http.js) to add request deduplication map with AbortController
    - Add request cancellation on navigation/component unmount

---

## Phase 3: Code Splitting & Bundle Optimization 📦

**Reduce initial bundle size by 60-70%**

11. **Implement route-based code splitting**
    - Update [src/App.jsx](src/App.jsx) - convert all dashboard imports to React.lazy()
    - Wrap routes with `<Suspense fallback={<LoadingSpinner />}>`
    - Structure: `const CarrierDashboard = lazy(() => import('./components/carrier/CarrierDashboard'))`

12. **Configure Vite chunking strategy**
    - Update [vite.config.js](vite.config.js) with manual chunks:
      - `vendor`: react, react-dom, react-router-dom
      - `firebase`: firebase SDK
      - `maps`: HERE Maps related code
      - `pdf-utils`: jspdf, jszip (already partially lazy)
    - Configure `rollupOptions.output.manualChunks`

13. **Preload critical routes**
    - Add route preloading on hover for dashboard navigation links
    - Implement in navigation components across all dashboards

---

## Phase 4: Backend Query Optimization 🗄️

**Add pagination, limits, and defensive patterns**

14. **Add pagination to list endpoints** (*parallel with 15-17*)
    - Update [apps/api/main.py](apps/api/main.py) `GET /admin/management/users` - add `offset`/`limit` query params (default limit=50, max=200)
    - Update [apps/api/main.py](apps/api/main.py#L1479) `GET /loads endpoints` - add pagination
    - Update [apps/api/finance/repo.py](apps/api/finance/repo.py#L85) - consolidate triple query into single batched + pagination

15. **Add collection scan limits** (*parallel with 14, 16-17*)
    - [apps/api/main.py](apps/api/main.py#L399) - Add `.limit(500)` to user role queries
    - [apps/api/main.py](apps/api/main.py#L647) - Paginate full user scans
    - [apps/api/load_record.py](apps/api/load_record.py#L168) - Add configurable limit to subcollections (default 100)

16. **Optimize heavy admin endpoints** (*parallel with 14-15, 17*)
    - [apps/api/main.py](apps/api/main.py#L1225) `GET /tracking/loads/locations` - Add time-based filtering (last_updated > X), reduce from 900 to 200 active loads
    - Add sparse field projection (only fetch needed fields)

17. **Batch user fetches** (*parallel with 14-16*)
    - Audit all locations using individual `.get()` in loops
    - Replace with `db.get_all(refs)` batch pattern
    - Primary targets: [apps/api/finance/repo.py](apps/api/finance/repo.py), load detail endpoints

18. **Add response field filtering** (*depends on 14-17*)
    - Add `?fields=id,name,status` query parameter support to major endpoints
    - Implement projection logic to reduce payload size

---

## Phase 5: Context & State Optimization ⚡

**Prevent unnecessary re-renders**

19. **Memoize AuthContext value**
    - Update [src/contexts/AuthContext.jsx](src/contexts/AuthContext.jsx) - wrap context value in `useMemo`
    - Dependencies: `[currentUser, loading, sessionId, isSessionValid]`

20. **Memoize UserSettingsContext value**
    - Update [src/contexts/UserSettingsContext.jsx](src/contexts/UserSettingsContext.jsx) - already has useMemo at line 201, verify dependencies are minimal
    - Audit all callbacks to ensure stable references with `useCallback`

21. **Add React.memo to expensive components**
    - Wrap high-frequency render components: RouteMap, user cards, load lists
    - Add custom comparison functions where needed
    - Target: [src/components/common/RouteMap.jsx](src/components/common/RouteMap.jsx), admin table components

---

## Phase 6: Build & Asset Optimization 🏗️

**Production bundle optimizations**

22. **Configure Vite production optimizations** (*parallel with 23-24*)
    - Update [vite.config.js](vite.config.js):
      - `build.rollupOptions.output.manualChunks` (already covered in #12)
      - `build.cssCodeSplit: true`
      - `build.minify: 'esbuild'` (default, verify)
      - `build.sourcemap: false` for production

23. **Add asset preloading** (*parallel with 22, 24*)
    - Add `<link rel="preload">` for critical fonts/images in [index.html](index.html)
    - Configure Vite to inject preload hints for critical chunks

24. **Optimize images and assets** (*parallel with 22-23*)
    - Audit [public/](public/) for large images
    - Add vite-imagetools plugin for automatic image optimization
    - Convert large images to WebP with fallbacks

---

## Phase 7: Production Readiness (Future) 🚀

**For when deploying to production - NOT needed for localhost testing**

25. **Firestore index creation**
    - Generate indexes for:
      - `users.role + is_active`
      - `loads.assigned_carrier + status`
      - `loads.status + created_at`
    - Deploy via `firebase deploy --only firestore:indexes`

26. **Add Redis caching layer** (when multi-instance deployed)
    - Install `redis` and `aioredis` packages
    - Create `apps/api/cache.py` - Redis connection pool
    - Cache user profiles (1hr TTL), permissions (30min TTL)
    - Wrap Firestore queries with cache-aside pattern

27. **Set up CDN for static assets**
    - Configure Vercel/Cloudflare CDN for frontend build
    - Add cache headers for JS/CSS bundles (1 year)
    - Add short cache for HTML (5min)

28. **Add performance monitoring**
    - Frontend: Integrate Vercel Analytics or Sentry Performance
    - Backend: Add custom FastAPI middleware for request timing
    - Log slow queries (>500ms) to monitoring service

---

## Relevant Files

### Frontend Core
- [src/App.jsx](src/App.jsx) - Route splitting (Phase 3)
- [src/main.jsx](src/main.jsx) - React Query setup (Phase 2)
- [src/api/http.js](src/api/http.js) - Request deduplication (Phase 2)
- [vite.config.js](vite.config.js) - Bundle optimization (Phase 3, 6)

### Problem Components
- [src/components/verification/Verification.jsx](src/components/verification/Verification.jsx) - Remove reload (Phase 1)
- [src/components/carrier/DocumentVault.jsx](src/components/carrier/DocumentVault.jsx) - Fix circular deps (Phase 1)
- [src/components/admin/AdminDashboard.jsx](src/components/admin/AdminDashboard.jsx) - Optimize effects (Phase 1) + React Query (Phase 2)
- [src/utils/session.js](src/utils/session.js) - Replace window reload (Phase 1)

### Backend Core
- [apps/api/main.py](apps/api/main.py) - Pagination, limits (Phase 4)
- [apps/api/auth.py](apps/api/auth.py) - Caching enhancement (Phase 7 - optional)
- [apps/api/finance/repo.py](apps/api/finance/repo.py) - Query consolidation (Phase 4)
- [apps/api/load_record.py](apps/api/load_record.py) - Subcollection limits (Phase 4)

### New Files to Create
- `src/hooks/queries/useAdminDashboard.js` - React Query hook
- `src/hooks/queries/useUsers.js` - React Query hook
- `src/hooks/queries/useMarketplaceServices.js` - React Query hook
- `src/hooks/queries/useLoads.js` - React Query hook
- `src/hooks/queries/useMessages.js` - React Query hook
- `apps/api/cache.py` - Redis wrapper (Phase 7 - when deployed)

---

## Verification Steps

### After Phase 1 (Critical Fixes)
1. Test OTP verification - click "Resend Code" - should NOT reload page
2. Test DocumentVault - open page, check DevTools console - should NOT see rapid re-renders
3. Test admin dashboard - monitor Network tab - should NOT see duplicate requests in quick succession
4. Test session expiry - trigger 401 error - should navigate without full page reload

### After Phase 2 (React Query)
1. Open React Query DevTools - verify queries are cached
2. Navigate between pages - return to previous page - should load instantly from cache
3. Check Network tab - duplicate requests within 5min window should NOT hit network
4. Test infinite scroll in messaging - should smoothly load more without stutter

### After Phase 3 (Code Splitting)
1. Build production bundle: `npm run build`
2. Check `dist/assets/` - verify multiple JS chunks exist (vendor, firebase, dashboards)
3. Measure bundle sizes: vendor chunk <200kb, dashboard chunks <100kb each
4. Test lazy loading - open DevTools Network, navigate - verify chunks load on demand

### After Phase 4 (Backend Optimization)
1. Test admin user list - verify only 50 users load initially with "Load More" button
2. Test load tracking - check response times in Network tab - should be <500ms
3. Monitor backend logs - verify no queries scanning >500 documents
4. Test finance invoice list - verify pagination works, only 50 items per page

### After Phase 5 (Context Optimization)
1. Install React DevTools Profiler
2. Navigate dashboard sections - check flame graph - minimal re-renders in unrelated components
3. Type in search field - verify only search component re-renders, not entire dashboard

### After Phase 6 (Build Optimization)
1. Run Lighthouse audit - target scores: Performance >85, FCP <1.5s
2. Check bundle sizes - total initial JS <500kb, initial CSS <100kb
3. Test on slow 3G throttling - page should be interactive within 5s

### After Production Deploy (Phase 7)
1. Set up Firestore indexes - verify no "missing index" errors in backend logs
2. Monitor cache hit rate - Redis should >70% hit rate for user profile queries
3. Test CDN - verify static assets served with `cf-cache-status: HIT` header
4. Check Sentry/monitoring - identify and fix any P95 >1s queries

---

## Expected Performance Gains

| Metric | Before | After Phase 3 | After Phase 6 | After Production |
|--------|---------|---------------|---------------|------------------|
| Initial bundle size | ~1.5MB | ~500KB | ~400KB | ~400KB |
| Time to Interactive | 4-6s | 2-3s | 1.5-2s | <1.5s |
| Dashboard navigation | 2-3s | <500ms (cached) | <300ms | <200ms |
| API response time | 800ms-2s | 800ms-2s | 500ms-1s | 200-500ms |
| Re-renders on state change | 10-20 | 3-5 | 2-3 | 2-3 |
| Lighthouse Performance | 40-60 | 70-80 | 85-95 | 90-100 |

---

## Decisions & Scope

### Included
- React Query for zero-infrastructure caching (no Redis needed for testing)
- Route-based code splitting for all major features
- Backend pagination for all list endpoints
- Fix all critical auto-reload bugs
- Production-ready patterns that scale to 10k users

### Excluded (Future Enhancements)
- Database migration from Firestore to PostgreSQL (keep Firestore)
- Service worker / offline mode (PWA)
- GraphQL layer (REST API is sufficient)
- Real-time WebSocket connections (Firestore real-time is good)
- Image CDN optimization (can add post-launch)

### Assumptions
- Localhost testing phase - can defer Redis/CDN until production deployment
- Users are willing to add TanStack Query dependency (industry standard, 47KB gzipped)
- Backend can be modified (FastAPI endpoints)
- Firestore is staying (not migrating databases)

---

## Implementation Order Summary

**Week 1** (Immediate Impact):
- Phase 1: Critical bug fixes - stop auto-reloads → 50% fewer page reloads
- Phase 2: Steps 5-7 - React Query setup + admin/marketplace hooks → 70% faster navigation

**Week 2** (Performance Boost):
- Phase 2: Steps 8-10 - Remaining query hooks + deduplication → 80% fewer duplicate requests
- Phase 3: Code splitting → 65% smaller initial bundle
- Phase 4: Steps 14-15 - Pagination + limits → 60% faster API responses

**Week 3** (Polish):
- Phase 4: Steps 16-18 - Query optimization + field filtering → 40% faster heavy endpoints
- Phase 5: Context optimization → 50% fewer re-renders
- Phase 6: Build optimization → 90+ Lighthouse score

**Pre-Production** (when ready to deploy):
- Phase 7: Firestore indexes, Redis, CDN, monitoring

