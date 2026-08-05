/**
 * Tests for `isStagingResidueName` — the shared Caches staging-residue
 * predicate used by BOTH the bootstrap reaper (`cleanupOrphanedChunks`) and
 * `localWipe` (#646).
 *
 * Every accepted name below is a real writer-produced filename. If a writer
 * changes its suffix, this table is the thing that must be updated with it.
 */

import { isStagingResidueName } from '../media/stagingResidue';

describe('isStagingResidueName', () => {
  describe('matches writer-produced staging residue', () => {
    it.each([
      ['upload chunk', 'abc-chunk-0.bin'],
      ['upload ciphertext staging', 'abc-cipher.bin'],
      ['download ciphertext staging (#578/#669)', 'abc-dl-cipher.bin'],
      ['generic staging', 'abc-staging.bin'],
      ['thumbnail staging', 'abc-thumb-staging.bin'],
      ['raw thumbnail staging', 'abc-thumbraw-staging.bin'],
      ['video transcode staging (AVAssetWriter needs .mp4)', 'abc-transcode-staging.mp4'],
      ['id containing a dot', 'x.pre-staging.bin'],
      ['id that itself looks like residue', 'abc-staging.bin-alias-staging.mp4'],
    ])('%s: %s', (_label, name) => {
      expect(isStagingResidueName(name)).toBe(true);
    });
  });

  describe('rejects everything else', () => {
    it.each([
      ['avatar staging temp — deliberately excluded (separate lifecycle)', 'avatar-sanitized-123.jpg'],
      ['avatar upload temp — deliberately excluded (separate lifecycle)', 'avatar-upload-123.enc'],
      ['Android picker temp — deliberately excluded (third-party naming)', 'rn_image_picker_lib_temp_x.jpg'],
      ['unrelated cached image', 'photo.jpg'],
      ['bare .bin with no chunk/cipher/staging marker', 'chunk.bin'],
    ])('%s: %s', (_label, name) => {
      expect(isStagingResidueName(name)).toBe(false);
    });
  });
});
