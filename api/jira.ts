import { Client } from "@notionhq/client";
import type { VercelRequest, VercelResponse } from "@vercel/node";

import type { JiraIssue, JiraWebhookPayload } from "../lib/jira-types";
import {
  buildProperties,
  getSchemaEntry,
  getSprint,
  getStoryPoints,
  type NotionPropertySchema,
} from "../lib/notion-properties";

const NOTION_TOKEN = getRequiredEnv("NOTION_TOKEN");
const NOTION_DATA_SOURCE_ID = getRequiredEnv("NOTION_DATASOURCE_ID");
const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_SPRINT_FIELD = process.env.JIRA_SPRINT_FIELD;
const JIRA_STORY_POINTS_FIELD = process.env.JIRA_STORY_POINTS_FIELD || "customfield_10016";

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
  const pages = await findPagesByJiraKey(jiraKey);
  return pages[0];
}

async function findPagesByJiraKey(jiraKey: string) {
  const response = await notion.dataSources.query({
    data_source_id: NOTION_DATA_SOURCE_ID,
    page_size: 10,
    filter: {
      property: "Jira Key",
      rich_text: {
        equals: jiraKey,
      },
    },
  });

  if (response.results.length > 1) {
    console.warn("Multiple Notion pages found for one Jira Key; using the first page.", {
      key: jiraKey,
      pageIds: response.results.map((page) => page.id),
    });
  }

  return response.results;
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
          relation:
            property.type === "relation"
              ? {
                  data_source_id:
                    "data_source_id" in property.relation
                      ? property.relation.data_source_id
                      : undefined,
                  database_id:
                    "database_id" in property.relation ? property.relation.database_id : undefined,
                }
              : undefined,
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
  if (getSchemaEntry(propertySchema, "담당자")?.property.type !== "people") return undefined;

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

function getCustomFieldPreview(issue: JiraIssue) {
  return Object.entries(issue.fields)
    .filter(([key, value]) => key.startsWith("customfield_") && value !== null && value !== undefined)
    .map(([key, value]) => ({
      key,
      type: Array.isArray(value) ? "array" : typeof value,
      value:
        typeof value === "string" || typeof value === "number" || typeof value === "boolean"
          ? value
          : Array.isArray(value)
            ? `array(${value.length})`
            : "object",
    }));
}

function getLinkedIssueKeys(issue: JiraIssue) {
  return [
    ...new Set(
      (issue.fields.issuelinks || [])
        .flatMap((link) => [link.inwardIssue?.key, link.outwardIssue?.key])
        .filter((key): key is string => Boolean(key))
    ),
  ];
}

function getIssueLinkPreview(issue: JiraIssue) {
  return (issue.fields.issuelinks || []).map((link) => ({
    type: link.type?.name || null,
    inward: link.type?.inward || null,
    outward: link.type?.outward || null,
    inwardKey: link.inwardIssue?.key || null,
    outwardKey: link.outwardIssue?.key || null,
  }));
}

async function getRelatedSprintPageIds(issue: JiraIssue, propertySchema: NotionPropertySchema) {
  const relatedSprintProperty = getSchemaEntry(propertySchema, "Related Sprint");

  if (relatedSprintProperty?.property.type !== "relation") {
    console.warn("Notion property Related Sprint is missing or not a relation; skipping relation.", {
      key: issue.key,
      notionType: relatedSprintProperty?.property.type || "missing_property",
      availableProperties: Object.keys(propertySchema),
    });
    return undefined;
  }

  const relatedIssueKeys = getLinkedIssueKeys(issue);

  if (relatedIssueKeys.length === 0) {
    console.warn("Jira issue has no linked issue keys; cannot map Related Sprint relation.", {
      key: issue.key,
    });
    return undefined;
  }

  const relatedPageIds: string[] = [];

  for (const relatedIssueKey of relatedIssueKeys) {
    const relatedPage = await findPageByJiraKey(relatedIssueKey);

    if (relatedPage) {
      relatedPageIds.push(relatedPage.id);
      console.log("Mapped Jira linked issue to Related Sprint page.", {
        key: issue.key,
        relatedIssueKey,
      });
    }
  }

  if (relatedPageIds.length === 0) {
    console.warn("No synced Notion page found for Jira linked issues; skipping Related Sprint.", {
      key: issue.key,
      relatedIssueKeys,
    });
    return undefined;
  }

  if (relatedPageIds.length < relatedIssueKeys.length) {
    console.warn("Some Jira linked issues are not synced to Notion yet.", {
      key: issue.key,
      relatedIssueKeys,
      relatedPageCount: relatedPageIds.length,
    });
  }

  return relatedPageIds;
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
    { property: "Title", source: "issue.fields.summary" },
    { property: "Description", source: "issue.fields.description" },
    { property: "Jira Key", source: "issue.key" },
    { property: "Status", source: "issue.fields.status.name" },
    { property: "담당자", source: "issue.fields.assignee.emailAddress" },
    { property: "Priority", source: "issue.fields.priority.name" },
    { property: "Story point estimate", source: JIRA_STORY_POINTS_FIELD },
    { property: "Updated at", source: "issue.fields.updated" },
    { property: "Related Sprint", source: "issue.fields.issuelinks[].inwardIssue/outwardIssue.key" },
    { property: "Sprint 기간", source: JIRA_SPRINT_FIELD || "customfield_10020" },
    { property: "Jira URL", source: "JIRA_BASE_URL/self" },
  ];

  const diagnostics = checks.map(({ property, source }) => ({
    property,
    source,
    actualProperty: getSchemaEntry(propertySchema, property)?.name || null,
    notionType: getSchemaEntry(propertySchema, property)?.property.type || "missing_property",
    payloadType:
      getPayloadType(properties[getSchemaEntry(propertySchema, property)?.name || property]) ||
      getPayloadType(properties[property]) ||
      "omitted",
  }));

  console.log("Jira to Notion sync diagnostics:", {
    key: issue.key,
    jiraStatus: issue.fields.status?.name || null,
    notionStatus: getStatusName(properties.Status) || null,
    storyPointsField: JIRA_STORY_POINTS_FIELD,
    storyPoints: getStoryPoints(issue, JIRA_STORY_POINTS_FIELD),
    sprintField: JIRA_SPRINT_FIELD || "customfield_10020",
    sprintName: getSprint(issue, JIRA_SPRINT_FIELD)?.name || null,
    linkedIssueKeys: getLinkedIssueKeys(issue),
    issueLinks: getIssueLinkPreview(issue),
    hasAssignee: Boolean(issue.fields.assignee),
    assigneeHasEmail: Boolean(issue.fields.assignee?.emailAddress),
    customFields: getCustomFieldPreview(issue),
    properties: diagnostics,
  });
}

