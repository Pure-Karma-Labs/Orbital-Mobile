/**
 * `layout.ts` — which files hold posts, in what order, and what the member is
 * told about the ones that cannot be read.
 *
 * Entries come from the fixture builders so that `entryId`s stay opaque and
 * the listing shape is the one the real reader produces. Nothing here opens a
 * session: `classifyPostJson` is a pure function of a listing.
 */

import { MAX_JSON_BYTES } from '../jsonSafety';
import { MAX_POST_JSON_FILES, classifyPostJson, detectSources } from '../layout';
import {
  buildArchive,
  fbEntrySpecs,
  igFlatEntrySpecs,
  igLabelledEntrySpecs,
  type EntrySpec,
} from '../testUtils/builders';

import type { ArchiveEntry } from '../archiveAccess';

/** The listing a set of entry specs produces. */
function listing(specs: readonly EntrySpec[]): readonly ArchiveEntry[] {
  return buildArchive(specs).entries;
}

const ONE_POST = [{ timestamp: 1_600_000_000, post: 'hello' }];

describe('detectSources', () => {
  it('reports both platforms when both have post files', () => {
    const entries = listing([
      ...fbEntrySpecs({ posts: ONE_POST }),
      ...igFlatEntrySpecs({ posts: [{ creationTimestamp: 1_600_000_000, title: 'hi' }] }),
    ]);
    expect(detectSources(entries)).toEqual({ facebook: true, instagram: true });
  });

  it('reports neither for an archive with no post files', () => {
    const entries = listing([
      { path: 'your_facebook_activity/posts/media/a.jpg' },
      { path: 'media/posts/b.jpg' },
    ]);
    expect(detectSources(entries)).toEqual({ facebook: false, instagram: false });
  });

  it('still detects a source whose only post file was refused at listing time', () => {
    // Detection is what tells #926 "this archive ALSO has Instagram posts".
    // An over-cap posts.json is evidence of the platform even though no byte
    // of it can be read.
    const entries = listing([
      ...fbEntrySpecs({ posts: ONE_POST }),
      {
        path: 'your_instagram_activity/media/posts_1.json',
        kind: 'json',
        text: '[]',
        skip: 'ENTRY_OVER_CAP',
      },
    ]);
    expect(detectSources(entries).instagram).toBe(true);
  });
});

describe('classifyPostJson ordering', () => {
  it('orders by numeric suffix, so posts_2 is read before posts_10', () => {
    // The whole reason the suffix is captured as a number: lexicographic order
    // puts `posts_10.json` first and interleaves a member's history.
    const entries = listing([
      ...igFlatEntrySpecs({ index: 10, posts: [{ creationTimestamp: 1_600_000_010 }] }),
      ...igFlatEntrySpecs({ index: 2, posts: [{ creationTimestamp: 1_600_000_002 }] }),
    ]);
    const plan = classifyPostJson(entries, 'instagram');
    expect(plan.files.map((file) => file.sourceFile)).toEqual(['posts_2.json', 'posts_10.json']);
  });

  it('keeps the two sources apart', () => {
    const entries = listing([
      ...fbEntrySpecs({ posts: ONE_POST }),
      ...igFlatEntrySpecs({ posts: [{ creationTimestamp: 1_600_000_000 }] }),
    ]);
    expect(classifyPostJson(entries, 'facebook').files).toHaveLength(1);
    expect(classifyPostJson(entries, 'instagram').files).toHaveLength(1);
  });
});

