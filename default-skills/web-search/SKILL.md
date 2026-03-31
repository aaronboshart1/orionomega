# Web Search

Search the web using DuckDuckGo and return structured results with titles, URLs, and snippets. No API key required.

## When to Use

- Finding information on the web about a topic
- Looking up documentation, articles, or resources
- Answering questions that require current or real-time information
- Discovering URLs to fetch with the `web_fetch` tool

## When NOT to Use

- Fetching the full content of a known URL — use the `web_fetch` tool instead
- Searching within a specific service (GitHub, Linear, etc.) — use that service's skill
- Querying local files or databases

## Tools

### `web_search`

Search the web for information. Returns titles, URLs, and snippets from DuckDuckGo.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | yes | Search query string |
| `count` | number | no | Number of results to return (1–20, default 5) |

**Returns:** `{ "result": "..." }` — formatted text with numbered results:

```
Search results for "query":

1. **Title**
   URL: https://example.com
   Snippet text describing the result...

2. **Another Title**
   URL: https://another.com
   Another snippet...
```

On failure, returns `{ "error": "..." }`.

**Examples:**

- `{ "query": "best databases for AI agents", "count": 5 }` — search with 5 results
- `{ "query": "Node.js fetch API documentation" }` — search with default count

## Notes

- Uses DuckDuckGo HTML search (no API key required)
- Results include title, URL, and snippet for each match
- For fetching full page content from a result URL, use the `web_fetch` tool from the web-fetch skill