function getIssueFromBody(body: unknown) {
  const payload = body as JiraWebhookPayload | JiraIssue;

  if ("issue" in payload && payload.issue) return payload.issue;
  if ("key" in payload && typeof payload.key === "string") return payload;

  return null;
}

function getWebhookPayload(body: unknown) {
  return body as JiraWebhookPayload | JiraIssue;
}

function isIssueDeletedEvent(payload: JiraWebhookPayload | JiraIssue) {
  return (
    "webhookEvent" in payload &&
    (payload.webhookEvent === "jira:issue_deleted" ||
      payload.issue_event_type_name === "issue_deleted")
  );
}

function hasWebhookEvent(payload: JiraWebhookPayload | JiraIssue) {
  return "webhookEvent" in payload || "issue_event_type_name" in payload;
}

function isIssueCreatedEvent(payload: JiraWebhookPayload | JiraIssue) {
  return (
    !hasWebhookEvent(payload) ||
    ("webhookEvent" in payload &&
      (payload.webhookEvent === "jira:issue_created" ||
        payload.issue_event_type_name === "issue_created"))
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }

    const payload = getWebhookPayload(req.body);
    const issue = getIssueFromBody(payload);

    if (!issue?.key) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    if (isIssueDeletedEvent(payload)) {
      const existingPages = await findPagesByJiraKey(issue.key);

      if (existingPages.length === 0) {
        console.warn("Jira issue deleted, but no matching Notion page was found.", {
          key: issue.key,
        });
        return res.status(200).json({ ok: true, action: "delete_ignored", key: issue.key });
      }

      await Promise.all(
        existingPages.map((page) =>
          notion.pages.update({
            page_id: page.id,
            archived: true,
          })
        )
      );

      console.log("Archived Notion pages for deleted Jira issue:", {
        key: issue.key,
        count: existingPages.length,
        pageIds: existingPages.map((page) => page.id),
      });
      return res.status(200).json({
        ok: true,
        action: "archived",
        key: issue.key,
        count: existingPages.length,
      });
    }

    const existingPages = await findPagesByJiraKey(issue.key);
    const existingPage = existingPages[0];
    const propertySchema = await getPropertySchema();
    const assigneeNotionUserId = await getAssigneeNotionUserId(issue, propertySchema);
    const relatedSprintPageIds = await getRelatedSprintPageIds(issue, propertySchema);
    const properties = buildProperties(issue, {
      jiraBaseUrl: JIRA_BASE_URL,
      sprintField: JIRA_SPRINT_FIELD,
      storyPointsField: JIRA_STORY_POINTS_FIELD,
      propertySchema,
      assigneeNotionUserId,
      relatedSprintPageIds,
    });

    logSyncDiagnostics(issue, propertySchema, properties);

    if (existingPage) {
      await notion.pages.update({
        page_id: existingPage.id,
        properties,
      });

      if (existingPages.length > 1) {
        await Promise.all(
          existingPages.slice(1).map((page) =>
            notion.pages.update({
              page_id: page.id,
              archived: true,
            })
          )
        );

        console.warn("Archived duplicate Notion pages after updating canonical Jira Key page.", {
          key: issue.key,
          canonicalPageId: existingPage.id,
          archivedPageIds: existingPages.slice(1).map((page) => page.id),
        });
      }

      console.log("Updated Jira issue in Notion:", issue.key);
      return res.status(200).json({ ok: true, action: "updated", key: issue.key });
    }

    const pagesBeforeCreate = await findPagesByJiraKey(issue.key);
    const pageBeforeCreate = pagesBeforeCreate[0];

    if (pageBeforeCreate) {
      await notion.pages.update({
        page_id: pageBeforeCreate.id,
        properties,
      });

      if (pagesBeforeCreate.length > 1) {
        await Promise.all(
          pagesBeforeCreate.slice(1).map((page) =>
            notion.pages.update({
              page_id: page.id,
              archived: true,
            })
          )
        );
      }

      console.warn("Skipped duplicate Notion create after rechecking Jira Key; updated existing page.", {
        key: issue.key,
        pageId: pageBeforeCreate.id,
        duplicatePageIds: pagesBeforeCreate.slice(1).map((page) => page.id),
      });
      return res.status(200).json({ ok: true, action: "updated_after_recheck", key: issue.key });
    }

    if (!isIssueCreatedEvent(payload)) {
      console.warn("Skipped Notion create for non-created Jira event without existing page.", {
        key: issue.key,
        webhookEvent: "webhookEvent" in payload ? payload.webhookEvent : undefined,
        issueEventTypeName:
          "issue_event_type_name" in payload ? payload.issue_event_type_name : undefined,
      });
      return res.status(200).json({
        ok: true,
        action: "create_skipped_for_non_created_event",
        key: issue.key,
      });
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
