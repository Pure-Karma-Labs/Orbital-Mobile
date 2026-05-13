/**
 * Pluggable token storage for JWT access/refresh tokens.
 *
 * SECURITY NOTE: Tokens must NOT be persisted to plain disk, MMKV, or AsyncStorage.
 * Use platform Keychain (iOS) or Keystore-backed EncryptedSharedPreferences (Android).
 * See Issue #18 for the secure storage implementation task.
 *
 * Default implementation (InMemoryTokenStorage) is suitable for development and
 * testing only — tokens are lost on app restart.
 */

export interface TokenStorage {
  getAccessToken(): Promise<string | null>;
  setAccessToken(token: string): Promise<void>;
  getRefreshToken(): Promise<string | null>;
  setRefreshToken(token: string): Promise<void>;
  clearTokens(): Promise<void>;
}

/** In-memory token storage — tokens are not persisted across app restarts. */
export class InMemoryTokenStorage implements TokenStorage {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;

  async getAccessToken(): Promise<string | null> {
    return this.accessToken;
  }

  async setAccessToken(token: string): Promise<void> {
    this.accessToken = token;
  }

  async getRefreshToken(): Promise<string | null> {
    return this.refreshToken;
  }

  async setRefreshToken(token: string): Promise<void> {
    this.refreshToken = token;
  }

  async clearTokens(): Promise<void> {
    this.accessToken = null;
    this.refreshToken = null;
  }
}

/**
 * Singleton token manager.
 *
 * Call `configure()` early in app startup to swap in the platform-secure
 * storage implementation before any API calls are made.
 */
const createTokenManager = () => {
  let storage: TokenStorage = new InMemoryTokenStorage();
  let configured = false;

  // Subscriber lists — multiple consumers can register without clobbering.
  const tokenRefreshListeners = new Set<() => void>();
  const tokensClearedListeners = new Set<() => void>();

  function notifyListeners(listeners: Set<() => void>): void {
    listeners.forEach((fn) => {
      try {
        fn();
      } catch {
        // One bad listener must not block the others.
      }
    });
  }

  return {
    /**
     * Register a listener that fires after tokens are cleared (e.g. on 401).
     * Returns an unsubscribe function.
     *
     * Example:
     *   const unsub = tokenManager.onTokensCleared(() => clearAuth());
     *   // later: unsub();
     */
    onTokensCleared(listener: () => void): () => void {
      tokensClearedListeners.add(listener);
      return () => {
        tokensClearedListeners.delete(listener);
      };
    },

    /**
     * Register a listener that fires after a new access token is set (WS-02).
     * Used by the WebSocket manager to reconnect with a fresh JWT.
     * Returns an unsubscribe function.
     */
    onTokenRefresh(listener: () => void): () => void {
      tokenRefreshListeners.add(listener);
      return () => {
        tokenRefreshListeners.delete(listener);
      };
    },

    /**
     * Swap the storage backend. Should be called once at app startup,
     * before any API requests that require authentication.
     */
    configure(newStorage: TokenStorage): void {
      storage = newStorage;
      configured = true;
    },

    /** Returns true if configure() has been called with a custom storage. */
    isConfigured(): boolean {
      return configured;
    },

    async getAccessToken(): Promise<string | null> {
      return storage.getAccessToken();
    },

    async setTokens(accessToken: string, refreshToken?: string): Promise<void> {
      const previousToken = await storage.getAccessToken();
      await storage.setAccessToken(accessToken);
      if (refreshToken !== undefined) {
        await storage.setRefreshToken(refreshToken);
      }
      // Fire onTokenRefresh only when replacing an existing token (WS-02).
      // Initial login sets previousToken from null → token, which is not a "refresh".
      if (previousToken !== null && accessToken !== previousToken) {
        notifyListeners(tokenRefreshListeners);
      }
    },

    async clearTokens(): Promise<void> {
      await storage.clearTokens();
      notifyListeners(tokensClearedListeners);
    },
  };
};

export const tokenManager = createTokenManager();
