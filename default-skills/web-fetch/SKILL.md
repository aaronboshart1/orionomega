# web-fetch

Fetch any URL and return its readable text content. HTML is stripped for clarity.

## Usage

Use the `web_fetch` tool to retrieve page content from a URL.

### Parameters
- `url` (required): The URL to fetch
- `maxChars` (optional): Maximum characters to return. Defaults to 10000.
- `extractMode` (optional): `"text"` (default) strips HTML tags; `"raw"` returns unstripped content.

### Example
Fetch the content of a documentation page:
- Tool: web_fetch
- Input: `{"url": "https://docs.example.com/guide", "maxChars": 5000}`

### Output Format
Returns the text content of the page, with HTML stripped:
```
Page title and heading text
Body content, paragraphs, code examples...
[truncated, N chars omitted]
```

## Notes
- Uses Node.js `fetch` with a 30-second timeout
- Automatically strips `<script>` and `<style>` tags and all HTML tags
- JSON responses are returned as-is without stripping
- For searching the web (getting a list of results), use the `web_search` tool (from the web-search skill)
