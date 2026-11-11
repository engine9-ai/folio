# Folio
## Product and functional specification

> **Status.** This is the working specification as finalised in the 2 November 2026 product conversation. It supersedes the earlier draft. It remains a living document: where a decision here conflicts with an earlier idea, this document wins. Scope for the first release is in [section 19](#19-version-1-scope-and-deferred-work).
>
> **Changes on 11 November 2026 (team and client):** a folio's CC list has **two buckets** (5.7). The **team** (staff, closely integrated partners) hears everything said in the folio, internal notes included; the **client** hears only messages deliberately sent to them, and a message records exactly which client contacts it went to (`to`). A CC is a client unless put on the team. What was sent to the client and what came back from them form the **client thread**, interleaved with the team's conversation but with its own timing: who is waiting on whom, and since when (3.1.2, 5.7.1). `internal` on messages is replaced by `to`.
>
> **Changes on 10 November 2026:** **work is only folios**: work is folios inside folios (**sub-folios**). `ticket` is an ordinary type, nothing special; a sub-folio has no type unless given one. Support for layouts from before 1.0 (`upgradeLayout`, `sources/email/`, `sources/uploads/`) is removed; there are no such folios. On a folio's page the folios inside it are listed in the side column (13.2). **Priority is removed** as a concept. Urgency is in the eye of the beholder; status, target dates, blockers and tags carry what a team needs. A `priority` field written by hand is kept untouched as an unknown field (3.4); Folio does not read, set, validate or show it, and imports do not derive one.
>
> **Changes on 9 November 2026 (CC):** every folio keeps its own **CC list** of people and channels kept informed: email addresses, Slack channels and people, phone numbers for SMS, or any other channel (5.7). The list lives in `folio.json`; **delivering** to it is an optional add-on of each hosting deployment, configured there and never in the folio. A message that comes back from a CC is credited to that person or channel (3.1.2).
>
> **Changes on 7 November 2026:** a content policy (3.7) with [GUIDE.md](GUIDE.md) as its user guide: no credentials, card, bank or Social Security numbers; client contacts are fine, other people's personal data is anonymised; code is referenced, not copied. Data files and logs are summarised, with personal data masked by `@engine9/pii-classifier`, and the originals held in temporary storage (8.4.1). Repository entries may record `references` to releases, pull requests, issues and commits (3.2.1).
>
> **Changes in 1.0 (9 November 2026):** **work is folios inside folios** (5). Type, tags, owner, blockers and readiness are fields of every folio (5.1, 5.2); every change to `folio.json` is recorded (5.4); imports create folios (4.4.1).
>
> **Changes on 6 November 2026:** adding anything to a folio goes through one routing rule owned by the library (8.6), used by drag and drop, uploads, the CLI and email forwarding; email forwarding to a folio's address is in version 1 (8.1); permissions live only in the hosting service (11.1).
>
> **Changes from the draft:** git repository listing is a core part of the folio model (3.2.1); Slack capture is out of version 1; the preview-isolation requirement is kept but its implementation is a tracked TODO; hosting is a single production environment at `folio.engine9.ai`.

**Purpose:** A shared, human-operated workspace for bounded pieces of work, customer communication, feedback, evidence, and deliverables. Folios are understandable and usable by people and by external AI agents.

**Foundational definition:** **A folio is a folder.** Its files are the complete, portable record of the work. The Folio application organises, protects, presents, and updates those files; it does not define their existence.

---

## 1. Product vision

Teams supporting multiple accounts need somewhere to hold the complete context for a piece of work. That work may be a brief support request finished in an afternoon, a website review lasting two weeks, or an ongoing engagement spanning several months. The same workspace should accommodate all three without requiring the account to adopt a heavyweight project-management system.

A folio brings together a description of the work, the work inside it (as folios), relevant correspondence, decisions, files, feedback, deliverables, previews, and references to external tools. People should be able to understand what is happening at a glance, and an authorised agent should be able to examine and update precisely the same record.

A folio is not a chat transcript, a database row, an AI-agent session, or a GitHub repository. Those things may interact with a folio, but none should be necessary to understand it.

### 1.1 Product promises

1. **Portable by design.** Copy a folio folder and its meaningful history comes with it. Its ordinary files can be opened and edited without the Folio service.
2. **Human-led.** Humans own objectives, decisions, priority, approvals, and customer relationships. AI tools assist through well-defined access rather than operating an independent project system.
3. **Outcomes first.** Folios, and folios inside them, are the customer-facing units of work. Fine-grained execution steps may be numerous but need not become folios.
4. **Evidence before inference.** Important claims, feedback, decisions, and status changes can be traced to their original source.
5. **Integration without lock-in.** A folio may connect to many GitHub repositories and MCP services; unavailable integrations do not make its stored content unreadable.
6. **One record, many interfaces.** The browser, file tools, and MCP clients see the same folio content and follow the same access rules.
7. **Appropriate scale.** The system should be as comfortable with one folio and three files as with hundreds of folios inside it and months of correspondence.

### 1.2 Intended users

- **Account managers and support staff** collect requests, communicate status, gather feedback, and coordinate work.
- **Engineers and designers** investigate issues, work across repositories, publish artifacts, and request review.
- **Account stakeholders and invited reviewers** inspect selected work, preview deliverables, and submit feedback.
- **External AI agents** use permitted MCP capabilities to read context, organise evidence, propose changes, or update approved folio files.
- **Platform administrators** manage membership, access, integrations, and operational policy without owning the folio's substantive content.

### 1.3 What Folio is not

Folio is not a full CRM, shared email inbox, issue tracker for every engineering task, general-purpose web host, source-code repository, or native AI chat application. It should integrate with specialised systems without duplicating them unnecessarily.

---

## 2. Language and conceptual model

The application uses clear, stable terminology.

| Term | Definition |
|---|---|
| **Account** | An organisation or working group whose members may access one or more folios. |
| **Folio** | One self-contained folder representing a bounded body of work. |
| **Folio type** | Why a folio exists: a project, a task, a bug, a support request, a review... A folio may have no type. |
| **Relationship** | A connection between folios, such as blocked by, related, or discovered from. |
| **Execution record** | Optional fine-grained steps, actions, or agent runs undertaken to advance a folio; not a folio itself. |
| **Task** | One run of a well-defined piece of work on an execution platform (an engine9 worker method or flow): a definite name, options and output, in a known environment, that completes or fails within a time window. Run elsewhere; the folio keeps a copy of what was asked and what came of it (5.8). |
| **Source** | Original evidence, such as an email, a Slack discussion, a submitted form, a captured GitHub item, or a document. |
| **Feedback form** | A defined set of questions used to solicit responses about a folio or a particular artifact. |
| **Feedback response** | A preserved answer to a published form. |
| **Artifact** | A deliverable or reviewable output, including documents, images, exports, or static website previews. |
| **Decision** | A consequential choice and the rationale and evidence behind it. |
| **Connection** | An association with a repository, MCP server, Slack context, or other external service. |
| **Preview** | A safe, viewable representation of an artifact or an explicitly linked external deployment. |

The normal hierarchy is:

**Folders → Folios → Folios inside them / Communications / Feedback / Artifacts / Files / Decisions / Sources**

Work is broken down by putting folios inside folios (5). A folio need not contain any if it is being used to collect materials or share a deliverable.

### 2.1 Folio identity

Each folio has a stable identifier, a human-readable title, and optionally a convenient folder name. Its identifier stays the same when the folder is renamed or moved. The folder name is not a permission boundary or a permanent identifier.

A folio sits in a host's folder tree (inside a top-level folder, 3.1.1) *for purposes of hosted access*. Where it sits is not intrinsic to its portable contents. Importing the folder elsewhere should require an explicit new hosting and access decision.

### 2.2 Human-readable language

Prefer labels such as **Open Folio**, **New Folio**, **Waiting on Feedback**, **Preview**, **Decision**, **Related Files**, and **Ready to Work**. Avoid developer-only language in the ordinary customer experience. In particular, a folio of work is not interchangeable with an internal action, command, or agent execution step.

---

## 3. The folio as a portable folder

The folio folder is the authority for everything describing the work: identity, title, summary, status, the work inside it, decisions, feedback, correspondence, and artifacts. A service may cache or display these facts, but it cannot replace the files as the source of truth.

### 3.1 Illustrative directory structure

```text
folios/
  customer-portal/
    folio.json
    README.md
    AGENTS.md
    CONTEXT.md

    comms/                       every message, in time order (3.1.2)
      2026-11-02-donate-button-broken-1a2b3c4d.eml
      2026-11-09-153012-m-r-to-confirm-the-split.comment.json
      2026-11-09-160000-on-track-for-friday.update.json
      2026-11-09-161500-scanned-three-tables.agent.json

    attachments/                 files people add: screenshots, documents, an email's attachments

    fix-mobile-redirect/         a folio inside the folio: one piece of the work (5)
      folio.json                 type, status, owner, blockers...
      README.md
      comms/
      attachments/

    decisions/
      DEC-001.json
      DEC-001.md

    feedback/
      forms/
        FORM-001/
          form.json
          versions/
      responses/
        RESPONSE-001.json
      attachments/

    artifacts/
      ART-001/
        artifact.json
        versions/
          001/
            ...files...

    tasks/                       well-defined work run elsewhere, one folder each (5.8)
      create-database/
        task.json                definition, environment, run ids, state, history
        output.json              the (small) result, when kept

    sources/                     references and evidence that are not messages
      data/                      summaries of data files and logs (8.4.1)
      links/
      github/

    notes/
    integrations/
      references.json
    history/
      changes/                   every change to folio.json (5.4)
      intake/
      imports/
    indexes/
```

The outer `folios/` folder is a collection of folio folders. The portable unit is **`customer-portal/` itself**, including all of its descendants (except folios nested inside it, 3.8). Where it sits in a host's folder tree (for example `acme/clients/customer-portal/`) is not part of the folio's own identity or contents.

The directory layout is a convention rather than a rigid empty scaffold. Only `folio.json` and `README.md` are required for a minimal folio. All optional directories can be absent until used. A folio created manually with those two files should be recognisable without a platform-generated database record.

### 3.1.2 Communications and assets

**All back-and-forth about the work lives in one folder, `comms/`**, whatever form it took: emails, comments, status updates, agents' reports, captured chats, and summaries. **The extension says what a message is**, and the name starts with its date and time, so the folder lists in order and a conversation reads top to bottom:

| File | Kind |
|---|---|
| `*.eml` (and `*.msg`) | An email, as received (or a text copy, 3.7) |
| `*.comment.json` | A comment |
| `*.update.json` | A status update |
| `*.agent.json` | What an agent did or found, in its own words |
| `*.chat.json` | A captured chat thread (Slack and the like) |
| `*.summary.md` | A summary that stands in for the messages before its date |

A message file is JSON: `{ "at", "kind", "author": { "type", "id", "name"?, "on_behalf_of"?, "channel"?, "workspace"? }, "via", "text", "attachments"?: [paths], "imported"?, "ref"?, "task"? }`. `task` is the folder of the task (5.8) a message is about. A message that came in over a channel from one of the folio's CCs (5.7) is credited to it: `author` is `{ "type": "person" | "channel", "channel", "id": <its address>, "name"? }`, and `ref` is the channel's own id for the message (`{ channel, id }`), so a second delivery is not stored twice. A message without `to` is for the **team**: everyone with access, and the CCs on the team list. `"to": ["email:tim@pursuant.com", …]` makes it a message **to the client**: sent to exactly those client CCs (keys as in 5.7), and seen by the team as always. Readers tag each item with its thread (`team` or `client`) and each client item with its direction (`in` from the client, `out` to them); see 5.7.1. Messages are written once and never edited, so they need no locking and never conflict with edits to `folio.json`.

**Files are assets and live apart**, in `attachments/`; a message refers to them by path. Keeping the conversation in one folder of small files makes it easy to read, search, summarise and compress (older messages can be replaced by a `*.summary.md`), without visiting a folder per kind of message.


### 3.1.1 Folders all the way down

There is one kind of container: the folder. A folder **is a folio when it holds a `folio.json`**; otherwise it is an ordinary folder that groups other folders and folios. Folios can hold folios.

```text
acme/                          a top-level folder: one organisation or team (what hosts used to call an account)
  README.md                    optional: what the folder holds
  clients/                     a folder grouping work
    customer-portal/           a folio
      folio.json
      comms/ ...
      phase-2/                 a folio inside a folio
        folio.json
  internal-tools/              a folio directly in the top-level folder
    folio.json
```

The rules (3.8 has the detail):

- **A host's accounts are its top-level folders.** There is no separate account object; membership is access granted on the top-level folder (11.2).
- **Access is granted on folders**, at any depth, and flows down (11.2). A folio needs no permission machinery of its own.
- **Any folder can become a folio** by gaining a `folio.json`, and keeps its contents and any folios inside it.

### 3.2 `folio.json`

`folio.json` is the machine-readable manifest at the folder root. It provides durable information such as:

- Stable folio ID and a title.
- Concise summary, purpose, and desired outcome.
- Lifecycle status, type, owner, target date, tags, and relationships to other folios (5.1).
- Creation and last meaningful update timestamps.
- Optional key dates.
- Optional non-secret repository references, connection aliases, and related external URLs.
- Optional pointers to noteworthy files or current artifacts.
- A declared folio data-format revision for readers that understand structured fields.

Illustrative manifest:

```json
{
  "format": "folio",
  "format_revision": 1,
  "id": "fol-7k32",
  "title": "Customer portal sign-in improvements",
  "summary": "Investigate authentication reports and review the updated sign-in experience.",
  "status": "active",
  "type": "project",
  "created_at": "2026-11-02T10:00:00Z",
  "updated_at": "2026-11-02T10:00:00Z",
  "tags": ["support", "website"],
  "repositories": [
    {
      "provider": "github",
      "repository": "example/customer-portal",
      "url": "https://github.com/example/customer-portal",
      "purpose": "Portal application",
      "role": "primary",
      "default_branch": "main",
      "added_at": "2026-11-02T10:00:00Z"
    }
  ],
  "connections": [
    { "type": "mcp", "alias": "support-data", "purpose": "Read customer support context" }
  ]
}
```

The example describes semantics, not a commitment to any particular storage engine or application programming interface. Standard JSON is the sole structured manifest format: no YAML, JSON5, or application-specific binary representation is required.

### 3.2.1 Repository listing (core)

A folio documents the git repositories its work touches, in the `repositories` array of `folio.json`. This is a core feature of the format, not an integration: **a listing is a reference, it works with no GitHub connection, nothing fetches it automatically, and it never stops being readable.** A person (or an agent) records a repository by hand and anyone reading the folder learns where the code lives and why it matters.

Each entry has:

| Field | Required | Meaning |
|---|---|---|
| `provider` | yes | `github`, `gitlab`, `bitbucket` or `git` (any other host). |
| `repository` | GitHub: yes | `owner/name`. For other providers, optional. |
| `url` | non-GitHub: yes | Web or clone URL. Must not embed credentials. |
| `purpose` | no | Why this repository is part of the work, in a sentence. |
| `role` | no | `primary`, `secondary` or `reference` (read only, for context). |
| `default_branch`, `branches` | no | Where to look. Informational. |
| `notes`, `added_at`, `added_by` | no | Free text and provenance. |
| `references` | no | Releases, pull requests, issues, commits, branches or files that matter to the work: `{ kind, url, tag \| number \| sha \| name \| path, added_at, added_by }`. Added when such a link is dropped on the folio. |

Rules:

1. Listing is by reference only. Source code is not copied into the folio (see 8.3).
2. A folio may list any number of repositories, with different roles.
3. Duplicates (same provider and repository, ignoring case) are flagged.
4. Folios and decisions may cite a specific branch, file, commit, pull request, release or issue within a listed repository; the cited repository should be listed.
5. Live state ("connected", "requires authorisation") is computed by a hosting service and is never written into the folio. In the portable library every entry reads as `reference_only`.
6. Material GitHub discussions or issues are captured under `sources/github/` with their live reference, as in 8.3.

### 3.3 `README.md`, `CONTEXT.md`, and `AGENTS.md`

- **`README.md`** explains the folio to a person encountering it for the first time: why it exists, what matters, the current outcome, and where important material can be found.
- **`CONTEXT.md`**, if present, is a concise working summary that helps someone resume after time away. It is advisory and must not overwrite detailed source records.
- **`AGENTS.md`**, if present, gives agents helpful folio-specific working instructions and conventions. It is not a grant of access and cannot supersede system security or human approvals.

These files should be valuable in an ordinary editor, whether or not the hosting application is available.

### 3.4 File rules and portability

1. All internal references should use stable IDs and relative paths within the folio wherever possible.
2. Documents should use widely understood formats. Structured records use JSON; narrative text should generally use Markdown; original emails retain MIME/EML format; binary artifacts retain their original bytes.
3. A file may reference an external resource, but the reference must clearly identify that resource as external. An external link alone is not a portable copy of its contents.
4. Unknown optional fields should not be discarded merely because an editor does not understand them.
5. Files should remain intelligible if generated indexes or application caches are deleted.
6. Security credentials, session tokens, secret values, and live access grants must never be required inside a folio.
7. Renaming a folder or transferring it to another storage provider should not invalidate its internal records.
8. A folder should be portable without requiring a proprietary export format. ZIP is a convenient transport, not the source of truth.

### 3.5 Portability boundaries

The folder can preserve **content**, but it cannot automatically carry a live identity session, ownership of a GitHub repository, an MCP credential, or permission to view a protected deployment. After import, those integrations may appear as **unconnected** until explicitly authorised again. They must not silently reconnect using somebody else's account.

### 3.6 Provenance and lasting knowledge

If a decision depends on an email, that original email or a faithful retained copy should live in `sources/`. If a customer commented on a website preview, the response should reference the exact preview version shown. Summaries and annotations may make the material easier to navigate, but they cannot be the only surviving record of what was said or reviewed.

### 3.7 Content policy

What a folio holds is shared with everyone who can read it, copied when it is exported, and read by agents. So some things never belong in one. [GUIDE.md](GUIDE.md) explains this for the people and agents using folios; the library enforces it when items are added (8.6) and `validate` reports what got in another way.

1. **No credentials.** Passwords, tokens, API keys, private keys and connection strings with passwords are never stored. A folio says where a credential lives (a password-manager vault and item), never what it is. Key and credential files are refused at intake; credentials in text are replaced with a pointer to the password manager. (This strengthens 3.4(6).)
2. **No payment, bank or Social Security numbers.** Card numbers, bank account numbers (IBAN) and US Social Security numbers are replaced with a masked form wherever they are added: notes, comments, folio titles, summaries and READMEs, text files. An email carrying one is kept as a text copy without it, and its original is held temporarily (8.4.1). Known test values are not personal data and are kept.
3. **Client contacts are expected; everyone else is anonymised.** The account's own people (who send the emails, attend the meetings) are part of the record. Members, customers, donors and others the client serves are referred to by the client's identifiers. Sample rows and aggregates are fine; full result sets and exports are summarised (8.4.1).
4. **Images are kept as they are.** A screenshot may show personal data; that is accepted.
5. **Code is referenced, not copied.** Repositories are listed (3.2.1), with the releases, pull requests, issues and commits that matter. Samples, snippets in notes and comments, and deliverable artifacts are fine; codebases are not (`.git` and `node_modules` folders are skipped at intake, and `validate` warns about many source files outside `notes/`, `samples/` and `artifacts/`).

Personal data is detected by [`@engine9/pii-classifier`](https://github.com/engine9-ai/pii-classifier), the same classifier for every interface. Detection is heuristic: it errs towards masking, and people remain responsible for what they write.

---

### 3.8 Nested folios

A folio inside a folio is a separate record, as if it sat anywhere else:

- The folio around it does **not** list, search, validate or write the nested folio's files. Its own tools (and the library's `Folio`, given the nested folders or `nested: 'detect'`) see only its own record; the nested folio appears to it as a folder to open.
- A nested folio can be shared, restricted, moved or exported on its own. Exporting the outer folio includes nested folios only if asked.
- Folio's own directories (`comms/`, `attachments/`, `sources/`, `notes/`, `history/`, `indexes/`, `feedback/`, `artifacts/`, `decisions/`, `integrations/`, `samples/`, `tasks/`) never hold nested folios. A `folio.json` filed under them (inside an uploaded folder, say) is just a file.
- Making a folder inside a folio into a folio moves its files out of the outer folio's view, not out of the folder tree.

## 4. Folio lifecycle and organisation

### 4.1 Create

A person should be able to create a folio by providing only a title and choosing a folder (a top-level folder, a folder in it, or another folio). The folio's folder is named after its title. Description, dates, repositories, collaborators, and integrations are optional. The system establishes the portable folder and provides a readable starting point.

A folio can also be introduced by importing an existing folder, including one composed outside the Folio application. The product must recognise valid content rather than insisting that it originated in the application. An existing folder becomes a folio by gaining a `folio.json` ("Make Folio"); if it already has one, its identity is kept.

### 4.2 Discover and navigate

People working with many organisations need to find folios by folder, title, status, owner, tags, recent activity, type, readiness, and available context. Lists and search results are *views of folio content*, not independent records that must be maintained manually.

A folio overview should answer: **What is this? What is outstanding? What changed? What needs my attention? Where is the latest deliverable?**

### 4.3 Status and completion

A folio's **status** is, after its title, the most important thing about it. It lives in `folio.json` (`status`) and is the folio's column on its folder's board (13.1.1). The standard statuses, in board order:

| Status | Board column | Meaning |
|---|---|---|
| `draft` | Draft (shown only when used) | Being assembled; not yet real work. |
| `backlog` | Backlog | Recorded, not scheduled. |
| `planned` | Up Next | Scheduled to start soon. |
| `active` | In Progress | Work is proceeding. The default for a new top-level folio; a folio created inside another starts in `backlog`. |
| `waiting` | Waiting | Progress depends on an external response or decision. |
| `review` | In Review | Delivered for review or approval. |
| `completed` | Done | The agreed outcome is delivered; records remain accessible. |
| `archived` | Archived (hidden unless asked) | Retained for history and reference, with conspicuous read-only defaults. |

A folio may use a status of its own (a lowercase word such as `blocked-on-legal`); validation warns, and boards show it as an extra column. A folio can be reopened. Closing or archiving a folio must not discard histories, feedback, or artifacts. Moving it between top-level folders is an intentional administrative action involving a fresh permission assessment. `folio.setStatus(status)` changes it; hosts may keep a disposable index of titles and statuses (12.3) and are told of every change through `onManifest`.

### 4.4 Duplicate, move, export, and import

Users should be able to duplicate a folio as a starting point, export it, restore it, or move it. The interface must distinguish **copying the same record** from **creating a new folio based on an existing one**. A copied record retains its identity and history; a new folio created from a template gets a new identity and may omit customer-specific evidence.

Import should flag broken internal references, conflicting folio identities, unavailable external connections, suspicious attachments, and missing original evidence. It should not fabricate missing source material or silently apply permissions embedded in the folder.

#### 4.4.1 Importing work from other tools

An export from another tool becomes **folios inside the folio** it is added to. It is added like anything else (8.6): dropped as a file, pasted as text, or handed over by an agent. The library recognises the export by its shape:

| Format | Recognised by | Becomes |
|---|---|---|
| Asana | Asana's project JSON export or API task lists: `{ "data": [task, ...] }`, `{ "data": task }` or `[task, ...]`, where tasks have `gid` and `name` and Asana's task fields | One folio (type `task`) per task. Subtasks go inside their task's folio, `dependencies` become `blocked_by`, sections and tags become tags, a "Type" field the type, completed tasks are `completed`, a section like "In progress" or "Waiting" sets the status, `due_on` the target date, the assignee the owner, `notes` (or `html_notes`) the README with the other custom fields (a "Priority" field included, as text) and the Asana link below it, and comments in `stories` the folio's `comms/` |
| Trello | A board export: `{ cards, lists, labels, actions }` | One folio per card: the list and labels become tags, a "Done" list completes it, an archived card is archived, comments go to `comms/` |
| Folio list | `{ "folios": [{ id, title, description, type, status, tags, owner, target_date, parent, blocked_by, comments }] }` | One folio each; `parent` and `blocked_by` refer to other entries by `id` |

- Each imported folio records where it came from in `external` (`{ source, id, url }`). **Importing the same export again skips what was already imported**, so an export can be re-imported after more work was added to it.
- Blockers that would form a loop are left out. Text is scrubbed like any other (3.7). Up to 500 items per import.
- A record of each import (what was created from what) is kept in `history/imports/`. Nothing else from the export is kept; to keep the export itself, add it as a file instead (`as: "file"`).

---

## 5. Folios inside folios: the unit of work

There is no separate work-item object. **A piece of work is a folio**, and a folio's work is broken down into **folios inside it** (3.8). A bug report, a support request, a feature, a review, a whole project: each is a folder with a `folio.json`, its own `comms/`, `attachments/` and history, and its own email address and sharing. A piece of the work is a **sub-folio**, with a `type` such as `task`, `bug` or `support`, or none. A small folio may hold no folios at all; a substantial one holds a few, and those may hold their own.

### 5.1 What every folio carries

The fields that matter for tracking work all live in `folio.json`:

| Field | Meaning |
|---|---|
| `id`, `title`, `summary` | Identity and what it is. The folder name follows the title and may change; the id does not. |
| `type` | Why it exists. Suggested: `project`, `task`, `ticket`, `request`, `support`, `bug`, `feature`, `review`, `investigation`, `epic`. Others are allowed (a lowercase word; validation warns). |
| `status` | Its column on the board (4.3). |
| `tags` | Free-form words for grouping and filtering. |
| `owner`, `target_date` | Who is responsible (an email or a name) and when it is due (`YYYY-MM-DD`). |
| `outcome`, `resolution` | What a good result looks like; why it ended (`completed`, `duplicate`, `declined`, `cannot_reproduce`, `superseded`, `cancelled`, or custom). |
| `waiting_on`, `hold` | What it waits for (an outside response); an explicit manual hold. Kept apart from dependencies so the reasons stay distinguishable. |
| `relationships` | `[{ type, target }]` to other folios, by folio id (5.2). |
| `links` | Evidence elsewhere: `{ type, label, url \| path }`. |
| `external`, `aliases` | Where an imported folio came from (`{ source, id, url }`), and other identifiers it answers to (such as the id it had in the tool it came from). |
| `cc` | People and channels kept informed about this folio (5.7). |

Longer explanation goes in the folio's `README.md`. Status is not inferred from a message's tone; people set them, and every change is attributable (5.4).

### 5.2 Relationships and readiness

Folio adopts the useful concepts of dependency-aware trackers such as Beads, without their storage or orchestration model. Containment is the hierarchy: a folio inside another is part of it. Other relationships point at folio ids, so they survive renames and moves:

| Relationship | Example | Behaviour |
|---|---|---|
| `blocked_by` | "Ship updated flow" is blocked by "Confirm identity behaviour" | An unfinished blocker keeps the folio from being ready. Loops are refused. |
| `related` | Two symptoms share a likely cause | Navigation and context only. |
| `discovered_from` | A mobile defect found while investigating desktop login | Provenance; not a dependency. An import into a folio marks what it created this way. |
| `duplicate_of`, `supersedes` | Two reports describe the same issue | Both records are kept; one is canonical. |

**Readiness** is calculated from the files, never stored:

| State | When |
|---|---|
| `done` | Status `completed` or `archived`. |
| `blocked` | Any `blocked_by` folio is not done, or `hold` is set. |
| `draft` | Status `draft`. |
| `waiting` | `waiting_on` is set, or status `waiting` or `review`. |
| `ready` | Status `backlog` or `planned`, with nothing blocking it: someone could usefully start it now. |
| `in_progress` | Any other status (normally `active`). |

The **Ready** view lists the folios inside a folio that are ready, each with its reason.

### 5.3 Execution details stay out of the list

An individual folio might take hundreds of low-level actions: reading logs, editing files, running checks, asking agents to investigate. Those are not folios. They go in the folio's `comms/` as agent reports and updates (`*.agent.json`, `*.update.json`), in `notes/`, or in referenced external logs, so the board stays a list of meaningful outcomes. Well-defined runs on an execution platform are recorded as **tasks** (5.8), not as folios.

### 5.4 Change history

Every change to `folio.json` made through the library is recorded in `history/changes/` as one JSON file: `{ at, actor, via, type, changes: { field: { from, to } } }` (`type` is `created`, `updated`, `status`, `related`, ...). Messages need no such record: they are in `comms/` and never edited. Histories are content and travel with the folder.

Direct editing of the files is legitimate. A host should flag changes it cannot attest (a `folio.json` edited outside the library has no matching change record) rather than claim its history covers edits made outside its control.

### 5.5 Interactions

A folio can be created from an email, a feedback response, a document, an artifact annotation, or a discovery made in another folio (`discovered_from`). People update it, comment on it, assign it, attach evidence, add blockers and mark it done. Closing invites a short update: what changed, how it was verified, what remains open. Reopening is a status change; the record is kept.


### 5.7 CC: people and channels kept informed

Every folio has its own **CC list**, like the CC line of a help-desk case but not tied to email. It names who hears about the folio's conversation, wherever they are:

| Channel | Address | Typed as |
|---|---|---|
| `email` | an email address (a person, or a list) | `tim@pursuant.com`, `Tim Thornburg <tim@pursuant.com>` |
| `slack` | a channel (`#name` or its id) or a person (`@name` or its id), optionally with the `workspace` | `#acme-support`, `@tim`, `slack:C0123ABCD` |
| `sms` | a phone number | `+1 202 555 0142` |
| any other word | whatever that channel uses | `teams:Support`, `whatsapp:+44…` |

It is stored in `folio.json`:

```json
"cc": [
  { "channel": "email", "address": "tim@pursuant.com", "name": "Tim Thornburg", "kind": "person", "audience": "client", "added_at": "…", "added_by": "chris@frakture.com" },
  { "channel": "slack", "address": "#fbcenc-staff", "workspace": "frakture", "kind": "channel", "audience": "team" },
  { "channel": "sms", "address": "+12025550142", "name": "Joe McLaughlin", "kind": "person", "audience": "client" }
]
```

**Two buckets.** Each entry's `audience` puts it on one of two lists:

| Audience | Who | Hears |
|---|---|---|
| `team` | Staff, and partners integrated closely enough to see the working conversation | **Everything**: internal notes, agents' reports, what was sent to the client, the client's replies |
| `client` | The client and other outside contacts | **Only messages deliberately sent to them** (a message's `to`) |

An entry without `audience` is a **client**: the safe side, because telling a client something by accident is worse than a teammate missing a note. Hosts may default people on their own staff domains to the team (folio-server: `TEAM_DOMAINS`). `folio.setCcAudience(key, 'team' | 'client')` moves an entry; `addCc(…, { audience })` changes it when asked for, and never otherwise.

- **Per folio.** A folio inside another has its own list; nothing is inherited. Adding or removing a CC is a change to `folio.json` and recorded like any other (5.4). `folio.addCc()`, `removeCc()` and `ccs()` manage it; duplicates (same channel and address, ignoring case) are not added twice.
- **A reference, not a connection.** Like a repository listing (3.2.1), a CC list works with no integration, and nothing in the folio sends anything. **Delivery is an optional add-on of each hosting deployment**, configured on the host, never in the folio (3.5, 10.3): a copied folio keeps its CC list without gaining the ability to message anyone. Hosts show each entry's live state (delivered on this deployment, or listed only); in the portable library every entry reads as `reference_only`.
- **What a host passes on.** When delivery is set up, each new message in `comms/` (comments, updates, agents' reports, emails filed there) goes to the folio's **team** CCs, and a message with `to` also goes to exactly those **client** CCs; the CC a message came from never gets its own message back. Imported history is not passed on.
- **Internal by default; the client is a deliberate choice.** Most messages are for the team, and writing to a client by accident is embarrassing. A host's composer starts on **Internal note**; **Message client** is a deliberate second choice that names each client contact (all ticked, any can be unticked), and the button names who will get it. Agents' messages are for the team unless they are told to send to the client.
- **Replies are credited.** A message that comes back from a CC (a Slack reply, an SMS, an email from a CC'd address) is posted to `comms/` credited to that person or channel (3.1.2) via `folio.receive()`. Only listed CCs may post this way. A reply from a team CC is part of the team's conversation; a reply from a client CC is part of the client thread.

#### 5.7.1 The client thread and its timing

The common case: a request comes in from a client; someone acknowledges it at once; staff are assigned, work it and talk among themselves; the client gets an update now and then; and finally a **solved** message with a summary. The client's experience is the client thread, and its timing matters: a client must not wait too long.

- **What is in it.** Messages sent to the client (`to`): direction `out`. Messages and emails from a client CC, and emails from anyone not on the team (the request that started it, a forwarded complaint): direction `in`. Hosts may say who else counts as the team (staff domains) so their emails are not taken for the client's.
- **One conversation.** The client thread is not a separate place: it is interleaved with the team's messages in time order, so the people working the folio always see what the client has been told. Pages mark client messages clearly ("To Tim, Joe", "From Tim") and may filter to the client thread alone.
- **Timing** (`clientThread(items)`, `folio.clientThread()`): `waiting` is `us` when the client's latest message is unanswered (since the first unanswered one) and `client` when the last word was ours (since then); plus `first_in`, `first_reply` (first response time), `last_in`, `last_out`, `unanswered`, `sent` and `received`. Hosts show it on the folio and its card, against a reply target they configure; a folio that is done needs no reply.
- **Closing.** Sending the summary to the client and setting the status are one step in a host's composer ("Send and mark Done").
- CC addresses are client and account contacts (3.7(3)); they are not secrets, and no credential or token for a channel belongs in the list.

### 5.8 Tasks: well-defined work run elsewhere

Some of the work in a folio is done by **tasks**: standard, well-defined runs on an execution platform, started by an agent or a person while working the folio. Folio's task is **engine9's task**, copied rather than reinvented (the engine9 Task API and its skills, `engine9-ai/skills` `e9-tasks-api` and `e9-dev-tasks`, are the authority for what a task is). "Task" is used loosely in many tools; here it means only this.

A task is not open-ended work ("get the groceries", "research this"); that is a folio, perhaps of type `task`. A task has:

- **A definite name**: one worker method (`path` + `method`, e.g. `@engine9/plugins/e9workers:EchoWorker` + `echo`; engine9's on-demand task) **or** a predefined flow (`flow_id`, its slug or a remote dataflow id, with optional per-step overrides `tasks: [{ task_key, options }]`). Never both.
- **Options**: the input it runs with.
- **An environment** where it runs: a platform and an account, written `engine9/acme`, or `{ platform, account_id, base_url?, connection? }`. `connection` names a `connections` entry in `folio.json` (`{ "type": "engine9", "alias": "acme", "account_id": "acme", "base_url": "https://data.engine9.ai", "purpose": … }`), which is how a folio tells an agent where its tasks run. No credentials, ever (3.7).
- **A state**, in the platform's terms: `PENDING`, `SCHEDULED`, `RUNNING`, `PAUSED`, then one of `COMPLETED`, `FAILED`, `CANCELLED`, `CRASHED`.
- **A time window**: `complete_by` (or `within_minutes` when it is recorded), and optionally `start_after`. A task not finished by then is **overdue**, worked out when read, never stored.
- **An output**: the worker's JSON result, a records count, errors, and `result`, a sentence on what came of it.

**The platform drives; the folio remembers.** The definition, the run, its logs and checkpoints live on the platform. A folio is a secondary record of initiation and tracking: it keeps what was asked, where, by whom, the ids to find the run again (`run: { flow_run_id, task_run_ids, url?, log_link? }`), its state over time and a small copy of the result, so later agents and people can see what was done without access to the platform. Live state (allowed actions, checkpoints, logs) is never copied in; it is looked up there with the run ids. A typical sequence:

1. An agent opens the folio and reads its context: `README.md`, `AGENTS.md`, `connections`, and `tasks/` for tasks already recorded (so the same work is not started twice).
2. It connects to the platform (engine9/acme), schedules the task there, and records it in the folio with its definition, options and run ids (`folio.addTask()`; MCP `add_task`).
3. It waits for the task, polling the platform.
4. It brings the record up to date (`folio.updateTask()`; MCP `update_task`): state, records, result, output. Then it carries on with the folio's work.

A task may be the whole of a folio's work ("Spin up client X" is a folio; Create database and Install plugins are its tasks), its context (a sample run that shows what the data looks like), or one step among many. A folio is not completed automatically when its tasks are; people (or agents) set the folio's status (4.3).

**On disk**, each task has its own folder in `tasks/`, named after its title, so tasks can later become something richer (even folios) without moving:

```text
tasks/
  create-database/
    task.json
    output.json        optional: the worker's JSON output
```

```json
{
  "format": "folio-task",
  "format_revision": 1,
  "id": "tsk-jzz4ve",
  "title": "Create database",
  "environment": { "platform": "engine9", "account_id": "acme" },
  "kind": "on_demand",
  "path": "@engine9/plugins/e9workers:DatabaseWorker",
  "method": "createDatabase",
  "options": { "region": "us-east" },
  "complete_by": "2026-11-10T14:35:00.000Z",
  "run": { "flow_run_id": "0196f1d0-…", "task_run_ids": ["0196f1d1-…"] },
  "state": { "type": "COMPLETED" },
  "start_time": "2026-11-10T14:06:00.000Z",
  "end_time": "2026-11-10T14:12:00.000Z",
  "records": 1,
  "result": "Database acme_main created in us-east.",
  "output": "output.json",
  "created_at": "2026-11-10T14:05:00.000Z",
  "updated_at": "2026-11-10T14:12:00.000Z",
  "created_by": { "type": "agent", "id": "claude", "on_behalf_of": "sam@example.com" },
  "history": [
    { "at": "2026-11-10T14:05:00.000Z", "state": "PENDING", "note": "recorded" },
    { "at": "2026-11-10T14:06:00.000Z", "state": "RUNNING" },
    { "at": "2026-11-10T14:12:00.000Z", "state": "COMPLETED" }
  ]
}
```

Other optional fields: `summary`, `description`, `tracking_code` (engine9's flow-run tag), `start_after`, `definition_url` (where the definition is documented), `errors: [{ level, message, ts }]`. Rules:

1. **The definition is fixed once recorded.** Updates change what the platform reports (state, run ids, times, records, errors, result, output, summary, `complete_by`); `options` may change only before the task starts (`PENDING` or `PAUSED`), as on engine9. A different definition is a new task. A retried run moving back to `RUNNING` is a state change like any other.
2. **Every change of state is kept** in the task's `history` (who, when, via what, an optional note), with the latest 100 entries.
3. **The conversation says so.** Recording a task and its reaching a final state each post one line to `comms/` (an agent's report, or an update when a person does it) that names the task and its folder (`"task": "tasks/create-database"` on the message), so the timeline shows the work without opening `tasks/`. Intermediate states are kept only in the task.
4. **Output is small.** `output.json` is at most 64 KB; samples and aggregates, never result sets (3.7). Card numbers and credentials are removed from options, output, errors and text. Bigger results stay on the platform.
5. **Listing** (`folio.tasks()`, MCP `list_tasks`) gives each task's state, environment, target, run ids, window and whether it is overdue; the overview counts total, open and overdue tasks. `validate` reports a `task.json` that is not a readable task.

Whether a task should itself be a folio (with its own conversation and sharing) is left open (17); the folder per task keeps that possible.

---

## 6. Customer feedback and forms

Feedback is both an incoming communication channel and a record of review. It should be possible to ask a group of people specific questions, collect responses, and associate those responses with the work being discussed.

### 6.1 Form creation

Authorised people may create a form attached to a folio. A form may optionally target a particular folio, artifact, or immutable preview version.

The form experience should support a title, description, instructions, optional deadline, confirmation message, and common field types: short text, long text, single choice, multiple choice, rating, yes/no, date, and attachments. Fields may be required or optional. Order and explanatory text should be editable before publication.

The product need not become a general survey builder. Form capabilities should favour clarity, speed, and direct connection to work.

### 6.2 Publishing and versions

A form can be drafted, published, closed, and reopened. Each submitted response remains tied to the exact published form definition the reviewer saw. Editing an already published form may create a new definition revision; it must not reinterpret historical answers.

The form definition and responses belong in the folio's `feedback/` folder. Sharing invitations and their revocation state are access controls, not portable business records.

### 6.3 Respondent experience

A reviewer with appropriate access should receive a simple form with context, clear questions, and an optional link to the artifact or folio under discussion. Reviewers should not need general access to the entire folio simply to submit feedback.

The product should allow authenticated participants and time-limited invitation links. Anonymous public collection is not the default. Each submission should preserve when it was received, which form revision was answered, and any identity information the reviewer voluntarily or authoritatively provided. Avoid requesting personal data unnecessarily.

### 6.4 Triage and follow-through

Submitted feedback enters a review queue where an authorised person can:

- Acknowledge and categorise the response.
- Link it to an existing folio.
- Create a folio from the response.
- Mark it informational, duplicate, accepted, deferred, or declined.
- Attach a note explaining the disposition.
- Associate it with a particular artifact version or page/element when relevant.

A response is evidence, not an instruction to modify the product automatically. Triage may create separate annotations or folios; the original response remains unchanged.

### 6.5 Feedback on a preview

A reviewer might say, “The primary button overlaps the form on mobile.” The response should identify the specific preview version and, when available, the page URL, viewport or device context, and a screenshot or annotated location. Comments must remain understandable if the preview URL later expires.

---

## 7. Artifacts and previews

Artifacts are the things produced, reviewed, or delivered through a folio. They may be finished outputs or intermediate review builds.

Examples include a PDF, an image collection, a research memo, a CSV export, an HTML prototype, a static website build, or a link to an externally hosted staging environment.

### 7.1 Artifact collection

Each artifact should have a stable identity, a name, purpose, type, owner or publisher when known, creation date, optional description, and links to relevant folios and decisions. Its files and non-secret descriptive information belong inside `artifacts/`.

Artifacts should be discoverable by name, type, last update, associated folio, and whether review is requested. Account stakeholders may see a curated artifact view rather than the complete filesystem.

### 7.2 Immutable review versions

When an artifact is published for review, that published state should be preserved. Reviewers and folios can then cite an exact version. New uploads may produce subsequent versions without rewriting what someone previously approved or commented on.

An artifact can carry a review state such as `draft`, `ready_for_review`, `changes_requested`, `approved`, or `superseded`. The approval is meaningful only with respect to a particular artifact version and its intended reviewers.

### 7.3 Preview types

1. **File preview:** an appropriate inline view or download of a document, image, or other safe file type.
2. **Static website preview:** a self-contained HTML/CSS/JS build that can be examined through a protected preview URL and, where technically possible, opened from the exported folder.
3. **External deployment reference:** a link to an already running application, preview site, or environment. This is a convenience, not a self-contained artifact.
4. **Snapshot:** screenshots, a static export, or other retained evidence of an external deployment at a point in time.

Folio does not need to execute arbitrary server-side applications. External dynamic deployments remain the responsibility of their hosting systems.

### 7.4 Sharing and safety

A preview may be made available to selected account members or reviewers via explicit, limited access. A preview grant should cover only the intended artifact and version; it should be revocable and should not confer access to source emails, other folios, or unrelated folio files.

Active website previews can contain untrusted scripts. They must be isolated from authenticated Folio pages and their sessions. **TODO (before previews of untrusted or customer-supplied HTML are enabled):** serve previews from a separate registrable domain, not a subdomain of `engine9.ai`, so that cookies, storage and same-site requests cannot reach the authenticated application. Until that origin exists, static website preview is not offered and file previews are served only as downloads or sandboxed, script-free renderings. A static artifact may have external network dependencies; the product should disclose that such a preview is not entirely self-contained.

### 7.5 Review-to-work journey

From a preview, a reviewer should be able to open the associated feedback form or provide contextual commentary. Once triaged, that feedback can become a folio whose evidence links directly to the preserved version reviewed. The person addressing it can locate the original comment, the build in question, and any subsequent replacement build.

---

## 8. Sources, correspondence, and evidence

Sources provide the original context for work. The product should preserve originals, metadata, and provenance rather than relying solely on AI-generated interpretations.

### 8.1 Email

> **In version 1:** an email reaches a folio in three ways, all filed by the same rule (8.6): **forwarding** it to the folio's intake address (`<folio-id>@<intake domain>`; every folio, including one inside another, has its own), **dragging** it from a desktop mail client (Apple Mail, Outlook, Thunderbird give the browser an `.eml` or `.msg` file), or adding an `.eml` file by hand. The hosting service accepts a forwarded email only from a sender who may write to that folio. Not yet: thread matching for replies, and splitting a forwarded wrapper from the original it carries.
>
> Each email is stored once, as received, at `comms/<date>-<subject>-<hash>.eml`, with every other message (3.1.2) (unless it carries content 3.7 forbids or data-file attachments: then the folio keeps a text copy with its original headers, its readable text scrubbed, an `X-Folio-Copy` header and a list of where each attachment went; data attachments are summarised as in 8.4.1, other attachments go to `attachments/<email>/`, and the original is held temporarily) (Outlook `.msg` files keep their own format). The date is the email's own `Date`, the hash comes from its `Message-ID` (or its bytes), so a second delivery of the same message is recognised and not stored again. The header summary (from, to, subject, date, message id) is read from the file whenever it is needed, and recorded with the intake provenance in `history/intake/`.

Each folio may receive relevant support emails through an assigned intake address, forwarding rule, or explicit import. Inbound email should be retained as an original message, with useful metadata such as sender, recipients, date, subject, message identifier, thread identity, and attachments.

Replies and follow-ups should be associated with their existing thread when possible. If an incoming message cannot confidently be assigned to a folio, a human should route it rather than silently filing it under a guessed account. Duplicate delivery should not produce duplicate evidence.

The application may show an email in a readable form and suggest folios to create, but any summary, classification, or proposed folio remains distinct from the original message. Folio is an evidence and coordination record, not necessarily an outbound email client.

### 8.2 Slack

> **Deferred to version 2.** A folio may still record a Slack permalink as a reference.

Folio should optionally reference a Slack conversation or capture selected messages and threads. The context should include participants, dates, original permalink where available, and a clear indication of whether the folder contains a full captured thread or only a selected excerpt.

A single folio may be associated with a dedicated channel, several threads, or no Slack connection at all. Broad harvesting of unrelated channel history is not an assumed product behaviour.

### 8.3 GitHub

A folio may reference one or many GitHub repositories, listed as described in 3.2.1. References may point to branches, files, commits, pull requests, releases, or issues. The service should make these links easy to inspect and attach to folios and decisions.

Repository source code need not be copied into the folio. However, if a GitHub discussion or issue is material to the permanent record, a captured source item should be retained under `sources/github/` along with its live reference. This makes clear what survives an unavailable or renamed repository.

### 8.4 Uploaded and other evidence

People should be able to add documents, screenshots, meeting notes, exports, and customer-provided files. The product should distinguish original uploaded evidence from derived summaries or working copies, and retain enough metadata to explain when and how an item entered the folio.

### 8.4.1 Data files and logs

Exports, query results and logs usually hold other people's personal data and are far larger than anyone reads in a folio. Whatever brings one in (a drop, an upload, an email attachment, an agent), the library summarises it the same way:

- **Recognised by** extension, type or content: CSV, TSV, JSON that is a list of records, JSON Lines, `.log` (and `.txt` files that are plainly logs); spreadsheets, Parquet, Avro, database files and dumps, and compressed exports are recognised but not read.
- **The summary** is written to `sources/data/<date>-<name>-<hash>.json` (`"kind": "folio.data_summary"`): name, content type, size, SHA-256, submitted at, by and via, record or line count, and per field its inferred type, empty count and up to three example values; up to five sample rows; for logs the first and last timestamps, counts per level and redacted sample lines (first lines, first errors, last lines). Fields where `@engine9/pii-classifier` finds personal data are listed in `pii` and their examples masked; identifier fields are kept; free text is redacted span by span. Large files are counted over their bytes and sampled from the first megabyte, and the summary says so.
- **The original** is handed to the host's temporary storage (`hold`): R2 on the hosted service, a local folder for the CLI. The summary's `stored` says where and until when (`expires_at`). Without temporary storage only the summary is kept, and `stored.where` is `not_kept`. Temporary storage is not part of the folio, and an exported folio does not carry it.
- **Kept as an ordinary file** instead when it is at most 50 records and 64 KB and no personal data is found: a sample result belongs with the evidence. Its provenance record notes the format and counts.
- The same bytes added again are recognised by their hash and not summarised twice.

### 8.5 Source-linked reasoning

A folio, decision, status update, or feedback disposition may cite several sources. The UI should expose those citations with readable labels. Agents should be able to retrieve the underlying evidence to avoid repeating or amplifying an unsupported claim.

---

### 8.6 Adding items: one routing rule

Whatever adds something to a folio (a drag and drop in the browser, an upload, a forwarded email, the CLI, an agent) hands the item to the library's intake (`folio.add(item)`), and **the library decides where it belongs**. Interfaces never choose storage paths themselves, so a folio filled through any of them looks the same.

| Item | Recognised by | Goes to |
|---|---|---|
| Git repository | A GitHub, GitLab or Bitbucket URL (including links to an issue, pull request or file inside one), an `ssh://`/`git@` address, or a URL ending in `.git` | Listed in `folio.json` `repositories` (3.2.1). Already listed: reported, not duplicated. |
| Email | `.eml` / `message/rfc822`, Outlook `.msg`, or text that starts with an email header block | `comms/` (3.1.2, 8.1) |
| Other link | Any other URL (also `.webloc` and `.url` shortcut files) | `sources/links/<date>-<site>-<hash>.json`, holding the URL and who added it |
| Text | Dropped, pasted or typed text that is not a URL, an email or JSON | `notes/<date>-<title>.md`, `.html` or `.txt`: **Markdown, HTML or plain text by what it looks like** (below). The title is the first heading, an HTML `<title>`/`<h1>`, or the first line |
| An export from another tool | An Asana or Trello JSON export, or `{ "folios": [...] }`, dropped as a `.json` file or pasted | Folios inside this one (4.4.1) |
| Other JSON | Pasted JSON that is not an export | Filed as a dropped `.json` file would be: a list of records is data, anything else a file |
| Data file or log | CSV, TSV, JSON records, JSON Lines, logs, spreadsheets, dumps (8.4.1) | A summary in `sources/data/`, the original in temporary storage; small files with no personal data are filed as ordinary files |
| Refused | Key and credential files (`.env`, `.pem`, `id_rsa`, `.kdbx`, …) | Not stored (3.7) |
| Comment or update | Text added with `as: "comment"` / `"update"` (interfaces offer this first for short text) | A message in `comms/` (3.1.2) |
| File | Anything else | `attachments/` (8.4), keeping a dropped folder's structure; a name already in use gets a number ("report 2.pdf"). Text files have prohibited content (3.7) removed; images and other binary files keep their bytes |

Where it was dropped refines this:

- **On a folio inside a folio:** everything goes to that folio, by the same rule. Its emails are in its `comms/`, its files in its `attachments/`.
- **On a folder:** files go into that folder. Emails, repositories and links still go to their own places.

**Text formats.** Text is HTML when it is a document (`<!doctype html>`, `<html>`) or mostly markup (starts with a tag and has several); Markdown when it has two or more signs of it (a heading, code fence, table or task list counts double; links, emphasis, lists, quotes, inline code and rules count once; three or more bullets count too); otherwise plain text. Detection is a guess, so:

- **Before saving**, an interface shows what was detected and offers the other types. An item may carry `as` to choose: `markdown`, `html`, `text` (a note of that type, or a text file given that extension), `json`, `import`, `comment`, `update`, `file` (keep a dropped file as a file, never import it). `name` names a text note's file. `folio.choices(item, { folder })` returns the detected kind and type, where it would go, and the other choices.
- **After saving**, `folio.setTextFormat(path, format)` changes a `.md`, `.html` or `.txt` file to another of those types: the file is renamed, its content kept, and `links` in `folio.json` that point at it follow.

Text added in a folder becomes a file in that folder.

Inside a dropped folder, `.git`, `node_modules` and similar tooling folders are skipped. Text added as a note or comment, and folio titles, summaries and descriptions, have prohibited content (3.7) removed. A link to a release, pull request, issue, commit, branch or file of a repository is recorded in that repository's `references` (3.2.1).

Every stored item except a repository listing (which records `added_by` and `added_at` itself) gets a small provenance record in `history/intake/`: when, by whom, through which interface, its original name and type.

## 9. Decisions, notes, and durable context

A decision is more than a chat message saying that somebody has agreed. It is a deliberate record of an outcome, its rationale, and the evidence considered.

Each decision should capture a title, date, maker or approving group, the choice, rationale, alternatives when useful, consequences, related folios, and supporting sources. Decisions may be superseded or revisited without erasing the original record.

General notes may remain lightweight Markdown documents. `CONTEXT.md` should highlight the current picture without becoming an unstructured dumping ground for every discussion. Important facts should be traceable to folios, decisions, artifacts, or sources.

The system should surface contradictory or stale notes where known. The current context summary is a navigational aid, not an unquestionable authority over original evidence.

---

## 10. Humans, agents, and external connections

### 10.1 Human operation

The primary interface is a human-accessible workspace. People create folios, choose which work matters, review incoming feedback, assign work, share previews, and approve outcomes. External AI agents are supported because they work well with files and standard tools, not because Folio must provide its own conversational AI.

**There is no built-in chatbot, model selector, model-provider integration, or persistent chat product.** People may use Claude, ChatGPT, Cursor, Codex, or other compatible external tools independently.

### 10.2 MCP access to folios

Folio should expose a standard MCP interface through which an authorised external agent can discover accessible folios, read files, understand folios inside folios and their relationships, inspect evidence, and make permitted updates. Agent access must be scoped and revocable.

The expected capabilities include discovering folios, reading a folio overview, browsing files, searching content, listing ready folios, reading change histories, creating or editing folios, recording and updating tasks (5.8), linking evidence, reviewing feedback and listing artifacts. The interface should reflect the same truth as the human interface, with no separate agent-only work store.

Read access should be the default; write access should be explicitly approved. Connection to an agent is not proof of permission to access every folio.

### 10.3 Multiple upstream MCP connections

A folio may describe several named external MCP connections, such as customer documentation, a reporting system, a support platform, or a database. The folder contains intelligible non-secret aliases and purposes. The hosted service determines which actual connection each alias refers to for a particular account and user.

A connection of type `engine9` (or another execution platform) says where the folio's tasks run (5.8). Folio does not run tasks itself: an agent uses its own connection to the platform and records what it did in the folio.

Connections may be read-only, capable of limited changes, or require human confirmation. Exposing a connection through Folio should not silently grant a broad set of powerful tools to every agent that can read the folder. Outbound access is a separate permission decision from incoming agent access.

### 10.4 Repository connections

Multiple GitHub repositories should be supported for a single folio, possibly with different access levels. A repo association should remain meaningful when disconnected; only operations requiring live GitHub access should be unavailable until reauthorised.

### 10.5 Integration state

The interface should clearly distinguish **connected**, **unavailable**, **requires authorisation**, and **reference only**. Disconnection must not delete retained folio records. Exported folders must not include usable account secrets or tokens.

### 10.6 Untrusted content

Emails, form submissions, Slack messages, uploaded files, repository content, and responses from upstream tools are evidence, not privileged instructions. Folio must prevent these materials from taking on authority over access rules, approved actions, or `AGENTS.md` simply because an agent reads them.

---

## 11. Identity, folders, permissions, and sharing

### 11.1 Identity model

The identity ecosystem is **Delegate** for human authentication (reached through `@engine9/core`, which owns the session and roles), **Core** for people and membership infrastructure, and **Core Agent Credentials** for authorising external agents. These capabilities serve the product; they are not part of the portable folio format.

A folio is always hosted inside a top-level folder, which is what a host calls an account: there is no separate account object (3.1.1). The directory must never contain live permission grants as its authority. **In this version a folder holds no permission information at all**: access grants, restricted folders and agent grants live only in the hosting service (`folio-server`'s D1 control plane). Copying or exporting a folder or folio carries none of them.

### 11.2 Roles and access

Access is granted to a person on a **folder path**: a top-level folder, a folder inside it, a folio, or a folio inside a folio. It reaches everything inside that folder.

- **Levels:** none < read < write < manage. Read opens; write edits folio content; manage also shares the folder and creates folders and folios in it.
- **The nearest grant wins.** A grant on a folio overrides one on its folder, in either direction; a grant of `none` keeps out someone the folders above would let in.
- **A restricted folder stops inheritance**: access granted above it does not reach it or anything inside it. Only people granted on it (or deeper) get in. Restricting something keeps the person restricting it in.
- **Membership of an organisation** is access on its top-level folder: managers (manage) and members (write) there reach everything in it unless something is restricted.
- **Platform administrators** create top-level folders and decide who has access to them, without content access from that role.

Suggested role capabilities:

| Role | Typical access |
|---|---|
| Folder manager (manage on a top-level folder: an organisation's administrator) | Manage who has access to the folder and everything in it, create folders and folios, and eligible connections. |
| Folio manager | Manage the folio, the folios inside it, forms, artifacts, invitations, and contributors. |
| Contributor | Read and update authorised folio content. |
| Viewer | Read selected folio content and artifacts without altering them. |
| Reviewer | Access selected preview/form resources and provide feedback, without general folio access. |
| Connected agent | Carry out only approved operations for the authorising person and accessible folios. |

Roles are examples of user-facing capabilities, not instructions to add a second independent identity system. Organisations may refine them, but permissions should be predictable, explainable (the hosting service shows, for each person, the folder their access comes from), and tested at folder and folio boundaries.

### 11.3 Folder and folio restrictions

A member of a top-level folder may have no access to a particular folder or folio, read-only access, or editing access, by a grant on that folder or folio. Broad access higher up does not override an explicit grant or a restriction lower down. Sensitive folders and folios support narrower participant lists by being restricted.

Review links, form invitations, and preview access do not by themselves permit access to correspondence, source files, other artifacts, or other accounts.

### 11.4 Sharing and revocation

A folio manager should be able to share selected content, request feedback, revoke invitations, and inspect relevant access history. Revocation should apply to subsequent hosted access. Already-exported copies or downloaded files cannot be technically revoked; the product must make that limitation clear.

Moving or importing a folder requires new authorisation where it lands. Host-specific permission state should not be copied along as a portable grant.

### 11.5 Privacy and retention

Sources and feedback may contain personal or confidential information. Folder managers need understandable retention, archive, removal, and export policies. Removing access should not be confused with deleting evidence. Permanent deletion may conflict with recordkeeping obligations and should be a deliberate action.

The product should avoid broadly sharing full source evidence when a narrow summary, artifact, or response is sufficient for a reviewer.

---

## 12. Storage and authority boundaries

The hosted environment is Cloudflare, using R2 to hold folio folders and D1 only to enable secure access and the Cloudflare/MCP service features. There is a single production deployment at **`folio.engine9.ai`**; there is no staging environment.

### 12.1 What belongs in folio files

All substantive content must be inside the folio folder, including:

- Folio title, summary, lifecycle state, tags, and portable references.
- Folios inside folios, relationships, comments, change histories, and execution evidence.
- Decisions and rationale.
- Feedback form definitions, submitted answers, and relevant attachments.
- Artifacts, preserved versions, and descriptive metadata.
- Emails, captured Slack/GitHub evidence, documents, and working notes.
- Portable activity and change records necessary to understand what happened.
- Optional local indexes that can be discarded and regenerated without losing meaning.

### 12.2 What the hosted control plane may own

D1 and related hosted identity or credential facilities may hold only information required to **find, protect, and connect** folders, including which folders are folios (an id → path index that can be rebuilt from each `folio.json`), access grants on folder paths, restricted folders, invitation status, agent OAuth grants, and integration credential references.

It should not be the authoritative store for folio fields, relationships, feedback responses, artifact descriptions, decisions, documents, or email bodies. Nor should the product require a content database to reconstruct a valid folio.

Other systems may hold necessary platform security records. Those records do not become the authority for the business content inside a folio.

### 12.3 Search and presentation

Search, boards, filtered lists, summary pages, and activity feeds are conveniences derived from folder content. They should remain accurate if rebuilt from the folio files and must not silently diverge into a second competing record. An index stored inside a folio is optional and disposable.

### 12.4 Editing integrity

Several humans or agents may attempt to update a folio at once. Folio must avoid silent overwrites, give the user a clear conflict outcome, and preserve an attributable history of committed changes. A platform-managed edit should not claim success when only some of its substantive files have changed.

A person editing exported files directly may bypass hosted change tracking. Folio must accept that portability trade-off while distinguishing verified hosted activity from unattributed changes detected upon import or synchronisation.

### 12.5 Filesystem independence

The product should work conceptually whether the folio folder is backed by R2, another object store, or a local filesystem. The hosted service provides controlled access; it does not turn the folder into an inseparable proprietary object.

---

## 13. Human experience and navigation

The interface should be approachable to an account manager while remaining useful to an engineer. It should not require understanding object storage, MCP, or JSON to perform normal work.

### 13.1 Top-level navigation

Recommended labels are **Folders**, **Folios**, and **Connections**. Within a folio, the main sections are **Overview**, **Folios** (board and list), **Feedback**, **Artifacts**, **Files**, **Sources**, and **Decisions**. Some smaller sections can be grouped as needed, but the terminology should stay consistent.

### 13.1.1 Folder board

A folder opens as a **board**, like a project's task board: every folio inside it (at any depth) is a card in the column of its status (4.3). A card shows the title, summary, where it sits below the folder, tags, target date and owner (all from `folio.json`). Dragging a card to another column changes the folio's status in its `folio.json`; dropping files on a card adds them to that folio; each column can add a new folio with that status. Icons and list views remain available, and archived folios are shown on request.

### 13.2 Folio overview

A folio opens as itself, like a case in a help desk or a task in Asana, not as a folder. Its main view shows, on one page:

- Title, state (with the reason when it is blocked, waiting or a draft) and Mark Done.
- Description and files (attachments and notes).
- The whole conversation from `comms/` (emails, comments, updates, agents' reports) in time order, with a composer that takes text and files.
- A side column: the folios inside it (sub-folios), with a one-line add; details: status, type, owner, target date, tags, what it waits on, **CC** in its two lists, **Team** and **Client** (people and channels, each showing whether this deployment delivers to it, and movable between the lists), its email address, repositories, **tasks** (each with its state, environment and whether it is overdue; 5.8), recent changes and sharing.

Everything is edited in place, and anything dropped on the page is added to the folio. Folios inside a folio are secondary: they show within it, not alongside it in lists of folios or on its folder's board (its card counts them). For a small folio this page should feel simple rather than empty; for a larger one it should offer a concise route to the detail without becoming a dashboard requiring constant maintenance.

### 13.3 Work inside a folio

The folios inside a folio can also be shown on their own (and a folder's folios are shown) as a **board** (13.1.1) or a **list** with Name, Type, Status, State (readiness), Owner and Modified columns, sortable and filterable by tag, plus a Ready view. Opening one shows its own page or a Quick Look panel: status, type, owner, tags, blockers, conversation and files together, with drop and quick add.

### 13.4 Feedback workspace

People can create or edit draft forms, publish them, review responses, and triage submissions. The UI should make it obvious which preview or artifact version a response concerns and whether a folio has been created for it.

### 13.5 Artifact workspace

Artifacts should offer a library view, revision history, preview/share actions, and related folios. Users should be able to see exactly which version a customer reviewed and what has been delivered since.

### 13.6 File view

A file explorer is essential, not merely an administrative escape hatch. People should be able to view the actual folder tree and inspect ordinary Markdown, JSON, and common media files. The product must never conceal essential content behind a UI-only object whose representation is missing from the folder.

### 13.7 Connected agents and integrations

People should be able to see which external agents can access their content, the broad extent of their permissions, and how to revoke access. Connection settings should explain whether a reference is portable, whether a live service is attached, and whether an action requires approval.

---

## 14. Representative workflows

### 14.1 An afternoon support request

An account manager creates a folio called “Broken donation form.” They attach a forwarded support email, mark it an urgent bug, and link the relevant GitHub repository. An engineer investigates through their preferred tools, fixes the problem, attaches the result, and posts a resolution update. The folio is marked completed that afternoon. Its contents remain understandable if copied to a local folder six months later.

### 14.2 A multi-month website refresh

The team creates a folio for the refresh with folios inside it for design, content, and launch readiness. Preview builds are published as artifacts. Reviewers receive links to a preserved preview version and a feedback form. Responses are triaged into folios, blockers are tracked, decisions are recorded, and approved versions remain identifiable. The final folio becomes a durable record of what was requested, reviewed, and delivered.

### 14.3 Work involving several systems

One folio references two GitHub repositories, a read-only support-data MCP connection, and a documentation MCP connection. A person authorises an external agent to inspect the folio and assist with a piece of work. The agent can read the stored evidence and call only approved external tools. It may update folios if granted write access. The folio continues to make sense when those external systems are no longer connected.

### 14.4 Customer feedback becomes accountable work

A customer reviews a new website preview and submits a form noting a mobile layout problem. The submission is retained with its form revision and target artifact version. A human creates a folio from the response inside the design folio, marks it `discovered_from` that work, and assigns it. The fix is demonstrated in a newer artifact version, and the folio can show the entire path from report to resolution.

### 14.5 Importing a folio elsewhere

A completed folio is exported and later imported into another authorised folder or storage environment. Folios inside it, relationships, notes, decisions, feedback, and artifacts remain intact. The receiving administrator grants new access and reconnects any necessary external services. No old access credential is silently transferred.

---

## 15. Experience and quality requirements

These are product expectations, independent of a particular delivery mechanism.

**Clarity.** A nontechnical person should be able to create a folio, read status, request feedback, and review an artifact without learning infrastructure terms.

**Small-work friendliness.** A folio should not require milestones, epics, estimates, sprints, or formal workflows merely to track one issue.

**Scalable organisation.** A folio containing hundreds of folios inside it should still permit filtering, dependency navigation, source tracing, and quick discovery of what is ready or blocked.

**Portability.** A folder can be opened offline, and its substantive content retains its meaning without the Folio service. Missing external integrations are disclosed rather than treated as missing folio data.

**Interoperability.** A capable third-party MCP client can access authorised folios without a built-in model provider, a special chat session, or an agent-specific copy of work state.

**Auditability.** Significant business changes are attributable where known. Unverified direct file edits are not falsely represented as securely audited application actions.

**Safety.** Customers cannot see other accounts' folios by guessing paths or links. Review access is narrower than member access. Untrusted previews and source content do not gain privileged authority.

**Resilience.** Loss of an index, cached view, or hosted integration should not destroy the underlying folio record.

**Accessibility.** Forms, board and list navigation, and previews should use readable labels, keyboard-accessible controls, and accessible interaction patterns. Artifact content itself may require additional accessibility work and should not be falsely certified by the platform.

---

## 16. Product acceptance scenarios

The product should be considered faithful to this specification when the following statements are true:

1. A folio can be created as an ordinary folder with `folio.json` and `README.md` and subsequently recognised by the product.
2. A folio can be exported, opened offline, and understood without access to D1, R2, Delegate, Core, GitHub, Slack, or an MCP server.
3. Folio titles, statuses, the folios inside them, decisions, feedback, artifacts, comments, and substantive history all originate from the folio files rather than a hidden content database.
4. Two different account members can work on the same folio without silently overwriting each other's updates.
5. A folio can hold folios, have blockers, related folios, and discovery history, and its readiness is explained in ordinary language.
6. Hundreds of fine-grained execution steps can be associated with one customer-facing folio without producing hundreds of visible folios.
7. An email or feedback response can become a folio with a traceable link to its retained original evidence.
8. A published feedback response remains associated with the form definition that the respondent answered.
9. Feedback on a preview can identify an immutable artifact version, and reviewers do not need access to unrelated folio contents.
10. Multiple git repositories (GitHub or otherwise) and multiple named MCP connections can be listed in one folio without any live connection, and missing live connections are clearly shown after export/import.
11. An external agent can read and, when explicitly permitted, update the same folio content that humans use, without native Folio chat.
12. Account-level and folio-level permissions are respected, and revoking a hosted permission removes subsequent hosted access.
13. No usable credentials or hosting-specific permission grants are required inside a portable folio.
14. A simple folio remains simple, while a larger one supports hierarchy, evidence, review, and durable decisions.
15. The application consistently uses **folder**, **folio**, **feedback**, and **artifact** as its principal terms.

---

## 17. Deliberate boundaries and open product choices

The following choices are intentionally left flexible, provided the foundational promises are preserved:

- **How elaborate workflows become.** Additional states and custom fields may be valuable, but they should not complicate the default experience or undermine portable records.
- **How much execution history is shown.** Technical actions may be summarised by default, with detailed records available for audit and diagnosis.
- **How collaboration is expressed.** Comments, mentions, notifications, and review requests may be added without turning Folio into another chat service.
- **How much of an external source is captured.** A live link may suffice for transient context, while consequential evidence needs a retained snapshot or original.
- **Which artifact types receive in-browser previews.** Raw files always remain available; safe rendering is a separate capability.
- **What search experience is offered.** Search can improve considerably without becoming authoritative storage.
- **Whether folios later support templates or reusable practices.** Templates should produce ordinary folio folders, not introduce invisible state or mandatory infrastructure.
- **Whether tasks become folios.** Each task has its own folder in `tasks/` (5.8) so it could later gain a conversation, sharing or folios of its own without moving.
- **Whether folios later incorporate checklists.** Checklists, if introduced, should remain a lower-level concept subordinate to the folio's outcome.

These are areas for product evolution, not reasons to weaken the core folder model.

---

## 18. Governing principle

> **The folder is the product record. Everything else is a way to understand, secure, share, or work with that folder.**

A successful folio stands on its own. The hosted application provides a pleasant human workspace and a reliable bridge to agents and external systems, but the work, evidence, feedback, decisions, and deliverables belong to the folio itself.

---

## 19. Version 1 scope and deferred work

### In version 1

- The portable folio format and the `@engine9/folio` library (validation, folios inside folios, relationships, readiness, change history, repository listing, import checks, search), with examples.
- Hosting at `folio.engine9.ai` on Cloudflare: a folder tree in R2 (top-level folders, folders, folios, folios in folios), a D1 control plane for the folio index and access on folders.
- Sign-in through Delegate via `@engine9/core`; permissions on any folder, subfolder or folio, inherited downwards; conflict-safe editing.
- An MCP endpoint over the same folio content, with scoped, revocable agent access.
- A browser workspace laid out like a Finder window: folio list, the folio's folder, the folios inside it as a board or list (with readiness, type and tags), Quick Look, repositories, files, sharing.
- Drag and drop, paste and upload into a folio, filed by the library's routing rule (8.6): text saved as Markdown, HTML or plain text by detection, with the type chosen before or changed after; Asana, Trello and Folio-list exports imported as folios (4.4.1).
- Email forwarding to a folio's intake address (8.1).
- Tasks (5.8): engine9-style task records in `tasks/`, kept by agents over MCP (`add_task`, `update_task`, `list_tasks`, `get_task`) and the library, shown on the folio's page.

### Deferred, and what will be needed

| Item | Status | What it needs |
|---|---|---|
| Email forwarding (8.1) | Built; needs switching on | Cloudflare Email Routing on the intake domain with a catch-all rule sending to the `folio` Worker. **The owner sets this up in the Cloudflare dashboard.** Thread matching for replies and Queues for heavy processing come later. |
| Slack capture (8.2) | Version 2 | A Slack app and workspace authorisation. |
| CC delivery (5.7) | Optional add-on per deployment | The CC list, its UI and crediting of replies are built. Sending to email, Slack or SMS is a separate add-on each deployment configures (folio-server's DEPLOY.md, "CC delivery"). |
| Automated GitHub retrieval | Not planned for v1 | Repository listing (3.2.1) is complete without it. |
| Static website previews (7.3) | Blocked on a TODO | A separate registrable preview domain (see 7.4). |
| Feedback forms, artifacts and decisions in the browser UI | After v1 core | The formats are specified and have examples; the interface follows. |
| Publishing `@engine9/folio` to npm | After testing | Until then, depend on the GitHub repository. |
| Reading spreadsheets, Parquet and compressed exports (8.4.1) | Held and summarised by name only | A parser that runs in Workers within memory limits. |
| Text copies of `.msg` emails (3.7) | `.msg` files are stored unread | An Outlook message parser. |
