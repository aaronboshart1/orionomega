# Google Workspace

Full-featured Google Workspace integration via the open-source [workspace-mcp](https://workspacemcp.com) server. Manage Gmail, Drive, Calendar, Docs, Sheets, Slides, Forms, Tasks, Contacts, Chat, Apps Script, and Custom Search — all through a unified interface.

## When to Use

- Reading, sending, searching, and organizing Gmail messages
- Creating, editing, and sharing files in Google Drive
- Managing Google Calendar events and schedules
- Creating and editing Google Docs with rich formatting
- Reading and writing Google Sheets data
- Creating and updating Google Slides presentations
- Building and collecting responses from Google Forms
- Managing Google Tasks and task lists
- Looking up or managing Google Contacts
- Sending and searching Google Chat messages
- Running and managing Google Apps Script projects
- Searching the web via Google Programmable Search Engine

## When NOT to Use

- Microsoft Office 365 or Outlook — use their respective integrations
- Raw Google API calls not covered here — use `google_apps_script` to write a script instead
- Google Analytics, Ads, or other non-Workspace products

## Prerequisites

1. A Google Cloud project with OAuth 2.0 credentials configured
2. `uvx` installed (`pip install uv` or `curl -LsSf https://astral.sh/uv/install.sh | sh`)
3. Relevant Google APIs enabled in your Cloud project
4. Initial OAuth flow completed: `uvx workspace-mcp --single-user`

## Tools

All tools return `{ "result": "..." }` on success (formatted text) or `{ "error": "..." }` on failure.

---

### `gmail`

Manage Gmail: search, read, send, draft, and organize email.

**Actions:** `search`, `get`, `get_batch`, `send`, `draft`, `get_thread`, `get_thread_batch`, `list_labels`, `manage_label`, `modify_labels`, `batch_modify_labels`, `list_filters`, `manage_filter`, `get_attachment`

**Key Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | yes | Action to perform |
| `query` | string | for search | Gmail search query (e.g. `from:user@example.com is:unread`) |
| `message_id` | string | for get/modify | Gmail message ID |
| `message_ids` | string[] | for batch ops | List of message IDs |
| `thread_id` | string | for thread ops | Gmail thread ID |
| `to` | string | for send/draft | Recipient email |
| `subject` | string | for send/draft | Email subject |
| `body` | string | for send/draft | Email body |
| `body_format` | string | no | `text` or `html` |
| `add_label_ids` | string[] | no | Label IDs to add |
| `remove_label_ids` | string[] | no | Label IDs to remove |
| `max_results` | number | no | Max results (default 10) |

**Examples:**
- `{ "action": "search", "query": "from:boss@company.com is:unread" }` — find unread emails from boss
- `{ "action": "send", "to": "user@example.com", "subject": "Hello", "body": "Hi there!" }` — send an email
- `{ "action": "list_labels" }` — list all Gmail labels
- `{ "action": "get", "message_id": "18abc123def456" }` — read a specific message

---

### `google_drive`

Manage Google Drive: search, read, create, copy, share files and folders.

**Actions:** `search`, `get`, `download_url`, `share_link`, `create`, `create_folder`, `import`, `list`, `copy`, `update`, `manage_access`, `set_permissions`, `get_permissions`, `check_public`

**Key Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | yes | Action to perform |
| `file_id` | string | for file ops | Drive file/folder ID |
| `query` | string | for search | Drive query string |
| `name` | string | for create | File/folder name |
| `content` | string | for create | File content |
| `mime_type` | string | no | MIME type |
| `folder_id` | string | no | Parent folder ID |
| `role` | string | for permissions | `reader`, `commenter`, `writer`, or `owner` |
| `share_with` | string | for sharing | Email address to share with |

**Examples:**
- `{ "action": "search", "query": "name contains 'Q4 Report'" }` — find files by name
- `{ "action": "get", "file_id": "1BxiMVs..." }` — read file content
- `{ "action": "create_folder", "name": "Projects 2025" }` — create a folder
- `{ "action": "set_permissions", "file_id": "...", "role": "reader", "share_with": "user@example.com" }` — share a file

---

### `google_calendar`

Manage Google Calendar events and calendars.

**Actions:** `list_calendars`, `get_events`, `manage_event`

**Key Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | yes | Action to perform |
| `calendar_id` | string | no | Calendar ID (default: `primary`) |
| `event_id` | string | for event ops | Event ID |
| `event_action` | string | for manage | `create`, `get`, `update`, `delete`, or `list` |
| `time_min` | string | no | Start filter (ISO 8601) |
| `time_max` | string | no | End filter (ISO 8601) |
| `summary` | string | for create | Event title |
| `start` | string | for create | Start datetime (ISO 8601) |
| `end` | string | for create | End datetime (ISO 8601) |
| `attendees` | string[] | no | Attendee emails |

**Examples:**
- `{ "action": "list_calendars" }` — list all calendars
- `{ "action": "get_events", "calendar_id": "primary", "time_min": "2025-01-01T00:00:00Z" }` — get upcoming events
- `{ "action": "manage_event", "event_action": "create", "summary": "Team Meeting", "start": "2025-04-15T10:00:00Z", "end": "2025-04-15T11:00:00Z" }` — create event

---

### `google_docs`

Create and edit Google Docs with rich formatting.

**Actions:** `get`, `create`, `modify_text`, `get_markdown`, `export_pdf`, `search`, `find_replace`, `list_in_folder`, `insert_elements`, `update_paragraph`, `insert_image`, `update_headers_footers`, `batch_update`, `inspect_structure`, `create_table`, `list_comments`, `manage_comment`

**Key Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | yes | Action to perform |
| `document_id` | string | for doc ops | Document ID |
| `title` | string | for create | Document title |
| `content` | string | for create | Initial text content |
| `text` | string | for modify | Text to insert |
| `start_index` | number | for modify | Start character index |
| `end_index` | number | for modify | End character index |
| `find_text` | string | for find_replace | Text to find |
| `replace_text` | string | for find_replace | Replacement text |
| `operations` | array | for batch_update | Array of update operations |

**Examples:**
- `{ "action": "create", "title": "Meeting Notes", "content": "# April Meeting\n\nAttendees: ..." }` — create a doc
- `{ "action": "get_markdown", "document_id": "1BxiMVs..." }` — get doc as Markdown
- `{ "action": "find_replace", "document_id": "...", "find_text": "v1.0", "replace_text": "v2.0" }` — find and replace

---

### `google_sheets`

Read and write Google Sheets data.

**Actions:** `read`, `write`, `create`, `list`, `get_info`, `format`, `create_sheet`, `list_comments`, `manage_comment`, `conditional_format`

**Key Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | yes | Action to perform |
| `spreadsheet_id` | string | for sheet ops | Spreadsheet ID |
| `range_name` | string | for read/write | Cell range in A1 notation (e.g. `Sheet1!A1:C10`) |
| `values` | array[][] | for write | 2D array of values |
| `title` | string | for create | Spreadsheet title |
| `clear_values` | boolean | no | Clear range before writing |

**Examples:**
- `{ "action": "read", "spreadsheet_id": "...", "range_name": "Sheet1!A1:D20" }` — read cells
- `{ "action": "write", "spreadsheet_id": "...", "range_name": "Sheet1!A1", "values": [["Name", "Score"], ["Alice", 95]] }` — write data
- `{ "action": "create", "title": "Q1 Budget" }` — create a new spreadsheet

---

### `google_slides`

Create and manage Google Slides presentations.

**Actions:** `create`, `get`, `batch_update`, `get_page`, `get_thumbnail`, `list_comments`, `manage_comment`

**Key Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | yes | Action to perform |
| `presentation_id` | string | for pres ops | Presentation ID |
| `title` | string | for create | Presentation title |
| `page_object_id` | string | for page ops | Slide object ID |
| `thumbnail_size` | string | no | `SMALL`, `MEDIUM`, or `LARGE` |
| `requests` | array | for batch_update | Array of update requests |

**Examples:**
- `{ "action": "create", "title": "Q4 Review" }` — create a presentation
- `{ "action": "get", "presentation_id": "..." }` — view all slides
- `{ "action": "get_thumbnail", "presentation_id": "...", "page_object_id": "p", "thumbnail_size": "LARGE" }` — get slide thumbnail

---

### `google_forms`

Create and manage Google Forms.

**Actions:** `create`, `get`, `list_responses`, `get_response`, `set_publish`, `batch_update`

**Key Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | yes | Action to perform |
| `form_id` | string | for form ops | Form ID |
| `title` | string | for create | Form title |
| `description` | string | no | Form description |
| `response_id` | string | for get_response | Response ID |
| `requests` | array | for batch_update | Update requests |

**Examples:**
- `{ "action": "create", "title": "Customer Feedback Survey" }` — create a form
- `{ "action": "list_responses", "form_id": "..." }` — view all responses

---

### `google_tasks`

Manage Google Tasks and task lists.

**Actions:** `list`, `get`, `manage`, `list_lists`, `get_list`, `manage_list`

**Key Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | yes | Action to perform |
| `task_list_id` | string | no | Task list ID (default: `@default`) |
| `task_id` | string | for task ops | Task ID |
| `task_action` | string | for manage | `create`, `get`, `update`, `delete`, `complete` |
| `list_action` | string | for manage_list | `create`, `update`, `delete` |
| `title` | string | for create | Task or list title |
| `status` | string | no | `needsAction` or `completed` |
| `due` | string | no | Due date (RFC 3339) |
| `parent` | string | no | Parent task ID (for sub-tasks) |

**Examples:**
- `{ "action": "list", "task_list_id": "@default" }` — list all tasks
- `{ "action": "manage", "task_action": "create", "title": "Review PR", "due": "2025-04-15T00:00:00Z" }` — create a task
- `{ "action": "manage", "task_action": "complete", "task_id": "abc123" }` — mark task complete

---

### `google_contacts`

Manage Google Contacts via the People API.

**Actions:** `search`, `get`, `list`, `manage`, `list_groups`, `get_group`, `manage_group`, `batch_manage`

**Key Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | yes | Action to perform |
| `query` | string | for search | Search query |
| `contact_id` | string | for contact ops | Resource name (e.g. `people/c123`) |
| `contact_action` | string | for manage | `create`, `update`, `delete` |
| `given_name` | string | for create | First name |
| `family_name` | string | for create | Last name |
| `email` | string | for create | Email address |
| `phone` | string | for create | Phone number |
| `organization` | string | for create | Company name |
| `group_id` | string | for group ops | Group resource name |

**Examples:**
- `{ "action": "search", "query": "alice" }` — find contacts matching "alice"
- `{ "action": "manage", "contact_action": "create", "given_name": "John", "family_name": "Doe", "email": "john@example.com" }` — add a contact

---

### `google_chat`

Send and search Google Chat messages.

**Actions:** `get_messages`, `send`, `search`, `react`, `list_spaces`, `download_attachment`

**Key Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | yes | Action to perform |
| `space_id` | string | for space ops | Space ID (e.g. `spaces/XXXXXXX`) |
| `message_text` | string | for send | Message text |
| `query` | string | for search | Search query |
| `thread_key` | string | no | Thread key (for threaded replies) |
| `emoji_unicode` | string | for react | Emoji unicode (e.g. `1F44D`) |
| `message_name` | string | for react | Full message resource name |

**Examples:**
- `{ "action": "list_spaces" }` — list all Chat spaces
- `{ "action": "send", "space_id": "spaces/XXXXXXX", "message_text": "Hello team!" }` — send a message
- `{ "action": "search", "query": "deployment" }` — search messages

---

### `google_apps_script`

Create, run, and manage Google Apps Script projects.

**Actions:** `list`, `get`, `get_content`, `create`, `update_content`, `run`, `list_deployments`, `manage_deployment`, `list_processes`

**Key Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | yes | Action to perform |
| `script_id` | string | for script ops | Script project ID |
| `title` | string | for create | Project title |
| `file_name` | string | for content ops | Script filename |
| `source_code` | string | for update_content | Script source code |
| `function_name` | string | for run | Function to execute |
| `parameters` | array | for run | Function parameters |
| `dev_mode` | boolean | no | Use dev mode (for run) |

**Examples:**
- `{ "action": "list" }` — list all Apps Script projects
- `{ "action": "run", "script_id": "...", "function_name": "sendWeeklyReport" }` — run a function
- `{ "action": "create", "title": "Data Processor" }` — create a new project

---

### `google_search`

Search the web using Google Programmable Search Engine.

**Actions:** `search`, `get_engine_info`

**Key Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | yes | Action to perform |
| `q` | string | for search | Search query |
| `num` | number | no | Results to return (1-10) |
| `start` | number | no | Result offset |
| `safe` | string | no | `active` or `off` |
| `search_type` | string | no | `image` for image search |
| `site_search` | string | no | Restrict to domain (e.g. `example.com`) |
| `date_restrict` | string | no | Recency filter (`d1`, `w1`, `m1`) |

**Examples:**
- `{ "action": "search", "q": "machine learning papers 2025" }` — web search
- `{ "action": "search", "q": "logo", "search_type": "image", "site_search": "company.com" }` — image search
