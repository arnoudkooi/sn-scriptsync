### `stop_network_capture` ⚡ (Remote - Async · Pro)
Stop the capture started by `start_network_capture` and return the recorded requests. Detaches the Chrome debugger (dropping the banner) unless a console capture or dialog handler is still active on the tab.

**Request:**
```json
{ "id": "snc_2", "command": "stop_network_capture", "params": {} }
```

**Parameters:**
- `url` (optional): URL pattern to find the tab (default `https://*.service-now.com/*`).
- `tabId` (optional): Target a specific browser tab (use the one returned by `start_network_capture`).

**Response (success):**
```json
{
  "status": "success",
  "result": {
    "count": 2,
    "tabId": 42,
    "requests": [
      {
        "url": "https://acme.service-now.com/api/now/table/incident",
        "method": "GET",
        "type": "XHR",
        "status": 200,
        "mimeType": "application/json",
        "responseHeaders": { "...": "..." },
        "body": "{\"result\":[...]}",
        "bodyTruncated": false
      }
    ]
  }
}
```

Each entry may also include `requestHeaders`, `postData`, `encodedDataLength`, `remoteIP`, `fromCache`, and — on failures — `failed`, `errorText`. `body` is omitted when unavailable; `bodyBase64: true` marks binary bodies.

**Error codes:** `E_PRO_REQUIRED`, `E_CDP_UNAVAILABLE`, `E_NO_TAB`, `E_BROWSER_DISCONNECTED`, `E_TIMEOUT`.
