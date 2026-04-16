# Step 4: Migrate showPillSeparators from threadStore to settingsStore

Status: COMPLETED

## Sub tasks

1. [x] Update ThreadEditor.vue to import settingsStore and use `settingsStore.showPillSeparators`
2. [x] Remove `showPillSeparators` ref and `togglePillSeparators` function from threadStore
3. [x] Verify no remaining references to threadStore pill separators
4. [x] Type-check passes

## NOTES

- `showPillSeparators` now lives exclusively in settingsStore and is persisted to disk.
- AppLayout already used settingsStore (done in step 3).
- ThreadEditor now imports both threadStore (for sections) and settingsStore (for pill visibility).
