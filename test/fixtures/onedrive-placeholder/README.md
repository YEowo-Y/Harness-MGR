# onedrive-placeholder fixture

## Why this fixture cannot be fully static

OneDrive "Files On Demand" dehydrated stubs carry the Win32 file attribute
`FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` (0x400000) and are reported offline by
`GetFileAttributesW`. This attribute is a **live OS property** — it cannot be
faithfully represented as static file content. A static `.md` file in a git
repo will always have `size > 0` and the online attribute set; it will never
trigger the placeholder guard.

## What the doctor check actually tests

The `onedrive-placeholder-in-config` doctor check (Phase 2+) uses an
**active-probe strategy**:

1. Read the target directory's file attributes via `fs.stat()` and, on Windows,
   call `GetFileAttributesW` (via a tiny native binding or `fsutil`) to inspect
   the `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` bit.
2. If the bit is set on any file under `targetClaudeDir`, emit:
   `Diagnostic { code: 'onedrive-placeholder-in-config', severity: 'error' }`.

The unit test for this check **simulates** the offline attribute by:
- Mocking `fs.stat()` to return a synthetic stat with `attributes` including the
  placeholder bit, OR
- Writing a test-only helper that calls the real Win32 API against a temp file
  after programmatically setting the sparse/offline attribute with `DeviceIoControl`.

## This directory's role

This stub fixture documents the guard's design intent and the reason a
conventional static fixture is insufficient. It is intentionally empty of
real config files. The `fixtures.test.mjs` assertion for this fixture is:

```js
test('onedrive-placeholder fixture is documented (static-data limitation)', () => {
  assert.ok(existsSync(join(fixtures, 'onedrive-placeholder', 'README.md')),
    'README documents why a static fixture cannot fake the offline attribute');
});
```

## References

- Win32 `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS`: https://docs.microsoft.com/en-us/windows/win32/fileio/file-attribute-constants
- Plan v5, red-team item S2: snapshot must detect placeholders and refuse to
  capture or overwrite a dehydrated stub.
