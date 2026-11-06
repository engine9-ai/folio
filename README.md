# Folio

**A folio is a folder.** Its files are the complete, portable record of a bounded piece of work: tickets, correspondence, decisions, feedback, artifacts and the git repositories involved. This repository holds the format specification and a dependency-free JavaScript library and CLI for working with folios.

- [`SPEC.md`](SPEC.md): the product and format specification (living document).
- [`src/`](src): the library. Storage-agnostic: the same code runs over a local folder, memory, or Cloudflare R2.
- [`examples/`](examples): real folio folders. `support-request` is the smallest useful folio; `website-refresh` has hierarchy, blockers, a decision, a feedback response and an artifact.
- Hosted service: [`folio-server`](https://github.com/engine9-ai/folio-server), live at `folio.engine9.ai`.

Not yet on npm. Until then, depend on the repository (`"@engine9/folio": "github:engine9-ai/folio"`).

## CLI

```bash
node bin/folio.js init ./my-folio --title "Broken donation form"
node bin/folio.js repo add ./my-folio engine9-ai/folio-server --purpose "Server" --role primary
node bin/folio.js ticket new ./my-folio --title "Donate button spins" --type bug --priority urgent
node bin/folio.js ticket relate ./my-folio TK-002 blocked_by TK-001
node bin/folio.js add ./my-folio report.eml https://github.com/a/b screenshot.png   # filed where each belongs
node bin/folio.js ready ./my-folio        # what could someone start now?
node bin/folio.js validate ./my-folio     # broken references, loops, secrets, unattested edits
```

## Library

```js
import { Folio, MemoryFs } from '@engine9/folio';
import { NodeFs } from '@engine9/folio/node';

const folio = await Folio.open(new NodeFs('./examples/website-refresh'));
const ready = await folio.readyTickets();           // each carries a plain-language reason
await folio.updateTicket('TK-002', { status: 'in_progress' }, { actor: { type: 'user', id: 'sam' }, expectedRevision: 1 });
const { ok, problems } = await folio.validate();

// Add anything; the folio decides where it goes (SPEC 8.6).
await folio.add({ url: 'https://github.com/engine9-ai/folio' }, { actor });             // listed in folio.json
await folio.add({ name: 'report.eml', data: emlBytes }, { actor });                      // sources/email/
await folio.add({ name: 'screenshot.png', data: pngBytes }, { actor, ticket: 'TK-002' }); // ticket attachment, linked
```

Behaviours worth knowing:

- **Safe concurrent edits.** Each ticket change claims a create-only event file for the next revision, then writes `ticket.json` conditionally. Two writers cannot both succeed; the loser gets a `ConflictError`, and a failed edit leaves nothing behind.
- **Inverse relationships are computed**, never stored, so they cannot drift from the files.
- **Repository listing is by reference.** Entries in `folio.json` work with no integration; every entry reads as `reference_only` in this library.
- **Unknown fields are preserved** when tickets and manifests are edited.
- **Intake routing lives here.** `folio.add(item, { ticket, folder })` recognises repositories, emails, links, text and files and puts each in the right place, with provenance under `history/intake/`. Hosts (the browser, email forwarding, MCP, the CLI) only hand items over.
- **Binary files.** `write(path, data)` takes a string or a `Uint8Array`; stores may add `readBytes(path)`. Ticket and manifest files stay JSON text.
- **Tickets carry tags** (`tags` in `ticket.json`); the older `labels` field still reads.
- **No permissions in a folio.** Access rules belong to the hosting service.
- `NodeFs` overwrites are check-then-write; protect against other processes writing the same folder yourself.

## Develop

```bash
npm test                         # node --test, no dependencies
node scripts/build-examples.js   # regenerate examples through the library
```

MIT licensed.