describe('classifyPostJson file issues', () => {
  it('reports an over-cap post file as json_too_large and reads nothing', () => {
    const entries = listing([
      {
        path: 'your_facebook_activity/posts/your_posts__check_ins__photos_and_videos_1.json',
        kind: 'json',
        text: '[]',
        skip: 'ENTRY_OVER_CAP',
      },
    ]);
    const plan = classifyPostJson(entries, 'facebook');
    expect(plan.files).toHaveLength(0);
    expect(plan.fileIssues).toEqual([
      {
        sourceFile: 'your_posts__check_ins__photos_and_videos_1.json',
        reason: 'json_too_large',
      },
    ]);
  });

  it('checks the declared size itself, so a cap drift fails on the stricter side', () => {
    const entries = listing([
      {
        path: 'posts/your_posts_1.json',
        kind: 'json',
        text: '[]',
        declaredSize: MAX_JSON_BYTES + 1,
      },
    ]);
    const plan = classifyPostJson(entries, 'facebook');
    expect(plan.files).toHaveLength(0);
    expect(plan.fileIssues).toEqual([
      { sourceFile: 'your_posts_1.json', reason: 'json_too_large' },
    ]);
  });

  it('is silent about a benign multi-part ENTRY_DUPLICATE with a readable twin', () => {
    // Meta repeats a file in every ZIP part; Rust lists the first and marks
    // the rest. Telling a member their archive is broken because it is a
    // multi-part archive would be noise.
    const [json] = fbEntrySpecs({ posts: ONE_POST });
    const entries = listing([json, { ...json, skip: 'ENTRY_DUPLICATE' }]);
    const plan = classifyPostJson(entries, 'facebook');
    expect(plan.files).toHaveLength(1);
    expect(plan.fileIssues).toEqual([]);
  });

  it('reports a duplicate with NO readable twin as json_entry_skipped', () => {
    const [json] = fbEntrySpecs({ posts: ONE_POST });
    const entries = listing([{ ...json, skip: 'ENTRY_DUPLICATE' }]);
    const plan = classifyPostJson(entries, 'facebook');
    expect(plan.files).toHaveLength(0);
    expect(plan.fileIssues).toEqual([
      {
        sourceFile: 'your_posts__check_ins__photos_and_videos_1.json',
        reason: 'json_entry_skipped',
      },
    ]);
  });

  it('stops at MAX_POST_JSON_FILES and says so', () => {
    const specs: EntrySpec[] = [];
    for (let index = 1; index <= MAX_POST_JSON_FILES + 2; index++) {
      specs.push({
        path: `your_instagram_activity/media/posts_${index}.json`,
        kind: 'json',
        text: '[]',
      });
    }
    const plan = classifyPostJson(listing(specs), 'instagram');
    expect(plan.files).toHaveLength(MAX_POST_JSON_FILES);
    expect(plan.fileIssues).toEqual([
      { sourceFile: `posts_${MAX_POST_JSON_FILES + 1}.json`, reason: 'archive_too_large' },
    ]);
  });
});

describe('classifyPostJson and the Instagram labelled file', () => {
  it('separates posts.json from the content files', () => {
    const entries = listing([
      ...igFlatEntrySpecs({ posts: [{ creationTimestamp: 1_600_000_000 }] }),
      ...igLabelledEntrySpecs({ posts: [{ fbid: '1234' }] }),
    ]);
    const plan = classifyPostJson(entries, 'instagram');
    expect(plan.files.map((file) => file.sourceFile)).toEqual(['posts_1.json']);
    expect(plan.labelled?.sourceFile).toBe('posts.json');
  });

  it('drops an over-cap posts.json to null and reports it', () => {
    // The fbid join disappearing is a real identity change (content-derived
    // ids instead of kind 0x02), so it is never silent.
    const [labelled] = igLabelledEntrySpecs({ posts: [{ fbid: '1234' }] });
    const entries = listing([
      ...igFlatEntrySpecs({ posts: [{ creationTimestamp: 1_600_000_000 }] }),
      { ...labelled, skip: 'ENTRY_OVER_CAP' },
    ]);
    const plan = classifyPostJson(entries, 'instagram');
    expect(plan.labelled).toBeNull();
    expect(plan.fileIssues).toEqual([{ sourceFile: 'posts.json', reason: 'json_too_large' }]);
    expect(plan.files).toHaveLength(1);
  });
});
