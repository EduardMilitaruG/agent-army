# Agent Army scheduler

Bots run on a schedule while the PC **sleeps**. Windows wakes it, the bot runs, and the PC goes back
to sleep by itself. No server, no extra cost. A full shutdown or unplugging stops all of it.

## What runs when

| Task (`\AgentArmy\`) | When | Bot | What it does | Output |
|---|---|---|---|---|
| `jobhunter-morning` | Mon–Fri 08:00 | Job Hunter | Lists open drafts, finds and scores new jobs, drafts the top 5 in Dossier, drafts follow-ups due | Dossier drafts, `data/jobs/followups/` |
| `mentor-drill` | Mon–Fri 08:20 | Mentor | Writes today's 15-minute Dev/QA/AI drill | `data/mentor/drills/YYYY-MM-DD.md` |
| `chief-brief` | Mon–Fri 08:50 | Chief of Staff | Morning brief with 3 priorities; Mondays start with last week's scorecard | `data/briefs/YYYY-MM-DD.md` |

Every other bot runs only when you message it. Change times in the dashboard: **Manage bots** → the bot → Schedule.

Every run also writes `data/runs/YYYY-MM-DD_HHMM_<bot>.md`, appends a line to `data/runs/runs.log`
(time, bot, ok/failed, duration, file) and shows a Windows notification. The step-by-step log is
`data/runs/run-bot.log`. Each run is also a normal chat in the dashboard, under its bot, so you can
reply to it ("I sent the DKB one").

Scheduled prompts start with `[scheduled]`, so the bots know nobody is there to answer. They change
no statuses and create no Gmail drafts on their own.

## Commands (PowerShell, in this folder)

```powershell
.\pause.ps1                 # pause every task (stays registered)
.\resume.ps1                # turn them back on
.\install-tasks.ps1         # (re)register after editing tasks.json
.\uninstall-tasks.ps1       # remove them all
.\run-bot.ps1 -Task mentor-drill -NoSleep               # run one task now, without sleeping after
.\run-bot.ps1 -Bot coach -Prompt "Weekly scorecard." -NoSleep
```

`run-bot.ps1` needs `powershell -ExecutionPolicy Bypass -File ...` if scripts are blocked.

**Change a time:** edit `at` (24h `HH:mm`) or `days` (`Monday`…`Sunday`, or `daily`) in `tasks.json`,
then run `.\install-tasks.ps1`. To add a task, add an entry with a bot id from `bots.json`.

**Keep the PC awake after runs** (e.g. while you test): create an empty file named `NOSLEEP` in
this folder. Delete it to restore going back to sleep.

## How one run works (`run-bot.ps1`)

1. Tells Windows to stay awake (`SetThreadExecutionState`) until the run ends.
2. Waits up to 2 min for the network (Wi-Fi comes up a few seconds after waking).
3. Starts Agent Army if needed, and Docker Desktop + Dossier if the bot needs Dossier, then waits for
   their health checks.
4. Sends the prompt and waits. A run is stopped after 20 min (the task itself after 30).
5. Writes the run file, log line and notification, and releases the keep-awake.
6. Goes back to sleep only if nobody is using the PC: no keyboard/mouse input for 10+ min, or none
   since this wake, and no other task is due in the next 15 min. It never sleeps while you're active
   and never shuts down.

Failures (no network, Dossier down, timeout) are logged and notified, and the PC still goes back to
sleep. Runs never overlap: a second one waits for the first (a lock).

## Power settings this needs

- **Sleep (S3), not shutdown.** This PC has classic S3 sleep, so wake timers are reliable.
- **Allow wake timers: Enable** on AC power (Control Panel → Power Options → Change plan settings →
  Advanced → Sleep). Check: `powercfg /q SCHEME_CURRENT SUB_SLEEP RTCWAKE`.
- **Sleep after:** 15 min on AC, so the PC doesn't stay on all night after you leave it.
- **Hibernate after: Never.** Waking from hibernate isn't guaranteed on every board.
- Tasks run **only while you're logged on** (locked is fine, signed out is not): Claude Code's login,
  the notification and Docker Desktop all live in your Windows session.

## Troubleshooting "it didn't wake"

1. Was the PC asleep, not shut down or hibernated? Shutdown (even with Fast Startup) and power loss
   can't be woken. Use Start → Power → **Sleep**.
2. Are you still signed in? Signing out stops the tasks (locking is fine).
3. Is the task enabled and does it have a next run time?
   `Get-ScheduledTask -TaskPath \AgentArmy\ | Get-ScheduledTaskInfo`
4. Wake timers allowed? `powercfg /q SCHEME_CURRENT SUB_SLEEP RTCWAKE` → AC index `0x00000001`.
5. From an **admin** PowerShell: `powercfg /waketimers` should list the next Agent Army task.
6. What woke it last: `powercfg /lastwake`. Wake/sleep history:
   ```powershell
   Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Power-Troubleshooter'; Id=1} -MaxEvents 5   # wakes
   Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-Power'; Id=42} -MaxEvents 5          # sleeps
   ```
7. It woke but the run failed: read `data/runs/run-bot.log` and the run's `.md` file.
8. Some BIOSes disable RTC wake: look for "Wake on RTC" / "Resume by alarm" in the BIOS (rare).
