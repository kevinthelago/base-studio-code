// Drag-and-drop folder traversal (#831). A dropped FOLDER does not appear in
// `DataTransfer.files` — it's a `FileSystemDirectoryEntry` reachable only via
// `DataTransferItem.webkitGetAsEntry()`. This walks each dropped entry recursively and
// collects every file with its relative path (so the folder structure is preserved under
// `design/`). The DOM entry API is callback-based; this promisifies + flattens it. Kept
// behind a minimal interface so it's unit-testable with fakes (no real DataTransfer needed).

/** The slice of `FileSystemEntry` (+ its file/directory subtypes) we use. Lets tests
 *  supply plain fakes instead of a real DOM entry tree. */
export interface FsEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?(onSuccess: (f: File) => void, onError?: (e: unknown) => void): void;
  createReader?(): {
    readEntries(onSuccess: (entries: FsEntryLike[]) => void, onError?: (e: unknown) => void): void;
  };
}

/** A collected file plus its path relative to the drop root (e.g. `icons/home.svg`). */
export interface DroppedFile {
  file: File;
  path: string;
}

/** Recursively collect files from one dropped entry, preserving its relative path under
 *  `prefix`. A file yields one entry; a directory is read in batches (`readEntries` returns
 *  `[]` when exhausted) and recursed into. Unknown entries yield nothing. */
export async function collectEntry(entry: FsEntryLike, prefix = ""): Promise<DroppedFile[]> {
  if (entry.isFile && entry.file) {
    const fileFn = entry.file.bind(entry);
    const file = await new Promise<File>((resolve, reject) => fileFn(resolve, reject));
    return [{ file, path: prefix + entry.name }];
  }
  if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    const out: DroppedFile[] = [];
    const childPrefix = `${prefix}${entry.name}/`;
    // readEntries yields the directory in batches; call until it returns an empty batch.
    for (;;) {
      const batch = await new Promise<FsEntryLike[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      for (const child of batch) out.push(...(await collectEntry(child, childPrefix)));
    }
    return out;
  }
  return [];
}

/** Collect every file from a set of dropped entries, folders walked recursively. */
export async function collectDroppedEntries(entries: FsEntryLike[]): Promise<DroppedFile[]> {
  const all = await Promise.all(entries.map((e) => collectEntry(e)));
  return all.flat();
}
