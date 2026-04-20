import { Client } from "@notionhq/client";
import type { VercelRequest, VercelResponse } from "@vercel/node";

import type { JiraIssue, JiraWebhookPayload } from "../lib/jira-types";
import { buildProperties, type NotionPropertySchema } from "../lib/notion-properties";

const NOTION_TOKEN = getRequiredEnv("NOTION_TOKEN");
const NOTION_DATA_SOURCE_ID = getRequiredEnv("NOTION_DATASOURCE_ID");
const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_SPRINT_FIELD = process.env.JIRA_SPRINT_FIELD;

const notion = new Client({
  auth: NOTION_TOKEN,
});

let propertySchemaPromise: Promise<NotionPropertySchema> | null = null;
let notionUsersPromise: Promise<Map<string, string>> | null = null;

type NotionUser = {
  id: string;
  type?: string;
  person?: {
    email?: string;
  };
};

function getRequiredEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }

  throw new Error(`Missing required environment variable: ${names.join(" or ")}`);
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

async function getPropertySchema() {
  propertySchemaPromise ||= notion.dataSources
    .retrieve({
      data_source_id: NOTION_DATA_SOURCE_ID,
    })
    .then((dataSource) => {
      const schema: NotionPropertySchema = {};

      for (const [name, property] of Object.entries(dataSource.properties || {})) {
        schema[name] = {
          type: property.type,
          status:
            property.type === "status"
              ? {
                  options: property.status.options.map((option) => ({ name: option.name })),
                }
              : undefined,
        };
      }

      console.log(
        "Loaded Notion data source schema:",
        Object.entries(schema).map(([name, property]) => `${name}:${property.type}`).join(", ")
      );

      return schema;
    });

  return propertySchemaPromise;
}

async function getNotionUsersByEmail() {
  notionUsersPromise ||= (async () => {
    const usersByEmail = new Map<string, string>();
    let startCursor: string | undefined;

    do {
      const response = await notion.users.list({
        start_cursor: startCursor,
        page_size: 100,
      });

      for (const user of response.results as NotionUser[]) {
        const email = user.type === "person" ? user.person?.email?.toLowerCase() : undefined;
        if (email) usersByEmail.set(email, user.id);
      }

      startCursor = response.next_cursor || undefined;
    } while (startCursor);

    console.log("Loaded Notion people for assignee matching:", usersByEmail.size);
    return usersByEmail;
  })();

  return notionUsersPromise;
}

function maskEmail(email?: string) {
  if (!email) return undefined;

  const [local, domain] = email.split("@");
  if (!local || !domain) return "[invalid-email]";

  return `${local.slice(0, 2)}***@${domain}`;
}

async function getAssigneeNotionUserId(issue: JiraIssue, propertySchema: NotionPropertySchema) {
  if (propertySchema["담당자"]?.type !== "people") return undefined;

  const email = issue.fields.assignee?.emailAddress?.toLowerCase();

  if (!issue.fields.assignee) {
    console.warn("Jira issue has no assignee; skipping Notion 담당자 people field.", {
      key: issue.key,
    });
    return undefined;
  }

  if (!email) {
    console.warn(
      "Jira assignee has no emailAddress; cannot map 담당자 to Notion people. Check Jira privacy settings or webhook fields.",
      {
        key: issue.key,
        assigneeDisplayName: issue.fields.assignee.displayName,
      }
    );
    return undefined;
  }

  const usersByEmail = await getNotionUsersByEmail();
  const notionUserId = usersByEmail.get(email);

  if (!notionUserId) {
    console.warn("No matching Notion user found for Jira assignee email; skipping 담당자.", {
      key: issue.key,
      assigneeEmail: maskEmail(email),
      assigneeDisplayName: issue.fields.assignee.displayName,
    });
    return undefined;
  }

  console.log("Mapped Jira assignee to Notion user.", {
    key: issue.key,
    assigneeEmail: maskEmail(email),
    assigneeDisplayName: issue.fields.assignee.displayName,
  });

  return notionUserId;
}

function getPayloadType(value: unknown) {
  if (!value || typeof value !== "object") return typeof value;

  return Object.keys(value).find((key) =>
    [
      "title",
      "rich_text",
      "status",
      "select",
      "multi_select",
      "people",
      "date",
      "url",
      "number",
      "checkbox",
    ].includes(key)
  );
}

function getStatusName(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const property = value as { status?: { name?: string }; select?: { name?: string } };
  return property.status?.name || property.select?.name;
}

function logSyncDiagnostics(
  issue: JiraIssue,
  propertySchema: NotionPropertySchema,
  properties: ReturnType<typeof buildProperties>
) {
  const checks = [
    { property: "Sprint [scrum-xx] : Title", source: "issue.fields.summary" },
    { property: "Summary", source: "issue.fields.summary" },
    { property: "Jira Key", source: "issue.key" },
    { property: "Status", source: "issue.fields.status.name" },
    { property: "담당자", source: "issue.fields.assignee.emailAddress" },
    { property: "Priority", source: "issue.fields.priority.name" },
    { property: "Updated at", source: "issue.fields.updated" },
    { property: "Sprint Name", source: JIRA_SPRINT_FIELD || "customfield_10020" },
    { property: "Sprint 기간", source: JIRA_SPRINT_FIELD || "customfield_10020" },
    { property: "Jira URL", source: "JIRA_BASE_URL/self" },
  ];

  const diagnostics = checks.map(({ property, source }) => ({
    property,
    source,
    notionType: propertySchema[property]?.type || "missing_property",
    payloadType: getPayloadType(properties[property]) || "omitted",
  }));

  console.log("Jira to Notion sync diagnostics:", {
    key: issue.key,
    jiraStatus: issue.fields.status?.name || null,
    notionStatus: getStatusName(properties.Status) || null,
    hasAssignee: Boolean(issue.fields.assignee),
    assigneeHasEmail: Boolean(issue.fields.assignee?.emailAddress),
    properties: diagnostics,
  });
}

function getIssueFromBody(body: unknown) {
  const payload = body as JiraWebhookPayload | JiraIssue;

  if ("issue" in payload && payload.issue) return payload.issue;
  if ("key" in payload && typeof payload.key === "string") return payload;

  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }

    const issue = getIssueFromBody(req.body);

    if (!issue?.key) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const existingPage = await findPageByJiraKey(issue.key);
    const propertySchema = await getPropertySchema();
    const assigneeNotionUserId = await getAssigneeNotionUserId(issue, propertySchema);
    const properties = buildProperties(issue, {
      jiraBaseUrl: JIRA_BASE_URL,
      sprintField: JIRA_SPRINT_FIELD,
      propertySchema,
      assigneeNotionUserId,
    });

    logSyncDiagnostics(issue, propertySchema, properties);

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
    if (err && typeof err === "object") {
      const notionError = err as {
        code?: string;
        status?: number;
        message?: string;
        request_id?: string;
        body?: string;
      };

      console.error("Notion sync failed:", {
        code: notionError.code,
        status: notionError.status,
        message: notionError.message,
        requestId: notionError.request_id,
        body: notionError.body,
      });
    }

    console.error(err);
    return res.status(500).json({ ok: false, error: "Failed to sync Jira issue" });
  }
}
