# Working on this folio

- Tasks run on engine9/acme (connection `acme` in folio.json). Connect to the engine9 MCP server or Task API for that account; this folio holds no credentials.
- Before starting a task, check `tasks/` for one already recorded: do not start the same work twice.
- Record each task as you initiate it (definition, options, flow_run_id and task_run_ids), poll engine9 until it finishes, then update the record with its state, records count and a short result. Keep only small output here.
- When every task is completed, post an update and move the folio to review.
