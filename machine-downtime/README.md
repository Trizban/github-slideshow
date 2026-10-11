# Machine Downtime Tracker (sewing floor)

Tracks every machine (MC) breakdown from the moment the operator presses the button until the mechanic finishes the repair and records the reason.

```
Operator presses button ──► WAITING (waiting time runs, dashboard tile turns red)
Mechanic arrives, scans/presses ──► UNDER REPAIR (repair time runs)
Mechanic finishes, scans/presses ──► machine RUNNING, problem list appears
Mechanic selects the reason ──► CLOSED (saved for reports)
```

| Measure | From → To |
|---|---|
| Waiting time (response) | operator call → mechanic arrives |
| Repair / service time | mechanic arrives → job done |
| Total downtime | operator call → job done |

## Run it

Needs [Node.js](https://nodejs.org) 18 or newer. There is nothing to install.

```bash
cd machine-downtime
npm start            # or: PORT=8080 node server.js
```

Open `http://<server-ip>:3000` on any PC, TV, tablet or phone on the factory network.
Data is saved to `data/db.json`. Back this file up; delete it to start fresh with sample machines.

## Pages

| Page | Who | What |
|---|---|---|
| **Dashboard** | Floor TV / supervisor | Live tile per machine. Red = waiting for mechanic, blue = under repair. Timers turn amber or red at the limits you set, and waiting tiles flash. Optional sound for new calls. Shows today's KPIs. |
| **Operator** `#operator?m=MC-01` | Tablet at the machine or line | Big **MACHINE PROBLEM** button. Shows the waiting timer and a cancel option for mistaken presses. |
| **Mechanic** `#mechanic` | Mechanic's phone | All open calls, oldest first: **Start repair** → **Job done** → choose the reason from the problem list (plus an optional note). Scanning a machine's QR code opens `#mechanic?m=MC-01` for just that machine. |
| **Reports** | Maintenance manager | Choose a date range. Shows breakdowns, total downtime, average waiting, MTTR and longest wait, broken down by reason, machine, mechanic and line. Includes a full call log and **CSV download** (opens in Excel). |
| **Settings** | Admin | Edit machines (`ID, type, line`), the problem reason list, mechanics and alert limits. Print a QR label for each machine. |

## Physical button (optional)

Each machine can have a cheap Wi-Fi button that calls a single endpoint:

```
POST /api/machines/<MACHINE_ID>/press      (GET also works)
```

Successive presses move the machine to the next step: **call → mechanic arrived → job done**. After the last press, the reason is selected on the Mechanic page. See `hardware/esp32_call_button.ino` for a ready ESP32 sketch.

## API

| Method | Path | Body |
|---|---|---|
| GET | `/api/state` | current machines, reasons, mechanics, settings, open calls |
| GET | `/api/events` | Server-Sent Events stream, sends `change` on every update |
| GET | `/api/tickets?from=ISO&to=ISO` | call history |
| GET | `/api/report.csv?from=ISO&to=ISO` | CSV export |
| POST | `/api/machines/:id/call` | `{ operator? }` |
| POST/GET | `/api/machines/:id/press` | button / QR step, `?mechanic=` optional |
| POST | `/api/tickets/:id/arrive` | `{ mechanic }` |
| POST | `/api/tickets/:id/finish` | – |
| POST | `/api/tickets/:id/reason` | `{ reasonId, note?, mechanic? }` |
| POST | `/api/tickets/:id/cancel` | – (only while waiting) |
| PUT | `/api/config` | `{ machines?, reasons?, mechanics?, settings? }` |

## Notes

- There is no login. Run it only on the internal factory network, or put it behind a reverse proxy with authentication.
- QR codes are drawn with a small library loaded from cdnjs. Without internet access, the link text is shown instead, and you can make QR codes with any generator.
- `npm test` runs the workflow tests.
