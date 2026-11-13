# Folio

**A folio is a folder.** Its files are the complete, portable record of a bounded piece of work: its status, the work inside it (folios inside folios), correspondence, decisions, feedback, artifacts and the git repositories involved. This repository holds the format specification, a guide to using folios, and a JavaScript library and CLI for working with folios (its one dependency is [`@engine9/pii-classifier`](https://github.com/engine9-ai/pii-classifier), itself dependency-free).

- [`GUIDE.md`](GUIDE.md): **how to use folios**: what they are for, where things go, and what they must not hold (credentials, card and bank numbers, other people's personal data, codebases).
- [`SPEC.md`](SPEC.md): the product and format specification (living document).
- [`src/`](src): the library. Storage-agnostic: the same code runs over a local folder, memory, or Cloudflare R2.
- [`examples/`](examples): real folio folders. `support-request` is the smallest useful folio; `website-refresh` has folios inside folios, blockers, a decision, a feedback response and an artifact.
- Hosted service: [`folio-server`](https://github.com/engine9-ai/folio-server), live at `folio.engine9.ai`.

Not yet on npm. Until then, depend on the repository (`"@engine9/folio": "github:engine9-ai/folio"`); it pulls `@engine9/pii-classifier` from GitHub the same way.

## CLI

```bash
node bin/folio.js init ./my-folio --title "Broken donation form"
node bin/folio.js repo add ./my-folio engine9-ai/folio-server --purpose "Server" --role primary
node bin/folio.js new ./my-folio --title "Donate button spins" --type bug   # a folio inside the folio
node bin/folio.js relate ./my-folio/release-the-fix blocked_by fol-ab12cd
node bin/folio.js set ./my-folio/donate-button-spins --status active --owner robin@example.com
node bin/folio.js list ./my-folio         # the folios inside it, with status and readiness
node bin/folio.js history ./my-folio      # every change to folio.json
node bin/folio.js add ./my-folio report.eml https://github.com/a/b screenshot.png   # filed where each belongs
node bin/folio.js add ./my-folio "# Kickoff notes ..."    # text: saved as .md, .html or .txt by what it is (--as to choose)
node bin/folio.js import ./my-folio asana-export.json     # Asana / Trello / { folios: [...] } -> folios inside it
node bin/folio.js retype ./my-folio notes/2026-11-09-kickoff.txt markdown
node bin/folio.js ready ./my-folio        # what could someone start now?
node bin/folio.js validate ./my-folio     # broken references, loops, secrets, unattested edits
node bin/folio.js checklist ./my-folio --add "Send DNS change"   # README checkboxes; --check 1, --remove 1
node bin/folio.js task add ./my-folio --env engine9/acme --path @engine9/plugins/e9workers:EchoWorker --method echo --within 30
node bin/folio.js task set ./my-folio echo-echoworker --state COMPLETED --records 1   # bring the record up to date
node bin/folio.js task list ./my-folio    # tasks run elsewhere, with state and whether they are overdue
```

## Library

```js
import { Folio, MemoryFs } from '@engine9/folio';
import { NodeFs } from '@engine9/folio/node';

const folio = await Folio.open(new NodeFs('./examples/website-refresh'), { nested: 'detect' });
const actor = { type: 'user', id: 'sam@example.com' };

// Work is folios inside folios (sub-folios).
const bug = await folio.createChild({ title: 'Donate button spins', type: 'bug' }, { actor });
await bug.folio.edit({ status: 'active', owner: 'robin@example.com', tags: 'payments, safari' }, { actor });
await bug.folio.relate('blocked_by', 'fol-ab12cd', { actor });
const kids = await folio.children();                // [{ dir, id, title, type, status, tags, readiness }]
const { folios, ready } = await folio.overview();    // counts by readiness, and what could be started now
await folio.history();                               // every change to folio.json: who, when, from → to
const { ok, problems } = await folio.validate();

// Add anything; the folio decides where it goes (SPEC 8.6).
await folio.add({ url: 'https://github.com/engine9-ai/folio' }, { actor });             // listed in folio.json
await folio.add({ name: 'report.eml', data: emlBytes }, { actor });                      // comms/ (with comments, updates and agents' reports)
await bug.folio.add({ name: 'screenshot.png', data: pngBytes }, { actor });           // that folio's attachments/
await folio.add({ name: 'donors.csv', data: csvBytes }, { actor });                       // summary in sources/data/, original to `hold`
await bug.folio.comment('Reproduced on iOS', { actor });                           // comms/…comment.json
await folio.post('update', 'On track for Friday', { actor });                       // comms/…update.json
await folio.clientComms();                                                         // what a client may see (SPEC 5.7.2)
await bug.folio.comms();   // the conversation in time order: messages, emails
await folio.addCc('Tim Thornburg <tim@pursuant.com>', { actor });                // CC a person or channel (SPEC 5.7)
await folio.addCc('#acme-staff', { actor, audience: 'team' });                   // team: hears everything; default is client
await bug.folio.comment('Fixed, summary below…', { actor, to: 'client' });          // to every client CC (or a list of keys)
await folio.clientThread();  // { waiting: 'us' | 'client', since, first_reply, last_in, last_out, … }
await folio.receive({ channel: 'slack', address: '#acme-support' }, 'On it', { ref: 'ts-1' }); // a reply, credited to the CC
await folio.emails();      // filed emails: headers, readable body text

// The checklist: Markdown checkboxes under "## Checklist" in README.md (SPEC 5.9). Small things only.
await folio.editChecklist({ add: ['Confirm launch date', 'Send DNS change'], check: [1] });   // by number or text
await folio.checklist();                        // { items: [{ n, done, text }], done: 1, total: 2 }
await folio.checklistItemToFolio('Send DNS change', { actor });   // too big for a checklist: a folio inside this one

// Tasks: well-defined work run on a platform such as engine9 (SPEC 5.8); the folio keeps a copy.
const task = await folio.addTask({ title: 'Create database', environment: 'engine9/acme',
  path: '@engine9/plugins/e9workers:EchoWorker', method: 'echo', options: { message: 'hi' }, within_minutes: 30,
  run: { flow_run_id: '0196f1d0-…', task_run_ids: ['0196f1d1-…'] } }, { actor });   // tasks/create-database/task.json
await folio.updateTask(task.id, { state: 'COMPLETED', records: 1, result: 'Created', output: { ok: true } }, { actor });
await folio.tasks({ open: true });   // [{ id, title, environment, target, state, overdue, run, ... }]

// Pasted text: Markdown, HTML or plain text by detection; `as` overrides; the type can be changed after.
folio.choices({ text: pasted });                        // { kind, as: 'markdown', label, where, choices: [...] }
const [note] = await folio.add({ text: pasted }, { actor });                  // notes/2026-11-09-kickoff.md
await folio.setTextFormat(note.path, 'html', { actor });                      // renamed; links to it follow
// Exports from other tools become folios inside this one; importing again skips what is already there.
await folio.import(asanaJson, { actor });                                     // or folio.add({ name: 'x.json', data })

```

Behaviours worth knowing:

- **Safe concurrent edits.** `updateManifest(patch, { ifMatch })` writes `folio.json` conditionally; a stale etag gets a `ConflictError`. Every change is recorded in `history/changes/` (`{ at, actor, via, type, changes: { field: { from, to } } }`), and edits that change nothing record nothing.
- **Readiness is computed** from status, `hold`, `waiting_on` and `blocked_by` (`readiness(manifest, statusOf)`), never stored. `blocked_by` loops are refused (`wouldCycle`).
- **Repository listing is by reference.** Entries in `folio.json` work with no integration; every entry reads as `reference_only` in this library.
- **Unknown fields are preserved** when manifests are edited.
- **Reading email.** `parseEmail(text)` returns headers plus readable body text (plain, quoted-printable, base64, multipart; HTML reduced to text). `folio.emails()` lists a folio's filed emails with that text, so hosts can show or summarise them. Stored bytes are never changed.
- **Content policy lives here too** (SPEC 3.7, [GUIDE.md](GUIDE.md)). Intake removes credentials and card, bank and Social Security numbers from text, refuses key files, skips `.git`/`node_modules`, and summarises data files and logs (`summarizeData`, using [`@engine9/pii-classifier`](https://github.com/engine9-ai/pii-classifier)) into `sources/data/` instead of storing them. The originals go to the `hold` you pass to `Folio.open(fs, { hold })` (folio-server: R2; CLI: `LocalHold`, `~/.folio/hold`). `scrubText(text)` and `prohibitedIn(text)` are exported for hosts.
- **Intake routing lives here.** `folio.add(item, { folder })` recognises repositories, emails, links, text and files and puts each in the right place, with provenance under `history/intake/`. Hosts (the browser, email forwarding, MCP, the CLI) only hand items over.
- **Binary files.** `write(path, data)` takes a string or a `Uint8Array`; stores may add `readBytes(path)`. Manifest and message files stay JSON text.
- **Every folio carries** `type`, `tags`, `owner`, `target_date`, `outcome`, `resolution`, `waiting_on`, `hold`, `relationships`, `links`, `external` and `aliases` (SPEC 5.1). `EDITABLE` lists what `edit()` accepts; custom types and statuses are allowed with a warning, except type `task` (`RESERVED_TYPES`), which is refused: a task is a platform run. Something to do is an `action`; Asana tasks and Trello cards import as `action` folios.
- **Text formats.** `detectTextFormat(text)` says Markdown, HTML or plain text (with reasons); `titleOfText` and `htmlToText` are exported. Intake items may carry `as` (`markdown`, `html`, `text`, `json`, `import`, `comment`, `update`, `file`) and `name`.
- **Imports.** `detectImport(json)` recognises Asana, Trello and `{ folios }` exports; `folio.import()` creates folios inside the folio in one pass (ids claimed first, so dependencies can point at folios not yet written; sub-items go inside their parent), records `external: { source, id, url }` on each, and writes a report to `history/imports/`.
- **Folders all the way down.** A folder with a `folio.json` is a folio; folios can hold folios. `Folio.open(fs, { nested })` takes the nested folios' folders (or `'detect'`) and hides them through `ExcludingFs`; `nestedFolioDirs(fs)` finds them; `folio.child(dir)` opens one through `SubFs`, and `createChild` makes one (and calls the host's `onChild`). Folio's own directories (`RESERVED_DIRS`) never hold nested folios.
- **CC is per folio** (SPEC 5.7): people and channels (email, Slack, SMS, others) in `folio.json` `cc`, each on the **team** list (hears everything) or the **client** list (hears only messages whose `to` names them). `comms()` tags every item with its thread (`team`/`client`, `in`/`out`) and `clientThread()` says who is waiting on whom. The library never sends anything; delivery is a hosting add-on. Hosts learn of new messages (with their `to`) through the `onMessage` option.
- **Tasks copy engine9's model** (SPEC 5.8), and are only for runs a platform defines and executes: never human to-dos, checklists or open-ended work, which are sub-folios (`createChild`). `path` + `method` or `flow_id`, `options`, an `environment` (`engine9/acme`), engine9 state types (`TASK_STATES`), run ids, a `complete_by` window (`overdue` is computed). The definition is fixed once recorded; `updateTask` takes what the platform reports, keeps each state change in the task's `history`, and posts to `comms/` when a task is recorded and when it finishes. Output over 64 KB is refused. The library never runs a task.
- **No permissions in a folio.** Access rules belong to the hosting service.
- `NodeFs` overwrites are check-then-write; protect against other processes writing the same folder yourself.

## Develop

```bash
npm install && npm test          # node --test
node scripts/build-examples.js   # regenerate examples through the library
```

MIT licensed.
