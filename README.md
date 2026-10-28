# Touchline

Touchline is a local learning hub with a 26-week curriculum about machine learning through soccer projects.
The plan assumes 10–12 study hours per week and prior software engineering experience.

## Start the application

Install Python 3.10 or later on your computer.
Open a terminal in this project folder.
Run this command:

```sh
python3 server.py
```

Open http://127.0.0.1:8765 in your browser.
Keep the terminal open while you use the application.
Press Control-C in that terminal to stop the server.

On macOS, you can also open `Start Touchline.command` to start the application.

If port 8765 is busy, use another local port:

```sh
python3 server.py --port 8766
```

Then open http://127.0.0.1:8766 in your browser.

## Learning records

The application saves notes, tasks, evidence, study hours, and experiment records automatically.
A module requires completed tasks and written evidence before you can mark it complete.
Completion is a self-assessment. The application does not assess the quality of your evidence.
The experiment journal supports planned experiments and later edits to record results.

The application stores each curriculum's progress in `data/<curriculum-id>/state.json`.
The adjacent `state.backup.json` contains the previous saved state.
The application preserves a damaged file instead of replacing it with empty progress.
If a saved file is damaged, stop the server before restoring a known backup.

Use Export progress to download a portable copy of the curriculum and its progress.
To transfer a course, import that file with Import curriculum on the new installation.
Select that curriculum, then use Restore backup with the same file.
The built-in soccer curriculum already exists on every installation, so it requires only Restore backup.

## New curricula

Download the template from the application.
Give the template to your agent with your topic, background, time budget, and preferred projects.
Ask the agent to preserve the structure and assign a unique curriculum ID.
Import the completed JSON file with Import curriculum.
Select the new course from Your curricula.

Each course has separate progress and experiments.
The server rejects duplicate curriculum IDs to protect existing progress.
To revise a course, import the revision under a new ID.
Moving progress between revisions requires manual reconciliation of module IDs and tasks.
The interface does not include a curriculum editor.

## Local operation

The server listens only on 127.0.0.1.
The prebuilt local tracker needs Python and no account.
Optional sharing across devices uses your own Supabase project.
The application does not require an AI API key.
The local tracker works without internet access after startup.
Cloud publishing and sign-in require internet access.
External learning resources require internet access.
Tutor prompts are copied into your existing agent. The application does not call an AI model.
The tracker does not download datasets or train models itself.

## Curriculum

Read `CURRICULUM.md` for the written learning plan.
The application reads the built-in lesson content from `curriculum.json`.
The curriculum includes foundational mathematics, several model families, research practice, and an engineering portfolio.
It does not replace every computer science subject or guarantee hiring readiness.

## Tests

Run the persistence and curriculum tests from this project folder:

```sh
python3 -m unittest -v test_server.py
```

## Shared progress and native companion

Open Devices to connect your private Supabase backend.
Publish a course to make its lessons and progress available to your native app.
Publishing is explicit in this version. Local edits do not sync automatically.
Read `backend/README.md` for private deployment and account setup.
Open `ios/Touchline.xcodeproj` in Xcode for the native iPhone and iPad companion.
Read `ios/README.md` for its build and installation steps.

## Rebuild the web interface

The web interface uses Projection UI 0.2.0-next.2 with its default Projection theme.
The local package archive makes this alpha dependency available to other developers.
Use Node.js 24 to rebuild the web assets.
From the project folder, run:

```sh
npm ci
npm run build
```

The generated `web.bundle.js` and `web.bundle.css` are served by Python.
The server never serves `.env.local` or backend source files.

## Development gates

Use Node.js 24 and Python 3.10 or later.
Install the pinned development packages and test browser:

```sh
npm ci
npx playwright install chromium
git config core.hooksPath .githooks
```

Run the required checks before each commit:

```sh
npm run verify
npm run test:browser
npm run test:appearance
```

The first command checks types, lint, persistence tests, and the web build.
Browser tests start their own server with temporary learning records and block external requests.
They do not use the running hub or its saved progress.
Read `tests/README.md` for individual checks and browser configuration.
