import { LRUSet } from '../lruSet';

describe('LRUSet', () => {
  it('reports has() correctly after add()', () => {
    const set = new LRUSet(10);
    expect(set.has('a')).toBe(false);
    set.add('a');
    expect(set.has('a')).toBe(true);
  });

  it('tracks size correctly', () => {
    const set = new LRUSet(10);
    expect(set.size).toBe(0);
    set.add('a');
    set.add('b');
    expect(set.size).toBe(2);
  });

  it('does not duplicate on re-add', () => {
    const set = new LRUSet(10);
    set.add('a');
    set.add('a');
    expect(set.size).toBe(1);
  });

  it('evicts oldest entry when capacity is reached', () => {
    const set = new LRUSet(3);
    set.add('a');
    set.add('b');
    set.add('c');
    // Full at capacity — adding 'd' should evict 'a' (oldest)
    set.add('d');
    expect(set.size).toBe(3);
    expect(set.has('a')).toBe(false);
    expect(set.has('b')).toBe(true);
    expect(set.has('c')).toBe(true);
    expect(set.has('d')).toBe(true);
  });

  it('has() promotes entry so it is not evicted next', () => {
    const set = new LRUSet(3);
    set.add('a');
    set.add('b');
    set.add('c');
    // Access 'a' — promotes it to most recent
    expect(set.has('a')).toBe(true);
    // Add 'd' — should evict 'b' (now oldest), not 'a'
    set.add('d');
    expect(set.has('a')).toBe(true);
    expect(set.has('b')).toBe(false);
    expect(set.has('c')).toBe(true);
    expect(set.has('d')).toBe(true);
  });

  it('clear() removes all entries', () => {
    const set = new LRUSet(10);
    set.add('a');
    set.add('b');
    set.clear();
    expect(set.size).toBe(0);
    expect(set.has('a')).toBe(false);
  });

  it('works with default capacity (500)', () => {
    const set = new LRUSet();
    for (let i = 0; i < 500; i++) {
      set.add(`key-${i}`);
    }
    expect(set.size).toBe(500);
    // Adding one more evicts the oldest
    set.add('overflow');
    expect(set.size).toBe(500);
    expect(set.has('key-0')).toBe(false);
    expect(set.has('overflow')).toBe(true);
  });
});
