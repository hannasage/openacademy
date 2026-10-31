# Contract fixtures

These fixtures feed the contract tests. The older cases are listed in `cases.json`. The lesson module, packet, and help record cases are listed in `lesson-conformance.json`. The file `contracts/README.md` explains both.

## Soccer curriculum packet

The files `valid/packet-soccer-ml.json` and `valid/lesson-module-soccer-m01.json` to `valid/lesson-module-soccer-m13.json` come from the shipped `curriculum.json`. That file is not changed. Each curriculum module became one lesson module. The id is the curriculum id plus the module id, for example `soccer-ml-m01`.

These fields come from `curriculum.json`:

- `title`, `outcome`, and `prerequisites` (with the new id form).
- Each task `prompt`, from the module task list.
- The text blocks, from the question, mathematics, dataset, reading, and challenge fields.
- The source link blocks, from the module resources.
- The check `description`, from the evidence field.
- `estimatedMinutes`, from the module hours multiplied by 60.

These fields are placeholders. The curriculum has no data for them:

- Every hint. The text says it is a placeholder.
- The check `kind`. Each check is `self-reported`, because the curriculum has no way to run a check.
- The module and packet `version`, which is `1.0.0`.
- The `license`, which is `LicenseRef-Unspecified`.
- The packet `id` and `title` repeat the curriculum values.

The curriculum fields `weeks`, `weekStart`, `weekEnd`, and the weekly plan text have no place in a lesson module. They are left out.

The test `tests/lesson-contracts.test.mjs` checks the derived fields against `curriculum.json`, so the fixtures cannot drift from it without a failing test.

## Damaged and unsupported files

The file `invalid/lesson-module-damaged-truncated.json` is a module cut off in the middle. It is not valid JSON on purpose. Keep it exactly as it is. The test copies it and the unsupported version files, validates the copies, and checks that their bytes and modified times did not change.
