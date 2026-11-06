# Folio
## Product and functional specification

> **Status.** This is the working specification as finalised in the 2 November 2026 product conversation. It supersedes the earlier draft. It remains a living document: where a decision here conflicts with an earlier idea, this document wins. Scope for the first release is in [section 19](#19-version-1-scope-and-deferred-work).
>
> **Changes on 6 November 2026:** tickets carry **tags** (5.1; the older `labels` field still reads); adding anything to a folio goes through one routing rule owned by the library (8.6), used by drag and drop, uploads, the CLI and email forwarding; email forwarding to a folio's address is in version 1 (8.1); permissions live only in the hosting service (11.1).
>
> **Changes from the draft:** git repository listing is a core part of the folio model (3.2.1); Slack capture is out of version 1; the preview-isolation requirement is kept but its implementation is a tracked TODO; hosting is a single production environment at `folio.engine9.ai`.

**Purpose:** A shared, human-operated workspace for bounded pieces of work, customer communication, tickets, feedback, evidence, and deliverables. Folios are understandable and usable by people and by external AI agents.

**Foundational definition:** **A folio is a folder.** Its files are the complete, portable record of the work. The Folio application organises, protects, presents, and updates those files; it does not define their existence.

---

## 1. Product vision

Teams supporting multiple accounts need somewhere to hold the complete context for a piece of work. That work may be a brief support request finished in an afternoon, a website review lasting two weeks, or an ongoing engagement spanning several months. The same workspace should accommodate all three without requiring the account to adopt a heavyweight project-management system.

A folio brings together a description of the work, customer-facing tickets, relevant correspondence, decisions, files, feedback, deliverables, previews, and references to external tools. People should be able to understand what is happening at a glance, and an authorised agent should be able to examine and update precisely the same record.

A folio is not a chat transcript, a database row, an AI-agent session, or a GitHub repository. Those things may interact with a folio, but none should be necessary to understand it.

### 1.1 Product promises

1. **Portable by design.** Copy a folio folder and its meaningful history comes with it. Its ordinary files can be opened and edited without the Folio service.
2. **Human-led.** Humans own objectives, decisions, priority, approvals, and customer relationships. AI tools assist through well-defined access rather than operating an independent project system.
3. **Tickets first.** Tickets are the primary customer-facing units of work. Fine-grained execution steps may be numerous but need not become tickets.
4. **Evidence before inference.** Important claims, feedback, decisions, and status changes can be traced to their original source.
5. **Integration without lock-in.** A folio may connect to many GitHub repositories and MCP services; unavailable integrations do not make its stored content unreadable.
6. **One record, many interfaces.** The browser, file tools, and MCP clients see the same folio content and follow the same access rules.
7. **Appropriate scale.** The system should be as comfortable with one ticket and three files as with hundreds of tickets and months of correspondence.

### 1.2 Intended users

- **Account managers and support staff** collect requests, communicate status, gather feedback, and coordinate work.
- **Engineers and designers** investigate tickets, work across repositories, publish artifacts, and request review.
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
| **Ticket** | An issue, request, desired outcome, or customer-facing commitment within a folio. |
| **Ticket relationship** | A connection between tickets, such as parent, blocks, related, or discovered from. |
| **Execution record** | Optional fine-grained steps, actions, or agent runs undertaken to advance a ticket; not a ticket itself. |
| **Source** | Original evidence, such as an email, a Slack discussion, a submitted form, a captured GitHub item, or a document. |
| **Feedback form** | A defined set of questions used to solicit responses about a folio or a particular artifact. |
| **Feedback response** | A preserved answer to a published form. |
| **Artifact** | A deliverable or reviewable output, including documents, images, exports, or static website previews. |
| **Decision** | A consequential choice and the rationale and evidence behind it. |
| **Connection** | An association with a repository, MCP server, Slack context, or other external service. |
| **Preview** | A safe, viewable representation of an artifact or an explicitly linked external deployment. |

The normal hierarchy is:

**Accounts → Folios → Tickets / Feedback / Artifacts / Files / Decisions / Sources**

Tickets may have parent-child relationships, but they are still tickets within a folio. A folio need not contain tickets if it is being used to collect materials or share a deliverable.

### 2.1 Folio identity

Each folio has a stable identifier, a human-readable title, and optionally a convenient folder name. Its identifier stays the same when the folder is renamed or moved. The folder name is not a permission boundary or a permanent identifier.

A folio belongs to an account *for purposes of hosted access*. That account relationship is not intrinsic to its portable contents. Importing the folder elsewhere should require an explicit new hosting and access decision.

### 2.2 Human-readable language

Prefer labels such as **Open Folio**, **New Ticket**, **Waiting on Feedback**, **Preview**, **Decision**, **Related Files**, and **Ready to Work**. Avoid developer-only language in the ordinary customer experience. In particular, "ticket" is not interchangeable with an internal action, command, or agent execution step.

---

## 3. The folio as a portable folder

The folio folder is the authority for everything describing the work: identity, title, summary, tickets, status, decisions, feedback, correspondence, and artifacts. A service may cache or display these facts, but it cannot replace the files as the source of truth.

### 3.1 Illustrative directory structure

```text
folios/
  customer-portal/
    folio.json
    README.md
    AGENTS.md
    CONTEXT.md

    tickets/
      TK-001/
        ticket.json
        description.md
        events/
        attachments/
      TK-002/
        ticket.json

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

    sources/
      email/
      links/
      slack/
      github/
      uploads/

    notes/
    integrations/
      references.json
    history/
      intake/
    indexes/
```

The outer `folios/` folder is a collection of folio folders. The portable unit is **`customer-portal/` itself**, including all of its descendants. When stored in R2 it may be located under an account-specific prefix, but that hosting prefix is not part of the folio's own identity or contents.

The directory layout is a convention rather than a rigid empty scaffold. Only `folio.json` and `README.md` are required for a minimal folio. All optional directories can be absent until used. A folio created manually with those two files should be recognisable without a platform-generated database record.

### 3.2 `folio.json`

`folio.json` is the machine-readable manifest at the folder root. It provides durable information such as:

- Stable folio ID and a title.
- Concise summary, purpose, and desired outcome.
- Lifecycle status.
- Creation and last meaningful update timestamps.
- Optional folio-level tags, categories, and key dates (for finding folios; tickets carry their own tags, 5.1).
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

Rules:

1. Listing is by reference only. Source code is not copied into the folio (see 8.3).
2. A folio may list any number of repositories, with different roles.
3. Duplicates (same provider and repository, ignoring case) are flagged.
4. Tickets and decisions may cite a specific branch, file, commit, pull request, release or issue within a listed repository; the cited repository should be listed.
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

---

## 4. Folio lifecycle and organisation

### 4.1 Create

A person should be able to create a folio by providing only a title and choosing an account. Description, dates, repositories, collaborators, and integrations are optional. The system establishes the portable folder and provides a readable starting point.

A folio can also be introduced by importing an existing folder, including one composed outside the Folio application. The product must recognise valid content rather than insisting that it originated in the application.

### 4.2 Discover and navigate

People working with many accounts need to find folios by account, title, status, owner, tags, recent activity, relevant ticket, and available context. Lists and search results are *views of folio content*, not independent records that must be maintained manually.

A folio overview should answer: **What is this? What is outstanding? What changed? What needs my attention? Where is the latest deliverable?**

### 4.3 Status and completion

Suggested folio statuses are `draft`, `active`, `waiting`, `completed`, and `archived`.

- **Draft:** being assembled; not yet active work.
- **Active:** work is proceeding or open for review.
- **Waiting:** progress depends principally on an external response or decision.
- **Completed:** the agreed outcome is delivered; records remain accessible.
- **Archived:** retained for history and reference, with conspicuous read-only defaults.

A folio can be reopened. Closing or archiving a folio must not discard ticket histories, feedback, or artifacts. Moving it between accounts is an intentional administrative action involving a fresh permission assessment.

### 4.4 Duplicate, move, export, and import

Users should be able to duplicate a folio as a starting point, export it, restore it, or move it. The interface must distinguish **copying the same record** from **creating a new folio based on an existing one**. A copied record retains its identity and history; a new folio created from a template gets a new identity and may omit customer-specific evidence.

Import should flag broken internal references, conflicting folio identities, unavailable external connections, suspicious attachments, and missing original evidence. It should not fabricate missing source material or silently apply permissions embedded in the folder.

---

## 5. Tickets: the principal unit of work

Tickets represent meaningful requests or outcomes that account stakeholders can understand. They may concern defects, requests, investigations, reviews, decisions, improvements, or support. A ticket is typically larger than the individual actions used to complete it.

### 5.1 Ticket content

Every ticket should have:

- Stable identifier, title, and description.
- Type, status, priority, and creation/update dates.
- Current responsible person or team, when known.
- A clear requested outcome or resolution criterion.
- Optional target date, **tags**, and participants. Tags are free-form words stored on the ticket (`"tags": ["payments", "safari"]` in `ticket.json`), used to group and filter tickets. Priority is a separate field, not a tag. Older files may use `labels`; readers treat it as `tags`, and the next edit through the library writes `tags`.
- Links to evidence, decisions, other tickets, and artifact versions.
- Portable comments and a change history.

A ticket's authoritative current information belongs in a file such as `tickets/TK-001/ticket.json`. Longer explanatory material may live in `description.md`; attachments and history belong beside the ticket. The folder structure is not dictated by how the ticket happens to appear in a UI.

### 5.2 Suggested ticket types and states

| Property | Recommended vocabulary | Meaning |
|---|---|---|
| Type | `support`, `bug`, `request`, `feature`, `review`, `investigation`, `epic` | Why the ticket exists. |
| Status | `open`, `in_progress`, `blocked`, `resolved`, `closed`, `cancelled` | The ticket's current lifecycle state. |
| Priority | `urgent`, `high`, `normal`, `low` | Human-facing urgency, distinct from sequence or effort. |
| Resolution | `completed`, `duplicate`, `declined`, `cannot_reproduce`, `superseded`, or custom | Why a closed ticket ended. |

Priority and status should not be inferred purely from a message's emotional tone. A human may revise them, and changes should be attributable. A ticket may be `blocked` because of a declared dependency or an explicit manual hold; the two reasons should remain distinguishable.

### 5.3 Ticket hierarchy and relationships

Folio adopts the useful concepts of dependency-aware ticket systems such as Beads, without requiring their internal storage or multi-agent orchestration model.

Supported relationships:

| Relationship | Example | Behaviour |
|---|---|---|
| **Parent / child** | “Improve sign-in” contains “Fix mobile redirect” | Organises related outcomes; parent completion is governed by an explicit policy. |
| **Blocks / blocked by** | “Confirm identity behaviour” blocks “Ship updated flow” | A blocking unresolved ticket prevents the dependent ticket being marked ready. |
| **Related** | Two different symptoms share a likely cause | Navigation and context only. |
| **Discovered from** | A mobile defect was found while investigating desktop login | Preserves provenance; does not imply dependency. |
| **Duplicate of / supersedes** | Two customer reports describe the same issue | Preserves both records and their history while identifying the canonical work. |

Relationships must be visible in both directions, understandable without the interface, and protected against invalid self-references or cycles where those would make the meaning incoherent. Hierarchy does not automatically imply a blocking relationship.

A small folio may have one flat ticket. A more substantial folio can have an epic with child tickets and cross-cutting blockers. The product must not demand hierarchy where none is useful.

### 5.4 Ready-to-work view

The **Ready** view answers: *Which open tickets could someone usefully start now?*

A ticket is ready when it is open, is not explicitly deferred or held, and has no unresolved blocking dependencies. The view should distinguish ready, already in progress, awaiting input, and blocked. Readiness is calculated from the ticket files and relationships, not an additional authoritative status table.

Ticket lists should offer useful views such as All, Mine, Ready, Blocked, Waiting for Review, Recently Updated, and Closed. Filters might include account, owner, type, priority, label, or related source.

### 5.5 Execution details are subordinate to tickets

An individual ticket might require hundreds of low-level actions: examining logs, inspecting database records, editing files, running checks, generating assets, or asking agents to investigate alternatives. Those actions should not flood the customer-facing ticket list.

The folio may retain optional **execution records**, checklists, agent-run summaries, or activity traces under a ticket. These records may include actor, time, purpose, result, files changed, and references to external logs. They are useful for accountability and continuity, but they are not first-class tickets and do not require a separate task-management model.

A human should be able to see a concise ticket timeline while expanding technical execution history only when relevant.

### 5.6 Ticket interactions

A user should be able to create a ticket from an email, feedback response, source document, artifact annotation, or a discovery made during another ticket. Users may update it, comment, assign responsibility, connect supporting sources, add dependencies, and mark a resolution.

Closing a ticket should invite a useful resolution note: **what changed, what was delivered, how it was verified, and what remains open**. Reopening preserves the original record rather than creating a disconnected replacement.

### 5.7 Ticket history

The folio should retain an understandable history of significant changes: creation, status transitions, ownership changes, comments, links, decisions, and resolution. Histories are substantive content and therefore belong inside the folder. An event may identify a person, an authorised agent, or an external origin.

Direct editing of portable files is legitimate. The application should flag unrecognised changes when it cannot attest how they occurred, rather than claiming that its audit history covers edits made outside its control. This distinction must be explicit wherever histories are presented as evidence.

---

## 6. Customer feedback and forms

Feedback is both an incoming communication channel and a record of review. It should be possible to ask a group of people specific questions, collect responses, and associate those responses with the work being discussed.

### 6.1 Form creation

Authorised people may create a form attached to a folio. A form may optionally target a particular ticket, artifact, or immutable preview version.

The form experience should support a title, description, instructions, optional deadline, confirmation message, and common field types: short text, long text, single choice, multiple choice, rating, yes/no, date, and attachments. Fields may be required or optional. Order and explanatory text should be editable before publication.

The product need not become a general survey builder. Form capabilities should favour clarity, speed, and direct connection to work.

### 6.2 Publishing and versions

A form can be drafted, published, closed, and reopened. Each submitted response remains tied to the exact published form definition the reviewer saw. Editing an already published form may create a new definition revision; it must not reinterpret historical answers.

The form definition and responses belong in the folio's `feedback/` folder. Sharing invitations and their revocation state are access controls, not portable business records.

### 6.3 Respondent experience

A reviewer with appropriate access should receive a simple form with context, clear questions, and an optional link to the artifact or ticket under discussion. Reviewers should not need general access to the entire folio simply to submit feedback.

The product should allow authenticated participants and time-limited invitation links. Anonymous public collection is not the default. Each submission should preserve when it was received, which form revision was answered, and any identity information the reviewer voluntarily or authoritatively provided. Avoid requesting personal data unnecessarily.

### 6.4 Triage and follow-through

Submitted feedback enters a review queue where an authorised person can:

- Acknowledge and categorise the response.
- Link it to an existing ticket.
- Create a ticket from the response.
- Mark it informational, duplicate, accepted, deferred, or declined.
- Attach a note explaining the disposition.
- Associate it with a particular artifact version or page/element when relevant.

A response is evidence, not an instruction to modify the product automatically. Triage may create separate annotations or tickets; the original response remains unchanged.

### 6.5 Feedback on a preview

A reviewer might say, “The primary button overlaps the form on mobile.” The response should identify the specific preview version and, when available, the page URL, viewport or device context, and a screenshot or annotated location. Comments must remain understandable if the preview URL later expires.

---

## 7. Artifacts and previews

Artifacts are the things produced, reviewed, or delivered through a folio. They may be finished outputs or intermediate review builds.

Examples include a PDF, an image collection, a research memo, a CSV export, an HTML prototype, a static website build, or a link to an externally hosted staging environment.

### 7.1 Artifact collection

Each artifact should have a stable identity, a name, purpose, type, owner or publisher when known, creation date, optional description, and links to relevant tickets and decisions. Its files and non-secret descriptive information belong inside `artifacts/`.

Artifacts should be discoverable by name, type, last update, associated ticket, and whether review is requested. Account stakeholders may see a curated artifact view rather than the complete filesystem.

### 7.2 Immutable review versions

When an artifact is published for review, that published state should be preserved. Reviewers and tickets can then cite an exact version. New uploads may produce subsequent versions without rewriting what someone previously approved or commented on.

An artifact can carry a review state such as `draft`, `ready_for_review`, `changes_requested`, `approved`, or `superseded`. The approval is meaningful only with respect to a particular artifact version and its intended reviewers.

### 7.3 Preview types

1. **File preview:** an appropriate inline view or download of a document, image, or other safe file type.
2. **Static website preview:** a self-contained HTML/CSS/JS build that can be examined through a protected preview URL and, where technically possible, opened from the exported folder.
3. **External deployment reference:** a link to an already running application, preview site, or environment. This is a convenience, not a self-contained artifact.
4. **Snapshot:** screenshots, a static export, or other retained evidence of an external deployment at a point in time.

Folio does not need to execute arbitrary server-side applications. External dynamic deployments remain the responsibility of their hosting systems.

### 7.4 Sharing and safety

A preview may be made available to selected account members or reviewers via explicit, limited access. A preview grant should cover only the intended artifact and version; it should be revocable and should not confer access to source emails, tickets, or unrelated folio files.

Active website previews can contain untrusted scripts. They must be isolated from authenticated Folio pages and their sessions. **TODO (before previews of untrusted or customer-supplied HTML are enabled):** serve previews from a separate registrable domain, not a subdomain of `engine9.ai`, so that cookies, storage and same-site requests cannot reach the authenticated application. Until that origin exists, static website preview is not offered and file previews are served only as downloads or sandboxed, script-free renderings. A static artifact may have external network dependencies; the product should disclose that such a preview is not entirely self-contained.

### 7.5 Review-to-ticket journey

From a preview, a reviewer should be able to open the associated feedback form or provide contextual commentary. Once triaged, that feedback can become a ticket whose evidence links directly to the preserved version reviewed. The person addressing the ticket can locate the original comment, the build in question, and any subsequent replacement build.

---

## 8. Sources, correspondence, and evidence

Sources provide the original context for work. The product should preserve originals, metadata, and provenance rather than relying solely on AI-generated interpretations.

### 8.1 Email

> **In version 1:** an email reaches a folio in three ways, all filed by the same rule (8.6): **forwarding** it to the folio's intake address (`<folio-id>@<intake domain>`, or `<folio-id>+TK-001@…` to attach it to a ticket), **dragging** it from a desktop mail client (Apple Mail, Outlook, Thunderbird give the browser an `.eml` or `.msg` file), or adding an `.eml` file by hand. The hosting service accepts a forwarded email only from a sender who may write to that folio. Not yet: thread matching for replies, and splitting a forwarded wrapper from the original it carries.
>
> Each email is stored once, as received, at `sources/email/<date>-<subject>-<hash>.eml` (Outlook `.msg` files keep their own format). The date is the email's own `Date`, the hash comes from its `Message-ID` (or its bytes), so a second delivery of the same message is recognised and not stored again. The header summary (from, to, subject, date, message id) is read from the file whenever it is needed, and recorded with the intake provenance in `history/intake/`.

Each folio may receive relevant support emails through an assigned intake address, forwarding rule, or explicit import. Inbound email should be retained as an original message, with useful metadata such as sender, recipients, date, subject, message identifier, thread identity, and attachments.

Replies and follow-ups should be associated with their existing thread when possible. If an incoming message cannot confidently be assigned to a folio, a human should route it rather than silently filing it under a guessed account. Duplicate delivery should not produce duplicate evidence.

The application may show an email in a readable form and identify candidate tickets, but any summary, classification, or proposed ticket remains distinct from the original message. Folio is an evidence and coordination record, not necessarily an outbound email client.

### 8.2 Slack

> **Deferred to version 2.** A folio may still record a Slack permalink as a reference.

Folio should optionally reference a Slack conversation or capture selected messages and threads. The context should include participants, dates, original permalink where available, and a clear indication of whether the folder contains a full captured thread or only a selected excerpt.

A single folio may be associated with a dedicated channel, several threads, or no Slack connection at all. Broad harvesting of unrelated channel history is not an assumed product behaviour.

### 8.3 GitHub

A folio may reference one or many GitHub repositories, listed as described in 3.2.1. References may point to branches, files, commits, pull requests, releases, or issues. The service should make these links easy to inspect and attach to tickets and decisions.

Repository source code need not be copied into the folio. However, if a GitHub discussion or issue is material to the permanent record, a captured source item should be retained under `sources/github/` along with its live reference. This makes clear what survives an unavailable or renamed repository.

### 8.4 Uploaded and other evidence

People should be able to add documents, screenshots, meeting notes, exports, and customer-provided files. The product should distinguish original uploaded evidence from derived summaries or working copies, and retain enough metadata to explain when and how an item entered the folio.

### 8.5 Source-linked reasoning

A ticket, decision, status update, or feedback disposition may cite several sources. The UI should expose those citations with readable labels. Agents should be able to retrieve the underlying evidence to avoid repeating or amplifying an unsupported claim.

---

### 8.6 Adding items: one routing rule

Whatever adds something to a folio (a drag and drop in the browser, an upload, a forwarded email, the CLI, an agent) hands the item to the library's intake (`folio.add(item)`), and **the library decides where it belongs**. Interfaces never choose storage paths themselves, so a folio filled through any of them looks the same.

| Item | Recognised by | Goes to |
|---|---|---|
| Git repository | A GitHub, GitLab or Bitbucket URL (including links to an issue, pull request or file inside one), an `ssh://`/`git@` address, or a URL ending in `.git` | Listed in `folio.json` `repositories` (3.2.1). Already listed: reported, not duplicated. |
| Email | `.eml` / `message/rfc822`, Outlook `.msg`, or text that starts with an email header block | `sources/email/` (8.1) |
| Other link | Any other URL (also `.webloc` and `.url` shortcut files) | `sources/links/<date>-<site>-<hash>.json`, holding the URL and who added it |
| Text | Dropped or pasted text that is not a URL | `notes/<date>-<first line>.md` |
| File | Anything else | `sources/uploads/` (8.4), keeping a dropped folder's structure; a name already in use gets a number ("report 2.pdf") |

Where it was dropped refines this:

- **On a ticket:** files go to `tickets/<id>/attachments/`; emails still go to `sources/email/`; the ticket gets a link to each (`links`, with a `linked` event in its history). A link is recorded on the ticket instead of `sources/links/`. Text becomes a comment.
- **On a folder:** files go into that folder (a folder inside a ticket means that ticket's attachments). Emails, repositories and links still go to their own places.

Every stored item except a repository listing (which records `added_by` and `added_at` itself) gets a small provenance record in `history/intake/`: when, by whom, through which interface, its original name and type.

## 9. Decisions, notes, and durable context

A decision is more than a chat message saying that somebody has agreed. It is a deliberate record of an outcome, its rationale, and the evidence considered.

Each decision should capture a title, date, maker or approving group, the choice, rationale, alternatives when useful, consequences, related tickets, and supporting sources. Decisions may be superseded or revisited without erasing the original record.

General notes may remain lightweight Markdown documents. `CONTEXT.md` should highlight the current picture without becoming an unstructured dumping ground for every discussion. Important facts should be traceable to tickets, decisions, artifacts, or sources.

The system should surface contradictory or stale notes where known. The current context summary is a navigational aid, not an unquestionable authority over original evidence.

---

## 10. Humans, agents, and external connections

### 10.1 Human operation

The primary interface is a human-accessible workspace. People create folios, choose which work matters, review incoming feedback, assign tickets, share previews, and approve outcomes. External AI agents are supported because they work well with files and standard tools, not because Folio must provide its own conversational AI.

**There is no built-in chatbot, model selector, model-provider integration, or persistent chat product.** People may use Claude, ChatGPT, Cursor, Codex, or other compatible external tools independently.

### 10.2 MCP access to folios

Folio should expose a standard MCP interface through which an authorised external agent can discover accessible folios, read files, understand tickets and relationships, inspect evidence, and make permitted updates. Agent access must be scoped and revocable.

The expected capabilities include discovering folios, reading a folio overview, browsing files, searching content, listing ready tickets, reading ticket histories, creating or editing tickets, linking evidence, reviewing feedback and listing artifacts. The interface should reflect the same truth as the human interface, with no separate agent-only ticket store.

Read access should be the default; write access should be explicitly approved. Connection to an agent is not proof of permission to access every folio.

### 10.3 Multiple upstream MCP connections

A folio may describe several named external MCP connections, such as customer documentation, a reporting system, a support platform, or a database. The folder contains intelligible non-secret aliases and purposes. The hosted service determines which actual connection each alias refers to for a particular account and user.

Connections may be read-only, capable of limited changes, or require human confirmation. Exposing a connection through Folio should not silently grant a broad set of powerful tools to every agent that can read the folder. Outbound access is a separate permission decision from incoming agent access.

### 10.4 Repository connections

Multiple GitHub repositories should be supported for a single folio, possibly with different access levels. A repo association should remain meaningful when disconnected; only operations requiring live GitHub access should be unavailable until reauthorised.

### 10.5 Integration state

The interface should clearly distinguish **connected**, **unavailable**, **requires authorisation**, and **reference only**. Disconnection must not delete retained folio records. Exported folders must not include usable account secrets or tokens.

### 10.6 Untrusted content

Emails, form submissions, Slack messages, uploaded files, repository content, and responses from upstream tools are evidence, not privileged instructions. Folio must prevent these materials from taking on authority over access rules, approved actions, or `AGENTS.md` simply because an agent reads them.

---

## 11. Identity, accounts, permissions, and sharing

### 11.1 Identity model

The identity ecosystem is **Delegate** for human authentication (reached through `@engine9/core`, which owns the session and roles), **Core** for people and membership infrastructure, and **Core Agent Credentials** for authorising external agents. These capabilities serve the product; they are not part of the portable folio format.

A folio is always hosted within an account context, but account membership is managed by the platform. The directory must never contain live permission grants as its authority. **In this version a folio holds no permission information at all**: accounts, members, folio access levels, restricted folios and agent grants live only in the hosting service (`folio-server`'s D1 control plane). Copying or exporting a folio carries none of them.

### 11.2 Roles and access

Suggested role capabilities:

| Role | Typical access |
|---|---|
| Account administrator | Manage account membership, access to folios, and eligible connections. |
| Folio manager | Manage the folio, its tickets, forms, artifacts, invitations, and contributors. |
| Contributor | Read and update authorised folio content and tickets. |
| Viewer | Read selected folio content and artifacts without altering them. |
| Reviewer | Access selected preview/form resources and provide feedback, without general folio access. |
| Connected agent | Carry out only approved operations for the authorising person and accessible folios. |

Roles are examples of user-facing capabilities, not instructions to add a second independent identity system. Organisations may refine them, but permissions should be predictable, explainable, and tested at account and folio boundaries.

### 11.3 Folio-level restrictions

An account member may have no access to a particular folio, read-only access, or editing access. A broad account role does not automatically override explicit folio restrictions unless an administrative policy permits it. Sensitive folios should support narrower participant lists.

Review links, form invitations, and preview access do not by themselves permit access to correspondence, source files, other artifacts, or other accounts.

### 11.4 Sharing and revocation

A folio manager should be able to share selected content, request feedback, revoke invitations, and inspect relevant access history. Revocation should apply to subsequent hosted access. Already-exported copies or downloaded files cannot be technically revoked; the product must make that limitation clear.

Moving or importing a folder requires new account-scoped authorisation. Host-specific permission state should not be copied along as a portable grant.

### 11.5 Privacy and retention

Sources and feedback may contain personal or confidential information. Account administrators need understandable retention, archive, removal, and export policies. Removing access should not be confused with deleting evidence. Permanent deletion may conflict with recordkeeping obligations and should be a deliberate action.

The product should avoid broadly sharing full source evidence when a narrow summary, artifact, or response is sufficient for a reviewer.

---

## 12. Storage and authority boundaries

The hosted environment is Cloudflare, using R2 to hold folio folders and D1 only to enable secure access and the Cloudflare/MCP service features. There is a single production deployment at **`folio.engine9.ai`**; there is no staging environment.

### 12.1 What belongs in folio files

All substantive content must be inside the folio folder, including:

- Folio title, summary, lifecycle state, tags, and portable references.
- Tickets, relationships, comments, status histories, and execution evidence.
- Decisions and rationale.
- Feedback form definitions, submitted answers, and relevant attachments.
- Artifacts, preserved versions, and descriptive metadata.
- Emails, captured Slack/GitHub evidence, documents, and working notes.
- Portable activity and change records necessary to understand what happened.
- Optional local indexes that can be discarded and regenerated without losing meaning.

### 12.2 What the hosted control plane may own

D1 and related hosted identity or credential facilities may hold only information required to **find, protect, and connect** folio folders, including account membership, folio location, account/folio access rules, invitation status, agent OAuth grants, and integration credential references.

It should not be the authoritative store for ticket content, ticket relationships, feedback responses, artifact descriptions, decisions, documents, or email bodies. Nor should the product require a content database to reconstruct a valid folio.

Other systems may hold necessary platform security records. Those records do not become the authority for the business content inside a folio.

### 12.3 Search and presentation

Search, filtered ticket views, summary pages, and activity feeds are conveniences derived from folder content. They should remain accurate if rebuilt from the folio files and must not silently diverge into a second competing record. An index stored inside a folio is optional and disposable.

### 12.4 Editing integrity

Several humans or agents may attempt to update a ticket at once. Folio must avoid silent overwrites, give the user a clear conflict outcome, and preserve an attributable history of committed changes. A platform-managed edit should not claim success when only some of its substantive files have changed.

A person editing exported files directly may bypass hosted change tracking. Folio must accept that portability trade-off while distinguishing verified hosted activity from unattributed changes detected upon import or synchronisation.

### 12.5 Filesystem independence

The product should work conceptually whether the folio folder is backed by R2, another object store, or a local filesystem. The hosted service provides controlled access; it does not turn the folder into an inseparable proprietary object.

---

## 13. Human experience and navigation

The interface should be approachable to an account manager while remaining useful to an engineer. It should not require understanding object storage, MCP, or JSON to perform normal work.

### 13.1 Top-level navigation

Recommended labels are **Accounts**, **Folios**, and **Connections**. Within a folio, the main sections are **Overview**, **Tickets**, **Feedback**, **Artifacts**, **Files**, **Sources**, and **Decisions**. Some smaller sections can be grouped as needed, but the terminology should stay consistent.

### 13.2 Folio overview

The first screen should communicate:

- Folio title, purpose, status, important dates, and account.
- Open tickets, blocked tickets, and work ready to start.
- Items awaiting customer response or review.
- Latest artifacts and currently shared previews.
- Recent significant activity and decisions.
- Relevant repositories and connections, including unavailable ones.
- Quick actions such as New Ticket, Add Evidence, Request Feedback, Upload Artifact, and Share Preview.

For a small folio, this screen should feel simple rather than empty. For a larger folio, it should offer a concise route to the detail without becoming a dashboard requiring constant maintenance.

### 13.3 Ticket workspace

Tickets should support a readable list, a hierarchical outline, a detail page, and a Ready view. A conventional board is optional. The hierarchy is useful for understanding the work, while the detail page is where source evidence, comments, artifacts, and history come together.

### 13.4 Feedback workspace

People can create or edit draft forms, publish them, review responses, and triage submissions. The UI should make it obvious which preview or artifact version a response concerns and whether a ticket has been created for it.

### 13.5 Artifact workspace

Artifacts should offer a library view, revision history, preview/share actions, and related tickets. Users should be able to see exactly which version a customer reviewed and what has been delivered since.

### 13.6 File view

A file explorer is essential, not merely an administrative escape hatch. People should be able to view the actual folder tree and inspect ordinary Markdown, JSON, and common media files. The product must never conceal essential content behind a UI-only object whose representation is missing from the folder.

### 13.7 Connected agents and integrations

People should be able to see which external agents can access their content, the broad extent of their permissions, and how to revoke access. Connection settings should explain whether a reference is portable, whether a live service is attached, and whether an action requires approval.

---

## 14. Representative workflows

### 14.1 An afternoon support request

An account manager creates a folio called “Broken donation form.” They attach a forwarded support email, open one urgent ticket, and link the relevant GitHub repository. An engineer investigates through their preferred tools, fixes the problem, attaches the result, and writes a resolution note. The folio is marked completed that afternoon. Its contents remain understandable if copied to a local folder six months later.

### 14.2 A multi-month website refresh

The team creates a folio with a parent ticket for the refresh and child tickets for design, content, and launch readiness. Preview builds are published as artifacts. Reviewers receive links to a preserved preview version and a feedback form. Responses are triaged into tickets, blockers are tracked, decisions are recorded, and approved versions remain identifiable. The final folio becomes a durable record of what was requested, reviewed, and delivered.

### 14.3 Work involving several systems

One folio references two GitHub repositories, a read-only support-data MCP connection, and a documentation MCP connection. A person authorises an external agent to inspect the folio and assist with a ticket. The agent can read the stored evidence and call only approved external tools. It may update a ticket if granted write access. The folio continues to make sense when those external systems are no longer connected.

### 14.4 Customer feedback becomes accountable work

A customer reviews a new website preview and submits a form noting a mobile layout problem. The submission is retained with its form revision and target artifact version. A human creates a ticket from the response, links it to an existing parent ticket, and assigns it. The fix is demonstrated in a newer artifact version, and the original ticket can show the entire path from report to resolution.

### 14.5 Importing a folio elsewhere

A completed folio is exported and later imported into another authorised account or storage environment. Tickets, relationships, notes, decisions, feedback, and artifacts remain intact. The receiving administrator grants new access and reconnects any necessary external services. No old access credential is silently transferred.

---

## 15. Experience and quality requirements

These are product expectations, independent of a particular delivery mechanism.

**Clarity.** A nontechnical person should be able to create a folio, read ticket status, request feedback, and review an artifact without learning infrastructure terms.

**Small-work friendliness.** A folio should not require milestones, epics, estimates, sprints, or formal workflows merely to track one issue.

**Scalable organisation.** A folio containing hundreds of tickets should still permit filtering, dependency navigation, source tracing, and quick discovery of what is ready or blocked.

**Portability.** A folder can be opened offline, and its substantive content retains its meaning without the Folio service. Missing external integrations are disclosed rather than treated as missing folio data.

**Interoperability.** A capable third-party MCP client can access authorised folios without a built-in model provider, a special chat session, or an agent-specific copy of ticket state.

**Auditability.** Significant business changes are attributable where known. Unverified direct file edits are not falsely represented as securely audited application actions.

**Safety.** Customers cannot see other accounts' folios by guessing paths or links. Review access is narrower than member access. Untrusted previews and source content do not gain privileged authority.

**Resilience.** Loss of an index, cached view, or hosted integration should not destroy the underlying folio record.

**Accessibility.** Forms, ticket navigation, and previews should use readable labels, keyboard-accessible controls, and accessible interaction patterns. Artifact content itself may require additional accessibility work and should not be falsely certified by the platform.

---

## 16. Product acceptance scenarios

The product should be considered faithful to this specification when the following statements are true:

1. A folio can be created as an ordinary folder with `folio.json` and `README.md` and subsequently recognised by the product.
2. A folio can be exported, opened offline, and understood without access to D1, R2, Delegate, Core, GitHub, Slack, or an MCP server.
3. Folio titles, statuses, tickets, decisions, feedback, artifacts, comments, and substantive history all originate from the folio files rather than a hidden content database.
4. Two different account members can work on the same folio without silently overwriting each other's updates.
5. A ticket can have children, blockers, related tickets, and discovery history, and its readiness is explained in ordinary language.
6. Hundreds of fine-grained execution steps can be associated with one customer-facing ticket without producing hundreds of visible tickets.
7. An email or feedback response can become a ticket with a traceable link to its retained original evidence.
8. A published feedback response remains associated with the form definition that the respondent answered.
9. Feedback on a preview can identify an immutable artifact version, and reviewers do not need access to unrelated folio contents.
10. Multiple git repositories (GitHub or otherwise) and multiple named MCP connections can be listed in one folio without any live connection, and missing live connections are clearly shown after export/import.
11. An external agent can read and, when explicitly permitted, update the same folio content that humans use, without native Folio chat.
12. Account-level and folio-level permissions are respected, and revoking a hosted permission removes subsequent hosted access.
13. No usable credentials or hosting-specific permission grants are required inside a portable folio.
14. A simple folio remains simple, while a larger one supports hierarchy, evidence, review, and durable decisions.
15. The application consistently uses **account**, **folio**, **ticket**, **feedback**, and **artifact** as its principal terms.

---

## 17. Deliberate boundaries and open product choices

The following choices are intentionally left flexible, provided the foundational promises are preserved:

- **How elaborate ticket workflows become.** Additional states and custom fields may be valuable, but they should not complicate the default experience or undermine portable records.
- **How much execution history is shown.** Technical actions may be summarised by default, with detailed records available for audit and diagnosis.
- **How collaboration is expressed.** Comments, mentions, notifications, and review requests may be added without turning Folio into another chat service.
- **How much of an external source is captured.** A live link may suffice for transient context, while consequential evidence needs a retained snapshot or original.
- **Which artifact types receive in-browser previews.** Raw files always remain available; safe rendering is a separate capability.
- **What search experience is offered.** Search can improve considerably without becoming authoritative storage.
- **Whether folios later support templates or reusable practices.** Templates should produce ordinary folio folders, not introduce invisible state or mandatory infrastructure.
- **Whether tickets later incorporate named tasks.** Tasks, if introduced, should remain a lower-level concept subordinate to the ticket's customer-facing outcome.

These are areas for product evolution, not reasons to weaken the core folder model.

---

## 18. Governing principle

> **The folder is the product record. Everything else is a way to understand, secure, share, or work with that folder.**

A successful folio stands on its own. The hosted application provides a pleasant human workspace and a reliable bridge to agents and external systems, but the work, evidence, tickets, feedback, decisions, and deliverables belong to the folio itself.

---

## 19. Version 1 scope and deferred work

### In version 1

- The portable folio format and the `@engine9/folio` library (validation, tickets, relationships, readiness, repository listing, import checks, search), with examples.
- Hosting at `folio.engine9.ai` on Cloudflare: folios in R2, a D1 control plane for accounts, folio location and access rules.
- Sign-in through Delegate via `@engine9/core`; account and folio permissions; conflict-safe editing.
- An MCP endpoint over the same folio content, with scoped, revocable agent access.
- A browser workspace laid out like a Finder window: folio list, the folio's folder, tickets (with readiness and tags), repositories, files, sharing.
- Drag and drop (and upload) into a folio, filed by the library's routing rule (8.6).
- Email forwarding to a folio's intake address (8.1).

### Deferred, and what will be needed

| Item | Status | What it needs |
|---|---|---|
| Email forwarding (8.1) | Built; needs switching on | Cloudflare Email Routing on the intake domain with a catch-all rule sending to the `folio` Worker. **The owner sets this up in the Cloudflare dashboard.** Thread matching for replies and Queues for heavy processing come later. |
| Slack capture (8.2) | Version 2 | A Slack app and workspace authorisation. |
| Automated GitHub retrieval | Not planned for v1 | Repository listing (3.2.1) is complete without it. |
| Static website previews (7.3) | Blocked on a TODO | A separate registrable preview domain (see 7.4). |
| Feedback forms, artifacts and decisions in the browser UI | After v1 core | The formats are specified and have examples; the interface follows. |
| Publishing `@engine9/folio` to npm | After testing | Until then, depend on the GitHub repository. |
