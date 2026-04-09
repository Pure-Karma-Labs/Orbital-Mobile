# Testing Strategy — Orbital-Mobile

## Test Layers

### Unit Tests (Current)
Test individual functions, services, stores, and components in isolation. All native modules and external dependencies are mocked. This is the primary test layer — 38 suites, 375+ tests.

### Integration Tests (Current, Informal)
Tests like `cryptoService.test.ts` and `keyGenerationService.test.ts` exercise multiple layers (service + repository + database mocking). Co-located with unit tests — not separated into their own directory.

### E2E Tests (Phase 2)
Detox for full device-level flows. Not yet configured. Target flows: login/signup, key provisioning, thread CRUD, message send/receive.

## Directory Conventions

Tests live in `__tests__/` directories co-located with their source modules:

```
src/
  services/
    crypto/
      cryptoService.ts
      __tests__/
        cryptoService.test.ts
  database/
    repositories/
      itemRepository.ts
    __tests__/
      repositories/
        itemRepository.test.ts
```

- Test files use `.test.ts` or `.test.tsx` suffix
- `__mocks__/` at project root for native module manual mocks
- No top-level `__tests__/unit/` separation — co-located is the convention

## Mock Patterns

### Native Modules
Manual mocks in `__mocks__/` (e.g., `@op-engineering/op-sqlite`) or inline `jest.mock()`:
```typescript
jest.mock('orbital-signal', () => ({
  signalEncrypt: jest.fn(),
  // ...
}));
```

### API / Fetch
Inline helpers that replace `globalThis.fetch`:
```typescript
function mockFetchOk(body: unknown, status = 200) {
  globalThis.fetch = jest.fn().mockResolvedValue({
    ok: true, status,
    json: jest.fn().mockResolvedValue(body),
  });
}
```

### Database
Mock `getDatabase()` to return `{ executeSync: jest.fn() }`. Mock individual repository functions.

### Zustand Stores
Create isolated stores with only the slice under test, stub other slices with `jest.fn()`.

### Components
Wrap in `ThemeProvider`, render with `react-test-renderer`, query via `testID` props.

## Coverage

### Targets (enforced in CI)
| Metric | Threshold |
|---|---|
| Statements | 75% |
| Branches | 60% |
| Functions | 68% |
| Lines | 75% |

### Excluded from Coverage
- Type-only files (`src/types/**`)
- Barrel re-exports (`src/**/index.ts`)
- Generated bindings (`packages/orbital-signal/src/generated/`)
- Declaration files (`*.d.ts`)

### Reports
- `text` — terminal table (default)
- `lcov` — for CI coverage tools
- `json-summary` — machine-readable

## Running Tests

```bash
# All tests
npm test

# With coverage
npm test -- --coverage

# Single file
npm test -- src/services/crypto/__tests__/cryptoService.test.ts

# Watch mode
npm test -- --watch

# CI mode
npm test -- --ci --coverage
```

## Crypto Testing Notes

- **Never test crypto by reimplementing it** — test the orchestration (correct store reads, correct Rust function called, correct mutations persisted)
- **Transaction safety** — verify `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` via `mockDb.executeSync` assertions
- **Pre-key atomicity** — verify session save + identity save + pre-key deletion happen in a single transaction
- **Polyfills** — `btoa`, `atob`, `crypto.getRandomValues` provided globally via `jest.setup.ts`
