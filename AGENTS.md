# Touchline

Touchline is a local learning hub with a native reading companion.
The approved sequence is recorded in https://github.com/sageadvicellc/workbench/pull/554.
The approved screens are in https://www.figma.com/design/dHJwW62Wb4nxGvDIuQn7EE/Touchline?node-id=41-2221.

## Work

Keep local progress, drafts, and backups readable across upgrades.
Support multiple curricula while encouraging one focus.
Keep backend setup permission separate from account sign-in.
Use email codes by default and show configured Google or Apple methods only.
Each owner hosts their own setup connector and OAuth registration.
Native clients read explicit publications and keep selected curricula offline.

## Gates

Run `npm run verify` before every commit.
Run `npm run test:browser` for storage or web behavior changes.
Run `npm run test:appearance` for appearance changes.
Keep browser tests on temporary storage and block external requests.
Use `git config core.hooksPath .githooks` after cloning.
Never bypass hooks or push main.
Open a draft pull request, complete independent reviews, then mark it ready.

## Private files

Never commit `.env*`, `.vercel/`, `cloud-config.local.json`, `data/`, or user files from Xcode.
Never run database setup or access tests against production without the required approval.
Keep management secrets on the owner's server.
Do not remove the original recovery folder.
