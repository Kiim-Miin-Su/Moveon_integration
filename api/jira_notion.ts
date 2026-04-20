import { Client } from "@notionhq/client";
import type { VercelRequest, VercelResponse } from "@vercel/node";

type JiraIssue = {
  id?: string;
  key: string;
  self?: string;
  fields: {
    summary?: string;
    status?: {
      name?: string;
    };
    assignee?: {
      displayName?: string;
      emailAddress?: string;
    } | null;
    labels?: string[];
    issuetype?: {
      name?: string;
    };
  };
};

type JiraWebhookPayload = {
  issue?: JiraIssue;
  webhookEvent?: string;
  issue_event_type_name?: string;
};

const NOTION_TOKEN = getRequiredEnv("NOTION_TOKEN");
const NOTION_DATA_SOURCE_ID = getRequiredEnv("NOTION_DATASOURCE_ID");
const JIRA_BASE_URL = process.env.JIRA_BASE_URL?.replace(/\/$/, "");

const notion = new Client({
  auth: NOTION_TOKEN,
});

type NotionProperties = Parameters<typeof notion.pages.create>[0]["properties"];

function getRequiredEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }

  throw new Error(`Missing required environment variable: ${names.join(" or ")}`);
}

function mapStatus(status?: string) {
  const normalized = status?.trim().toLowerCase();

  if (normalized === "to do" || normalized === "todo") return "Todo";
  if (normalized === "in progress") return "In Progress";
  if (normalized === "test/review" || normalized === "review") return "Test/Review";
  if (normalized === "done" || normalized === "closed") return "Done";

  return "Todo";
}

function mapLabel(label: string) {
  const normalized = label.trim().toLowerCase().replace(/[\s_-]+/g, "");

  if (normalized === "ui/ux" || normalized === "uiux") return "UI/UX";
  if (normalized === "feature") return "Feature";
  if (normalized === "docs" || normalized === "documentation") return "Docs";
  if (normalized === "ci/cd" || normalized === "cicd") return "CI/CD";

  return null;
}

function mapLabels(labels?: string[]) {
  const mapped = new Set<string>();

  for (const label of labels || []) {
    const notionLabel = mapLabel(label);
    if (notionLabel) mapped.add(notionLabel);
  }

  return [...mapped].map((name) => ({ name }));
}

function mapIssueType(issueType?: string) {
  const normalized = issueType?.trim().toLowerCase();

  if (normalized === "bug") return "Bug";
  if (normalized === "story" || normalized === "user story") return "Story";
  if (normalized === "task") return "Task";

  return "Task";
}

function buildJiraUrl(issue: JiraIssue) {
  if (JIRA_BASE_URL) return `${JIRA_BASE_URL}/browse/${issue.key}`;

  if (issue.self) {
    try {
      const url = new URL(issue.self);
      return `${url.origin}/browse/${issue.key}`;
    } catch {
      return issue.self;
    }
  }

  return null;
}

async function findPageByJiraKey(jiraKey: string) {
  const response = await notion.dataSources.query({
    data_source_id: NOTION_DATA_SOURCE_ID,
    page_size: 1,
    filter: {
      property: "Jira Key",
      rich_text: {
        equals: jiraKey,
      },
    },
  });

  return response.results[0];
}

function buildProperties(issue: JiraIssue): NotionProperties {
  const summary = issue.fields.summary || issue.key;
  const assignee =
    issue.fields.assignee?.displayName ||
    issue.fields.assignee?.emailAddress ||
    "Unassigned";
  const jiraUrl = buildJiraUrl(issue);

  return {
    Name: {
      title: [
        {
          text: {
            content: summary,
          },
        },
      ],
    },
    "Jira Key": {
      rich_text: [
        {
          text: {
            content: issue.key,
          },
        },
      ],
    },
    Status: {
      select: {
        name: mapStatus(issue.fields.status?.name),
      },
    },
    Label: {
      multi_select: mapLabels(issue.fields.labels),
    },
    "Issue Type": {
      select: {
        name: mapIssueType(issue.fields.issuetype?.name),
      },
    },
    Assignee: {
      rich_text: [
        {
          text: {
            content: assignee,
          },
        },
      ],
    },
    "Jira URL": {
      url: jiraUrl,
    },
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }

    const event = req.body as JiraWebhookPayload;
    const issue = event.issue;

    if (!issue?.key) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const existingPage = await findPageByJiraKey(issue.key);
    const properties = buildProperties(issue);

    if (existingPage) {
      await notion.pages.update({
        page_id: existingPage.id,
        properties,
      });

      console.log("Updated Jira issue in Notion:", issue.key);
      return res.status(200).json({ ok: true, action: "updated", key: issue.key });
    }

    await notion.pages.create({
      parent: { data_source_id: NOTION_DATA_SOURCE_ID },
      properties,
    });

    console.log("Created Jira issue in Notion:", issue.key);
    return res.status(200).json({ ok: true, action: "created", key: issue.key });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Failed to sync Jira issue" });
  }
}
