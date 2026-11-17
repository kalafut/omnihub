# omnihub

An OmniFocus plug-in that pulls GitHub issues into OmniFocus so you can order,
defer, plan and flag them alongside everything else — on the Mac or phone.

It is a **one-way pull**. GitHub stays the record for the work; OmniFocus is
where you decide what to do next.

## What it does

Running **Sync GitHub Issues** (Automation menu, or the toolbar/share sheet on
iOS):

- Fetches every open issue labeled **`omnifocus`** across all repos your token
  can see.
- Puts each one in a project for its repo (created on demand, named after the
  repo). The task's note starts with the issue URL, and it gets a **`GitHub`**
  tag.
- When a synced issue is closed on GitHub, completes the task — or drops it if
  the issue was closed as *not planned*.
- Updates task titles when an issue is retitled.

### Who owns what

| GitHub owns (sync writes)      | OmniFocus owns (sync never touches)                      |
|--------------------------------|----------------------------------------------------------|
| Task title                     | Order, project placement, defer/due/planned dates, flags |
| Open/closed → complete/drop    | Other tags, the note below the first line, project names |
| First line of the note (URL)   | Projects' folder and settings                            |

- Tasks you complete or drop in OmniFocus are never revived.
- Removing the label from an issue doesn't remove the task; the summary just
  reports it.
- Projects are matched by the repo URL on the first line of their note, so you
  can rename them and move them into a folder. New repo projects are created
  in the same folder as the existing ones.
- Only tasks tagged `GitHub` are modified. Any other task whose note *starts*
  with an issue URL still prevents a duplicate. To hand such a task over to
  the sync, give it the `GitHub` tag.
- Nothing in OmniFocus changes if a GitHub request fails mid-sync. Everything
  is fetched first.

## Setup

1. **Install:** `./install.sh` (copies the plug-in to OmniFocus's iCloud
   Plug-Ins folder, so it syncs to iOS too). Re-run it after edits.
2. **Token:** create a GitHub personal access token. On the first run the
   plug-in asks for it and keeps it in the keychain.
   - A *fine-grained* token with **Issues: Read-only** is the safest choice,
     but each one covers a single owner (`kalafut` *or* an org).
   - To cover repos under several owners (e.g. `kalafut/*` and `openrevs/*`)
     with one token, use a *classic* token with the `repo` scope
     (`public_repo` if all of them are public).
   - If GitHub rejects the token, it is cleared and you're asked for a new one
     on the next run.
3. **Label:** add the `omnifocus` label to the issues you want in OmniFocus.
   To create the label in every repo under one or more owners (your account
   and/or orgs), list them in the loop:

   ```sh
   for owner in kalafut openrevs; do
     gh repo list "$owner" --no-archived --limit 200 --json nameWithOwner -q '.[].nameWithOwner'
   done | xargs -I{} gh label create omnifocus --repo {} --color 8E44AD \
     --description "Pull into OmniFocus" --force
   ```

   `--force` makes it safe to re-run. Add `--source` to `gh repo list` to
   skip forks.

## Configuration

Edit `CONFIG` at the top of `omnihub.omnijs`, then re-run `./install.sh`:

- `label`: the GitHub label to pull (default `omnifocus`).
- `repos`: an allowlist of `owner/repo` (empty = all repos).
- `tag`: the OmniFocus tag that marks synced tasks (default `GitHub`).
- `newProjectFolder`: a folder name to force where new projects are created.
- `showSummary`: set to `false` to skip the summary alert, e.g. when running
  the sync from a Shortcuts automation.

## Development

```sh
npm test
```

The tests run the real plug-in file in Node against an in-memory fake of the
parts of the OmniFocus API it uses (`test/fake-omnifocus.js`).
