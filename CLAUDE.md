# Always Precise Investigations — working notes

Static marketing site for Always Precise Investigations, LLC (Virginia PI firm).
No build step, no dependencies. Cloudflare Pages serves the repo root.

Live: https://alwayspreciseinvestigations.net

## Read this before querying GitHub Actions

**Do not call `list_workflow_runs` (or any Actions listing) without narrowing it.**

The GitHub API returns ~15 KB per run object — full `repository`,
`head_repository`, `actor`, `triggering_actor` and `head_commit` blobs — for
what is about 136 bytes of useful information. That is a 113x waste ratio.

Measured against this repo:

| Query                        | Payload    | Approx. tokens |
| ---------------------------- | ---------- | -------------- |
| 30 runs (one default page)   | 461 KB     | ~115,000       |
| all 84 runs                  | 1.29 MB    | ~323,000       |

A single unfiltered call therefore costs more than an entire context window
and will end the session. This repo accumulates runs quickly — four workflows,
one of them a daily cron — so the count only grows.

When you need deploy or health status, do one of these instead:

- Pass `minimal_output: true`, and always set `per_page` to 5–10.
- Filter to what you actually want: `workflow_runs_filter: {status, event, branch}`,
  or scope to one workflow by passing `deploy.yml` as `resource_id`.
- For "did my push deploy?", check the commit status rather than listing runs.

The same caution applies to `get_job_logs` on this repo: `site-health.yml`
emits a long step summary.

## Deploy topology

Four workflows, all in `.github/workflows/`:

| Workflow              | Trigger                              | Does                                       |
| --------------------- | ------------------------------------ | ------------------------------------------ |
| `deploy.yml`          | any push to `master`                 | rsyncs the site to Cloudflare Pages        |
| `build-locations.yml` | push to `master` touching the generator | regenerates location pages, commits, deploys |
| `deploy-worker.yml`   | push touching `visitor-alerts/worker.js` | uploads the Worker, preserving bindings |
| `site-health.yml`     | daily cron, 11:00 UTC                | probes the live domain; opens one issue on failure |

Every workflow carries a `concurrency` group. They were added after runs
collided: on 2026-08-07 five runs started in the same minute and two were
cancelled. Without the guards, a push that touches `build-locations.py` starts
one deploy of the *pre-rebuild* tree while `build-locations.yml` dispatches a
second deploy of the *rebuilt* tree — a race whose loser can publish stale
pages over fresh ones. Do not remove them.

## Generated files

`private-investigator/**` and `sitemap.xml` are **generated** by
`build-locations.py`. Edit the `PLACES` list in that script, not the HTML.
Pushing a change to the script makes CI regenerate, commit and deploy.

`build-locations.py` is the source of truth but the generated HTML is what is
committed and served, so the two can drift if you hand-edit the output. Run
`python3 build-locations.py` and check `git status` is clean before pushing.

Current output: a hub page plus 6 location pages (~98 KB total), 10 sitemap
URLs. The markets are Roanoke, Lynchburg, Charlottesville, Danville, Bedford
and Farmville — deliberately scoped to about an hour's drive. An earlier
version generated 27 near-duplicate city pages; that was consolidated on
purpose, so resist re-expanding it without a reason.

## CI pushes to master

`build-locations.yml` commits and pushes to `master` as `github-actions[bot]`.
If you pushed a generator change, your local clone is stale seconds later —
`git pull` before you push again or the push is rejected. This is the most
common source of an apparent "something else is editing the repo" conflict.

## Service pages

`infidelity-investigations/` and `child-custody-investigations/` are
hand-written pages for the two highest-intent searches. They are linked from
the services grid on the homepage with a "how we document it" call to action.

The homepage services grid also advertises **Workers' Comp & Auto Claims**
("Claims investigation and surveillance for insurers, attorneys, and
employers") — but unlike the other two, it has no page behind it and no link.
That is the outstanding gap in the service-page set.

## Contact

Both forms (homepage and `intake/`) post to Web3Forms. The access key lives in
the page source; it is a public key by design, but it is the only thing making
the forms deliver, so do not strip it.
