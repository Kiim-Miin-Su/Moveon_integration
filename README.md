# Jira to Notion Integration

Jira issue webhook events are synced into a Notion data source through a Vercel serverless function.

## Endpoint

After deploying to Vercel, use this URL as the Jira webhook URL:

```text
https://<your-vercel-project>.vercel.app/api/jira
```

The webhook URL is configured in Jira. It is not an environment variable.

## Environment Variables

Set these in Vercel project settings.

```text
NOTION_TOKEN=ntn_...
NOTION_DATASOURCE_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
JIRA_BASE_URL=https://<your-site>.atlassian.net
```

`JIRA_BASE_URL` is used only to create the Notion `Jira URL` value. Use the root Jira site URL only.

Good:

```text
https://myteam.atlassian.net
```

Do not include project, board, or issue paths:

```text
https://myteam.atlassian.net/jira/software/projects/ABC/boards/1
https://myteam.atlassian.net/browse/ABC-123
```

## Notion Data Source

Share the Notion data source with the Notion integration, then make sure these properties exist.

| Property | Type | Options |
| --- | --- | --- |
| Name | Title | |
| Jira Key | Rich text | |
| Status | Select | `Todo`, `In Progress`, `Test/Review`, `Done` |
| Label | Multi-select | `UI/UX`, `Feature`, `Docs`, `CI/CD` |
| Issue Type | Select | `Bug`, `Task`, `Story` |
| Assignee | Rich text | |
| Jira URL | URL | |

The sync uses `Jira Key` to find existing pages. If a page already exists, it updates that page. If not, it creates a new page.

## Jira Webhook Setup

In Jira, go to:

```text
System > Webhooks
```

Create a webhook with:

```text
URL: https://<your-vercel-project>.vercel.app/api/jira
```

Recommended issue events:

```text
Issue created
Issue updated
Issue transitioned
Issue assigned
```

This implementation does not require Jira custom headers. Jira's webhook password/basic auth setting is not used by the current code.

## Field Mapping

| Jira field | Notion property |
| --- | --- |
| `issue.key` | `Jira Key` |
| `issue.fields.summary` | `Name` |
| `issue.fields.status.name` | `Status` |
| `issue.fields.labels` | `Label` |
| `issue.fields.issuetype.name` | `Issue Type` |
| `issue.fields.assignee.displayName` | `Assignee` |
| `JIRA_BASE_URL + /browse/<issue.key>` | `Jira URL` |

Unknown Jira labels are ignored. Unknown issue types default to `Task`. Unknown statuses default to `Todo`.

## Local Check

Run TypeScript validation:

```bash
npx tsc --noEmit
```
