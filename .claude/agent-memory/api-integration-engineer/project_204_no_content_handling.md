---
name: 204-no-content-handling
description: Fixed client.ts to return undefined for 204 responses instead of parsing empty JSON body; eliminates per-endpoint PARSE_ERROR workarounds
metadata:
  type: project
---

## 204 No Content Handling in API Client (2026-05-23)

### The Fix

In `src/services/api/client.ts`, when `response.status === 204`, the client now returns `undefined as T` without attempting to parse JSON. Previously, every DELETE endpoint (and other 204-returning endpoints) needed a per-endpoint try/catch around JSON parsing to avoid PARSE_ERROR exceptions.

### Before (broken pattern)

```typescript
// Each endpoint had to do this:
try {
  const result = await request<void>('DELETE', `/api/thing/${id}`);
} catch (e) {
  if (e.code === 'PARSE_ERROR') { /* ignore, expected for 204 */ }
}
```

### After (fixed in client)

```typescript
// client.ts handles it globally:
if (response.status === 204) {
  return undefined as T;
}
```

**Why:** 204 responses have no body by HTTP spec. Attempting `response.json()` on them throws. The fix is centralized in the client rather than requiring every caller to handle it.

**How to apply:** When writing new endpoint functions that call DELETE or other methods that may return 204, type them as `request<void>(...)`. No special error handling needed at the call site.
