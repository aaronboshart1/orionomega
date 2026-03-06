# web-search

Search the web using DuckDuckGo. Returns structured results with titles, URLs, and snippets. No API key required.

## Usage

Use the `web_search` tool to find information on the web.

### Parameters
- `query` (required): The search query string
- `count` (optional): Number of results to return (1-20, default 5)

### Example
Search for "best databases for AI agents":
- Tool: web_search
- Input: `{"query": "best databases for AI agents", "count": 5}`

### Output Format
Results are returned as numbered entries:
```
Search results for "query":

1. **Title**
   URL: https://example.com
   Snippet text describing the result...

2. **Another Title**
   URL: https://another.com
   Another snippet...
```

## Notes
- Uses DuckDuckGo HTML search (no API key required)
- Results include title, URL, and snippet for each match
- For fetching full page content from a URL, use the `web_fetch` tool (from the web-fetch skill)
