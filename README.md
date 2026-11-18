# Agent Army

**A personal team of AI agents that runs my day: job search, learning, training, hobbies, and more.**
A local dashboard where a Chief of Staff agent plans the day and delegates to seven specialist agents,
each a headless Claude Code process with its own role, rules, memory and strictly limited tools.

> **All rights reserved.** This repository is a portfolio showcase, published for viewing only.
> No permission is granted to use, copy, modify or redistribute any part of it. See [LICENSE](LICENSE).

## What it does

- **Chief of Staff**: the one I talk to. Knows the day (jobs, study, habits, calendar), delegates to the
  right agent, writes a morning brief with three priorities and a weekly scorecard.
- **Specialists**: Assistant (web research with sources), Job Hunter (finds, scores and drafts
  applications through an MCP connection to a self-hosted job tracker), LinkedIn Writer (bilingual posts
  from real commits), Coach (training, nutrition, grooming, social), Hobbies (chess, Rubik's cube,
  reading, art and auction research), Mentor (daily Dev/QA/AI drills and portfolio work that commits as
  me), Interview Coach (prep packs and bilingual mock interviews).
- **Runs while the PC sleeps**: Windows Task Scheduler wakes the machine, the agent runs, and the PC goes
  back to sleep only if nobody is using it (keep-awake, network wait, idle detection, run lock, timeouts).
- **One place for everything waiting on me**: an Inbox of drafts to review, commits to push, agents
  waiting for an answer, and failed runs.
- **Phone and voice**: a Telegram bridge (pairing code, push alerts, photos and files) and speech input.

## How it is built

- **Zero-dependency Node.js server** that spawns `claude -p` processes, streams their events over SSE,
  keeps one continuous thread per agent, queues work with a parallelism limit, and has a watchdog.
- **Single-file dashboard**: original SVG robot avatars with idle, working, done and error animations,
  tool activity folded into step cards, attachments, a Manage screen to create, edit, schedule, turn off
  or delete agents, and a shared "About me" memory every agent reads.
- **Safety enforced in configuration, not just in prompts**: each agent gets an explicit tool allow list
  and block list, only its own MCP servers, narrow helper scripts instead of an open shell, no sending,
  posting, buying or pushing, read-only browser snapshots (GET only), secrets kept out of prompts and
  never served by the dashboard, and a backup before every configuration change.
- **Tested end to end** while building it: every agent was smoke-tested through the API and the UI, and
  the scheduler was verified with real wake-from-sleep runs, failure paths and edge cases such as the
  32-bit tick counter wrapping after 25 days of uptime.

## Layout

```
server.js            HTTP API, agent runner, SSE, scheduling glue
lib/                 life (Today, Dossier), manage (team editing), extras (inbox, settings, uploads), telegram
public/index.html    the dashboard
tools/               the only scripts agents may run (memory, habits, fitness, study log, calendar, snapshots...)
scheduler/           Windows Task Scheduler integration (run, install, pause, sleep test)
bots.example.json    anonymized example of the agent team
```

Personal data (memory, chats, logs, the real agent definitions and settings) is never committed.

---

Copyright (c) 2026 Eduard Militaru. All rights reserved.
