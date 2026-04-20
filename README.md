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
JIRA_STORY_POINTS_FIELD=customfield_10016
```

`JIRA_BASE_URL` is used only to create the Notion `Jira URL` value. Use the root Jira site URL only.
`JIRA_SPRINT_FIELD` is optional. Jira company-managed projects commonly use `customfield_10020` for Sprint, but the custom field ID can differ by site.
`JIRA_STORY_POINTS_FIELD` is optional. Jira commonly uses `customfield_10016`, but the custom field ID can differ by site or project.

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
| Title | Title | |
| Description | Rich text | |
| ID | Unique ID | |
| Jira Key | Rich text | |
| Status | Status | `Todo`, `In progress`, `Test/Review`, `Done` |
| Labels | Multi-select | `UI/UX`, `Feature`, `Docs`, `CI/CD` |
| Issue Type | Select | `Bug`, `Task`, `Story` |
| 담당자 | People | |
| Priority | Select | Jira priority names, for example `High`, `Medium`, `Low` |
| Story point estimate | Number | |
| Updated at | Date | |
| Related Sprint | Relation | Links to synced Jira parent issue, subtasks, and linked issues |
| Sprint 기간 | Date | |
| Jira URL | URL | |

The sync uses `Jira Key` to find existing pages. If a page already exists, it updates that page. If not, it creates a new page.
Properties such as `ID`, `Created time`, `GitHub Pull Request`, `Blocked by`, `Blocking`, and `Related Docs` are not written by this webhook yet. `ID` is a Notion-generated unique ID.

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
Issue deleted
Issue link created
Issue link deleted
```

`Issue link created` and `Issue link deleted` are needed for Jira linked work items to refresh `Related Sprint`. Attachments are not used by this sync.
For sprint and board events, enable delete events only if you want Jira deletions to reach the endpoint; issue create/update/delete are the core events for Notion page creation and updates.

This implementation does not require Jira custom headers. Jira's webhook password/basic auth setting is not used by the current code.

## Field Mapping

| Jira field | Notion property |
| --- | --- |
| `issue.id` | `ID` |
| `issue.key` | `Jira Key` |
| `issue.fields.summary` | `Title` |
| `issue.fields.description` | `Description` |
| `issue.fields.status.name` | `Status` |
| `issue.fields.labels` | `Labels` |
| `issue.fields.issuetype.name` | `Issue Type` |
| `issue.fields.priority.name` | `Priority` |
| `issue.fields[JIRA_STORY_POINTS_FIELD]` | `Story point estimate` |
| `issue.fields.updated` | `Updated at` |
| `issue.fields.parent.key` + `issue.fields.subtasks[].key` + `issue.fields.issuelinks[].inwardIssue.key` / `issue.fields.issuelinks[].outwardIssue.key` | `Related Sprint` |
| `issue.fields[JIRA_SPRINT_FIELD].startDate/endDate` | `Sprint 기간` |
| `JIRA_BASE_URL + /browse/<issue.key>` | `Jira URL` |

Jira labels are written as-is. Unknown issue types default to `Task`. Unknown statuses default to `Todo`.

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
      "customfield_10016": 3,
      "assignee": {
        "displayName": "Min Su Kim"
      },
      "issuelinks": [
        {
          "outwardIssue": {
            "key": "TMO-1"
          },
          "type": {
            "name": "Relates",
            "outward": "relates to"
          }
        }
      ],
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

The actual Jira webhook usually sends the top-level `issue` object. Issue link webhooks can include `sourceIssue` and `destinationIssue`; this endpoint updates both when Jira sends both. For manual testing, this endpoint also accepts the issue object directly.

## Local Check

Run TypeScript validation:

```bash
npm run typecheck
npm test
```
