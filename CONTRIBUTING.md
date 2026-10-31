# Contributing

This guide is a draft. Final contribution terms are not set.
Until they are, the maintainer reviews each pull request and can decline changes that need a license agreement.

## Before you start

1. Open an issue that describes the change.
2. Wait for the maintainer to confirm it fits the project.

## Set up

```sh
git clone https://github.com/hannasage/schola.git
cd schola
git config core.hooksPath .githooks
npm ci
```

## Check your work

Run `npm run verify` before every commit.
Run `npm run test:browser` for storage or web behavior changes.
Run `npm run test:appearance` for appearance changes.
Keep browser tests on temporary storage and block external requests.

## Rules

1. Keep local progress, drafts, and backups readable across upgrades.
2. Do not commit `.env*`, `.vercel/`, `cloud-config.local.json`, `data/`, or user files from Xcode.
3. Do not bypass hooks.
4. Open a draft pull request. Mark it ready after `npm run verify` passes.
5. A pull request body states what changed, why, and how you verified it.
