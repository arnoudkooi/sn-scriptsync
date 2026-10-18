### `get_batch_result`

Collect the outcome of a `create_records` / `update_records` batch by its `batchId`: after the call returned `E_TIMEOUT`, after a review was approved, or after the connection dropped. Call it before retrying any row.

**Requires:** browser helper tab connected, in the browser profile that ran the batch. Results are kept there for 24 hours.

**Request:**
```json
{ "id": "batch_1", "command": "get_batch_result", "instance": "dev12345", "params": { "batchId": "bat_lzx1y2_a1b2c3d4" } }
```

**Response:** the same shape as the batch command. While the helper is still writing, `status` is `success` with `running: true` and the rows answered so far; call again. Once finished, the same success or error mapping as the original call (`E_PARTIAL_FAILURE` with every row in `details`, and so on). A batch whose helper tab closed mid-run comes back with `interrupted: true`, and the row it was sending is `unknown`.

**Errors:**
- `E_INVALID_PARAMS` - missing or malformed `batchId`
- `E_NOT_FOUND` - no such batch for this instance in this browser (expired, or run elsewhere)
