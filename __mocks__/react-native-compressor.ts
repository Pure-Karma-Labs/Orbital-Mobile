export const Video = {
  compress: jest.fn().mockResolvedValue('/tmp/compressed.mp4'),
  cancelCompression: jest.fn().mockResolvedValue(undefined),
};

export const Image = {
  compress: jest.fn().mockImplementation((path: string) =>
    Promise.resolve(path.replace(/\.[^.]+$/, '-compressed.jpg')),
  ),
};

// Top-level utility exports (not on Video/Image objects)
export const getVideoMetaData = jest.fn().mockResolvedValue({
  width: 1280,
  height: 720,
  duration: 10.5,
  size: 5000000,
});

export const createVideoThumbnail = jest.fn().mockResolvedValue('/tmp/thumbnail.jpg');

export const clearCache = jest.fn().mockResolvedValue('cleared');
