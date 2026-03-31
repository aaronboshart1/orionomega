# Web Fetch

Fetch any URL and return its content as readable text. HTML is automatically stripped for clarity.

## When to Use

- Retrieving the full content of a web page by URL
- Reading documentation, articles, or API responses from a known URL
- Fetching raw JSON or text content from an API endpoint
- Following up on URLs found via `web_search`

## When NOT to Use

- Searching the web for information — use the `web_search` tool instead
- Fetching content that requires authentication (login-gated pages)
- Downloading binary files (images, PDFs, archives)

## Tools

### `web_fetch`

Fetch a URL and return its text content. HTML tags are stripped for readability.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `url` | string | yes | The URL to fetch |
| `maxChars` | number | no | Maximum characters to return (default 10000) |
| `extractMode` | string | no | `text` (default) strips HTML tags; `raw` returns unstripped content |

**Returns:** `{ "result": "..." }` — plain text content of the page with HTML stripped:

```
Page title and heading text
Body content, paragraphs, code examples...
[truncated, N chars omitted]
```

JSON responses are returned as-is without stripping. On failure, returns `{ "error": "..." }`.

**Examples:**

- `{ "url": "https://docs.example.com/guide", "maxChars": 5000 }` — fetch a docs page
- `{ "url": "https://api.example.com/data.json", "extractMode": "raw" }` — fetch raw JSON

## Notes

- Uses Node.js `fetch` with a 30-second timeout
- Automatically strips `<script>` and `<style>` tags and all HTML markup
- JSON responses are detected and returned without stripping
- Output is truncated at `maxChars` with a note indicating omitted content
- Blocks requests to private/internal IP addresses for security
