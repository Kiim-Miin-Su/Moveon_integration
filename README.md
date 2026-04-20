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
JIRA_SPRINT_FIELD=customfield_10020
```

`JIRA_BASE_URL` is used only to create the Notion `Jira URL` value. Use the root Jira site URL only.
`JIRA_SPRINT_FIELD` is optional. Jira company-managed projects commonly use `customfield_10020` for Sprint, but the custom field ID can differ by site.

Good:

```text
https://<your-site>.atlassian.net
```

Do not include project, board, or issue paths:

```text
https://<your-site>.atlassian.net/jira/software/projects/ABC/boards/1
https://<your-site>.atlassian.net/browse/ABC-123
```

## Notion Data Source

Share the Notion data source with the Notion integration, then make sure these properties exist.

| Property | Type | Options |
| --- | --- | --- |
| Sprint [scrum-xx] : Title | Title | |
| Summary | Rich text | |
| ID | Unique ID | |
| Jira Key | Rich text | |
| Status | Status | `Todo`, `In progress`, `Test/Review`, `Done` |
| Labels | Multi-select | `UI/UX`, `Feature`, `Docs`, `CI/CD` |
| Issue Type | Select | `Bug`, `Task`, `Story` |
| 담당자 | People | |
| Priority | Select | Jira priority names, for example `High`, `Medium`, `Low` |
| Updated at | Date | |
| Sprint Name | Rich text | |
| Sprint 기간 | Date | |
| Jira URL | URL | |

The sync uses `Jira Key` to find existing pages. If a page already exists, it updates that page. If not, it creates a new page.
Properties such as `ID`, `담당자`, `Created time`, `Related Sprint`, `GitHub Pull Request`, `Blocked by`, `Blocking`, and `Related Docs` are not written by this webhook yet. `ID` is a Notion-generated unique ID, and Jira assignees cannot be written to a People property unless they are mapped to Notion user IDs.

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
| `issue.id` | `ID` |
| `issue.key` | `Jira Key` |
| `issue.fields.summary` | `Sprint [scrum-xx] : Title`, `Summary` |
| `issue.fields.status.name` | `Status` |
| `issue.fields.labels` | `Labels` |
| `issue.fields.issuetype.name` | `Issue Type` |
| `issue.fields.priority.name` | `Priority` |
| `issue.fields.updated` | `Updated at` |
| `issue.fields[JIRA_SPRINT_FIELD].name` | `Sprint Name` |
| `issue.fields[JIRA_SPRINT_FIELD].startDate/endDate` | `Sprint 기간` |
| `JIRA_BASE_URL + /browse/<issue.key>` | `Jira URL` |

Unknown Jira labels are ignored. Unknown issue types default to `Task`. Unknown statuses default to `Todo`.

## Postman Test

Send a `POST` request to:

```text
https://<your-vercel-project>.vercel.app/api/jira
```

Use this JSON body:

```json
{
  "issue": {
    "id": "10001",
    "key": "MOV-123",
    "self": "https://example.atlassian.net/rest/api/3/issue/MOV-123",
    "fields": {
      "summary": "Improve onboarding",
      "updated": "2024-01-15T05:30:00.000+0000",
      "status": {
        "name": "In Progress"
      },
      "labels": ["ui-ux", "docs", "CI/CD"],
      "issuetype": {
        "name": "Story"
      },
      "priority": {
        "name": "High"
      },
      "assignee": {
        "displayName": "Min Su Kim"
      },
      "customfield_10020": [
        {
          "name": "Example Sprint",
          "startDate": "2024-01-15T01:00:00.000Z",
          "endDate": "2024-01-29T01:00:00.000Z"
        }
      ]
    }
  }
}
```

The actual Jira webhook sends the top-level `issue` object. For manual testing, this endpoint also accepts the issue object directly.

## Local Check

Run TypeScript validation:

```bash
npm run typecheck
npm test
```
