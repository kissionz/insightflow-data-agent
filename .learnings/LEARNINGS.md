# Learnings

## [LRN-20260727-001] best_practice

**Logged**: 2026-07-27T10:57:00+08:00
**Priority**: medium
**Status**: pending
**Area**: frontend

### Summary
A Vite proxy prefix of `/api` also intercepts the source module `/api.ts`.

### Details
The development server proxies `/api.ts` to the backend because the configured proxy key is a prefix match. This leaves the React root blank even though Vite itself connects successfully.

### Suggested Action
Scope the proxy key to `/api/` so API routes are forwarded while `src/web/api.ts` remains a frontend module.

### Metadata
- Source: error
- Related Files: vite.config.ts, src/web/api.ts
- Tags: vite, proxy, local-development

---
