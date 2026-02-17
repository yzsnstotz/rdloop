# rdloop GUI

MVP dashboard for monitoring and controlling rdloop tasks.

## Quick Start

```bash
cd ~/work/rdloop/gui
npm install
npm start
# Open http://localhost:17333
```

## Features

- Task list with auto-refresh (2s polling)
- Task detail: state, attempts, timeline
- Attempt detail: instruction, test log, diff, verdict
- Controls: Pause, Resume, Run Next, Force Run
- Edit instruction and save

## API

- `GET /api/tasks` — list all tasks
- `GET /api/task/:taskId` — task detail + attempts + timeline
- `GET /api/task/:taskId/attempt/:n` — attempt detail
- `POST /api/task/:taskId/control` — write control.json
- `POST /api/task/:taskId/run` — trigger coordinator (409 if locked)
