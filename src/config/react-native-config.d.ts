declare module 'react-native-config' {
  export interface NativeConfig {
    SENTRY_DSN?: string;
    API_URL?: string;
  }
  const Config: NativeConfig;
  export default Config;
}
