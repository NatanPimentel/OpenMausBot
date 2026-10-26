/** What gives `target` back the fields it has now. The copy is shallow: a change to a run or a routine replaces a nested value, never edits it in place. */
export function fieldsRestorer<T extends object>(target: T): () => void {
  const before = { ...target };
  return () => { Object.assign(target, Object.fromEntries(Object.keys(target).map((key) => [key, undefined])), before); };
}
