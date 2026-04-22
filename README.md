# @cynosure-mcp/imap-email

MCP server for reading, searching, drafting, and sending emails via IMAP/SMTP.

## Installation

```bash
npx @cynosure-mcp/imap-email
```

Or install globally:

```bash
npm install -g @cynosure-mcp/imap-email
imap-email
```

## Tools

| Tool             | Description                                               |
| ---------------- | --------------------------------------------------------- |
| `list_folders`   | List all mailbox folders with message counts              |
| `list_emails`    | List emails in a folder (headers only, context-efficient) |
| `get_email`      | Get a full email by UID with parsed body                  |
| `search_emails`  | Search with from/to/subject/body/date filters             |
| `get_attachment` | Download an email attachment                              |
| `draft_email`    | Compose a draft email                                     |
| `send_email`     | Send an email via SMTP                                    |

## Configuration

| Variable        | Required | Description                                      |
| --------------- | -------- | ------------------------------------------------ |
| `IMAP_HOST`     | Yes      | IMAP server hostname (e.g., `imap.gmail.com`)    |
| `IMAP_PORT`     | No       | IMAP port (default: `993`)                       |
| `IMAP_USER`     | Yes      | IMAP login username/email                        |
| `IMAP_PASSWORD` | Yes      | IMAP password or app-specific password           |
| `SMTP_HOST`     | No       | SMTP server hostname (falls back to `IMAP_HOST`) |
| `SMTP_PORT`     | No       | SMTP port (default: `587`)                       |
| `SMTP_USER`     | No       | SMTP login (falls back to `IMAP_USER`)           |
| `SMTP_PASSWORD` | No       | SMTP password (falls back to `IMAP_PASSWORD`)    |
| `EMAIL_FROM`    | No       | Default From address (falls back to `IMAP_USER`) |

## MCP Config

```json
{
  "mcpServers": {
    "imap-email": {
      "command": "npx",
      "args": ["@cynosure-mcp/imap-email"],
      "env": {
        "IMAP_HOST": "imap.gmail.com",
        "IMAP_USER": "you@gmail.com",
        "IMAP_PASSWORD": "your-app-password"
      }
    }
  }
}
```

## License

MIT
