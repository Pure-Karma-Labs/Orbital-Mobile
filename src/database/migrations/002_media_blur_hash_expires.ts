export const VERSION = 2;

export const SQL = `
ALTER TABLE orbital_media ADD COLUMN blur_hash TEXT;
ALTER TABLE orbital_media ADD COLUMN expires_at INTEGER;
`;
