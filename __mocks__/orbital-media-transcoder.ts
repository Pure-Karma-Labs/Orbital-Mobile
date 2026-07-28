export const transcodeVideo = jest.fn().mockResolvedValue(undefined);
export const cancelTranscode = jest.fn();
export const getVideoMetadata = jest.fn().mockResolvedValue({
  width: 1280,
  height: 720,
  duration: 10.5,
});
export const extractThumbnail = jest.fn().mockResolvedValue(undefined);
export const reencodeImage = jest.fn().mockResolvedValue(undefined);
export const subscribeTranscodeProgress = jest.fn(() => ({ remove: jest.fn() }));

export class MediaTranscoderError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'MediaTranscoderError';
    this.code = code;
  }
}

export const isCancellation = jest.fn(
  (e: unknown) =>
    typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ECANCELLED',
);
