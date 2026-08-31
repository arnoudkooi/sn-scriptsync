### `get_review_result` (collect a human-review outcome)

Guarded commands (background scripts, deletes, some UI actions) whose per-instance gate is set to **Approve** don't execute immediately: the command returns `E_REVIEW_PENDING` right away with a `reviewId`, and the actual request waits in the SN Utils helper tab **Review Queue** for the developer to approve or reject (5-minute window). The helper tab announces the pending review itself (sound, favicon flash, Review Queue badge).

**When you receive `E_REVIEW_PENDING`: tell the user to approve the request in the SN Utils ScriptSync helper tab in their browser, then call this command to collect the outcome.** Long-polls up to `waitSeconds` (default 30, max 55) per call; poll again while it keeps returning `E_REVIEW_PENDING`.

**Request:**
```json
{ "id": "revres_1", "command": "get_review_result", "params": { "reviewId": "rev_1786...._ab12cd", "waitSeconds": 30 } }
```

**Response (approved & executed):** the original command's result, e.g. for `run_background_script`:
```json
{ "status": "success", "result": { "reviewId": "rev_....", "command": "run_background_script", "output": "*** Script: ..." } }
```

**Errors:**
- `E_REVIEW_PENDING` — still undecided; remind the user and poll again.
- `E_USER_REJECTED` — the developer rejected it; don't retry without asking.
- `E_COMMAND_FAILED` — the developer approved it, but execution failed; inspect `details.status`, `details.detail`, and `details.response` instead of treating this as a rejection.
- `E_TIMEOUT` — the 5-minute review window expired unanswered; re-issue the original command to start a new review.
- `E_NOT_FOUND` — unknown/expired `reviewId` (settled results are kept ~10 minutes).

> Prefer this two-phase flow. If you genuinely need the old blocking behavior (the original call holding open until the decision), pass `"awaitReview": true` in the original command's `params` — but note most HTTP clients time out long before the 5-minute window.
