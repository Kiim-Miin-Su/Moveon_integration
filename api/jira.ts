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

type NotionPageResult = {
  id: string;
  created_time?: string;
  properties?: Record<string, unknown>;
};

type SyncResult = {
  action: string;
  key: string;
  count?: number;
  pageId?: string;
  archivedDuplicatePageIds?: string[];
};

function getRequiredEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }

  throw new Error(`Missing required environment variable: ${names.join(" or ")}`);
}

function getSchemaType(propertySchema: NotionPropertySchema, propertyName: string) {
  return getSchemaEntry(propertySchema, propertyName)?.property.type;
}

function areSyncedRelationPair(
  propertySchema: NotionPropertySchema,
  propertyName: string,
  syncedPropertyName: string
) {
  const property = getSchemaEntry(propertySchema, propertyName)?.property;
  const syncedProperty = getSchemaEntry(propertySchema, syncedPropertyName);

  return (
    property?.type === "relation" &&
    property.relation?.type === "dual_property" &&
    syncedProperty &&
    normalizeComparablePropertyName(property.relation.synced_property_name || "") ===
      normalizeComparablePropertyName(syncedProperty.name)
  );
}

function normalizeComparablePropertyName(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function logSchemaCompatibility(propertySchema: NotionPropertySchema) {
  const expectedProperties = [
    { name: "Title", expectedType: "title", required: true },
    { name: "Jira Key", expectedType: "rich_text", required: true },
    { name: "Description", expectedType: "rich_text" },
    { name: "Status", expectedType: "status" },
    { name: "Labels", expectedType: "multi_select" },
    { name: "Issue Type", expectedType: "select" },
    { name: "담당자", expectedType: "people" },
    { name: "Priority", expectedType: "select" },
    { name: "Story point estimate", expectedType: "number" },
    { name: "Updated at", expectedType: "date" },
    { name: "Related Sprint", expectedType: "relation" },
    { name: "Parent Issue", expectedType: "relation" },
    { name: "Subtasks", expectedType: "relation" },
    { name: "Sprint 기간", expectedType: "date" },
    { name: "Jira URL", expectedType: "url" },
  ];

  for (const { name, expectedType, required } of expectedProperties) {
    const schemaEntry = getSchemaEntry(propertySchema, name);
    const actualType = schemaEntry?.property.type || "missing_property";

    if (actualType !== expectedType) {
      const message = `Notion property ${name} is ${actualType}; expected ${expectedType}.`;
      const details = {
        expectedProperty: name,
        actualProperty: schemaEntry?.name || null,
        actualType,
        expectedType,
      };

      if (required) {
        throw new Error(`${message} This property is required for Jira sync.`);
      }

      console.warn(message, details);
    }
  }
}

function getJiraKeyPropertyName(propertySchema?: NotionPropertySchema) {
  return getSchemaEntry(propertySchema, "Jira Key")?.name || "Jira Key";
}

async function findPageByJiraKey(jiraKey: string, propertySchema?: NotionPropertySchema) {
  const pages = await findPagesByJiraKey(jiraKey, propertySchema);
  return selectCanonicalPage(pages);
}

async function findPagesByJiraKey(jiraKey: string, propertySchema?: NotionPropertySchema) {
  const results: NotionPageResult[] = [];
  let startCursor: string | undefined;

  do {
    const response = await notion.dataSources.query({
      data_source_id: NOTION_DATA_SOURCE_ID,
      page_size: 100,
      start_cursor: startCursor,
      filter: {
        property: getJiraKeyPropertyName(propertySchema),
        rich_text: {
          equals: jiraKey,
        },
      },
    });

    results.push(...(response.results as NotionPageResult[]));
    startCursor = response.next_cursor || undefined;
  } while (startCursor);

  if (results.length > 1) {
    console.warn("Multiple Notion pages found for one Jira Key; using canonical page and archiving duplicates.", {
      key: jiraKey,
      pageIds: results.map((page) => page.id),
    });
  }

  return results;
}

function selectCanonicalPage(pages: NotionPageResult[]) {
  return [...pages].sort((left, right) => {
    const leftCreated = left.created_time || "";
    const rightCreated = right.created_time || "";

    if (leftCreated && rightCreated && leftCreated !== rightCreated) {
      return leftCreated.localeCompare(rightCreated);
    }

    return left.id.localeCompare(right.id);
  })[0];
}

async function archiveDuplicatePages(
  jiraKey: string,
  preferredCanonicalPageId: string,
  propertySchema: NotionPropertySchema
) {
  const pages = await findPagesByJiraKey(jiraKey, propertySchema);
  const canonicalPage =
    pages.find((page) => page.id === preferredCanonicalPageId) || selectCanonicalPage(pages);
  const duplicatePages = pages.filter((page) => page.id !== canonicalPage?.id);

  if (duplicatePages.length > 0) {
    await Promise.all(
      duplicatePages.map((page) =>
        notion.pages.update({
          page_id: page.id,
          archived: true,
        })
      )
    );

    console.warn("Archived duplicate Notion pages for Jira Key.", {
      key: jiraKey,
      canonicalPageId: canonicalPage?.id || null,
      archivedPageIds: duplicatePages.map((page) => page.id),
    });
  }

  return {
    canonicalPageId: canonicalPage?.id,
    archivedPageIds: duplicatePages.map((page) => page.id),
  };
}

async function getPropertySchema() {
  propertySchemaPromise ||= notion.dataSources
    .retrieve({
      data_source_id: NOTION_DATA_SOURCE_ID,
    })
    .then((dataSource) => {
      const schema: NotionPropertySchema = {};

      for (const [name, property] of Object.entries(dataSource.properties || {})) {
        const relation =
          property.type === "relation"
            ? (property.relation as {
                type?: string;
                data_source_id?: string;
                database_id?: string;
                dual_property?: {
                  synced_property_id?: string;
                  synced_property_name?: string;
                };
              })
            : undefined;

        schema[name] = {
          type: property.type,
          relation:
            relation
              ? {
                  data_source_id:
                    "data_source_id" in relation
                      ? relation.data_source_id
                      : undefined,
                  database_id:
                    "database_id" in relation ? relation.database_id : undefined,
                  type: relation.type,
                  synced_property_id: relation.dual_property?.synced_property_id,
                  synced_property_name: relation.dual_property?.synced_property_name,
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

      logSchemaCompatibility(schema);

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
    console.warn("Jira issue has no assignee; clearing Notion 담당자 people field.", {
      key: issue.key,
    });
    return null;
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

function getSubtaskKeys(issue: JiraIssue) {
  return (issue.fields.subtasks || [])
    .map((subtask) => subtask.key)
    .filter((key): key is string => Boolean(key));
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
    console.log("Jira issue has no linked issue keys; Related Sprint will be cleared if present.", {
      key: issue.key,
    });
    return undefined;
  }

  const relatedPageIds: string[] = [];

  for (const relatedIssueKey of relatedIssueKeys) {
    const relatedPage = await findPageByJiraKey(relatedIssueKey, propertySchema);

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

async function findPageIdByJiraKey(jiraKey: string, propertySchema: NotionPropertySchema) {
  return (await findPageByJiraKey(jiraKey, propertySchema))?.id;
}

async function getParentIssuePageId(issue: JiraIssue, propertySchema: NotionPropertySchema) {
  const parentIssueProperty = getSchemaEntry(propertySchema, "Parent Issue");

  if (parentIssueProperty?.property.type !== "relation") return undefined;

  const parentKey = issue.fields.parent?.key;
  if (!parentKey) return undefined;

  const parentPageId = await findPageIdByJiraKey(parentKey, propertySchema);

  if (!parentPageId) {
    console.warn("No synced Notion page found for Jira parent issue.", {
      key: issue.key,
      parentKey,
    });
    return undefined;
  }

  return parentPageId;
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

function getPageRelationIds(
  page: unknown,
  propertySchema: NotionPropertySchema,
  propertyName: string
) {
  const actualPropertyName = getSchemaEntry(propertySchema, propertyName)?.name || propertyName;
  const properties = (page as { properties?: Record<string, unknown> }).properties || {};
  const property = properties[actualPropertyName] as
    | { type?: string; relation?: Array<{ id?: string }> }
    | undefined;

  return property?.type === "relation"
    ? (property.relation || []).map((relation) => relation.id).filter((id): id is string => Boolean(id))
    : [];
}

async function updateRelationProperty(
  pageId: string,
  propertySchema: NotionPropertySchema,
  propertyName: string,
  pageIds: string[]
) {
  const schemaEntry = getSchemaEntry(propertySchema, propertyName);

  if (schemaEntry?.property.type !== "relation") return;

  const uniquePageIds = [...new Set(pageIds)];

  await notion.pages.update({
    page_id: pageId,
    properties: {
      [schemaEntry.name]: {
        relation: uniquePageIds.map((id) => ({ id })),
      },
    },
  });
}

async function syncHierarchyRelations(
  issue: JiraIssue,
  currentPageId: string,
  propertySchema: NotionPropertySchema,
  currentPage?: NotionPageResult
) {
  const hasParentIssueRelation = getSchemaType(propertySchema, "Parent Issue") === "relation";
  const hasSubtasksRelation = getSchemaType(propertySchema, "Subtasks") === "relation";
  const hasSyncedParentSubtasksRelation =
    areSyncedRelationPair(propertySchema, "Parent Issue", "Subtasks") ||
    areSyncedRelationPair(propertySchema, "Subtasks", "Parent Issue");
  const subtaskKeys = getSubtaskKeys(issue);
  const subtaskPages: NotionPageResult[] = [];

  for (const subtaskKey of subtaskKeys) {
    const subtaskPage = await findPageByJiraKey(subtaskKey, propertySchema);

    if (!subtaskPage) {
      console.warn("Cannot sync subtask relation; subtask page is not synced.", {
        key: issue.key,
        subtaskKey,
      });
      continue;
    }

    if (subtaskPage.id !== currentPageId) {
      subtaskPages.push(subtaskPage);
    }
  }

  const subtaskPageIds = subtaskPages.map((page) => page.id);

  if (hasSyncedParentSubtasksRelation && hasParentIssueRelation) {
    for (const subtaskPage of subtaskPages) {
      await updateRelationProperty(subtaskPage.id, propertySchema, "Parent Issue", [currentPageId]);
      console.log("Set subtask page Parent Issue; Notion will populate parent Subtasks.", {
        key: issue.key,
        subtaskPageId: subtaskPage.id,
      });
    }

    const existingSubtaskPageIds = currentPage
      ? getPageRelationIds(currentPage, propertySchema, "Subtasks")
      : [];
    const removedSubtaskPageIds = existingSubtaskPageIds.filter(
      (pageId) => !subtaskPageIds.includes(pageId)
    );

    for (const removedSubtaskPageId of removedSubtaskPageIds) {
      await updateRelationProperty(removedSubtaskPageId, propertySchema, "Parent Issue", []);
      console.log("Cleared removed subtask Parent Issue; Notion will remove it from parent Subtasks.", {
        key: issue.key,
        removedSubtaskPageId,
      });
    }

    return;
  }

  if (hasSubtasksRelation) {
    await updateRelationProperty(currentPageId, propertySchema, "Subtasks", subtaskPageIds);
    console.log("Set current Jira issue Subtasks relation directly.", {
      key: issue.key,
      subtaskKeys,
      subtaskPageIds,
    });
  }
}

async function cleanupHierarchyRelationsOnDelete(
  issue: JiraIssue,
  deletedPageIds: string[],
  propertySchema: NotionPropertySchema
) {
  const parentKey = issue.fields.parent?.key;
  const hasSyncedParentSubtasksRelation =
    areSyncedRelationPair(propertySchema, "Parent Issue", "Subtasks") ||
    areSyncedRelationPair(propertySchema, "Subtasks", "Parent Issue");

  if (hasSyncedParentSubtasksRelation && getSchemaType(propertySchema, "Parent Issue") === "relation") {
    for (const deletedPageId of deletedPageIds) {
      await updateRelationProperty(deletedPageId, propertySchema, "Parent Issue", []);
    }

    for (const subtaskKey of getSubtaskKeys(issue)) {
      const subtaskPage = await findPageByJiraKey(subtaskKey, propertySchema);

      if (!subtaskPage) continue;

      await updateRelationProperty(subtaskPage.id, propertySchema, "Parent Issue", []);
      console.log("Cleared Parent Issue from subtask after parent Jira issue deletion.", {
        key: issue.key,
        subtaskKey,
      });
    }

    return;
  }

  if (parentKey && getSchemaType(propertySchema, "Subtasks") === "relation") {
    const parentPage = await findPageByJiraKey(parentKey, propertySchema);

    if (parentPage) {
      await updateRelationProperty(
        parentPage.id,
        propertySchema,
        "Subtasks",
        getPageRelationIds(parentPage, propertySchema, "Subtasks").filter(
          (pageId) => !deletedPageIds.includes(pageId)
        )
      );
      console.log("Removed deleted Jira issue from parent page Subtasks relation.", {
        key: issue.key,
        parentKey,
      });
    }
  }

  if (getSchemaType(propertySchema, "Parent Issue") !== "relation") return;

  for (const subtaskKey of getSubtaskKeys(issue)) {
    const subtaskPage = await findPageByJiraKey(subtaskKey, propertySchema);

    if (!subtaskPage) continue;

    await updateRelationProperty(subtaskPage.id, propertySchema, "Parent Issue", []);
    console.log("Cleared Parent Issue from subtask after parent Jira issue deletion.", {
      key: issue.key,
      subtaskKey,
    });
  }
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
  const statusPropertyName = getSchemaEntry(propertySchema, "Status")?.name || "Status";
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
    { property: "Parent Issue", source: "issue.fields.parent.key" },
    { property: "Subtasks", source: "issue.fields.subtasks[].key" },
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
    notionStatus: getStatusName(properties[statusPropertyName]) || null,
    storyPointsField: JIRA_STORY_POINTS_FIELD,
    storyPoints: getStoryPoints(issue, JIRA_STORY_POINTS_FIELD),
    sprintField: JIRA_SPRINT_FIELD || "customfield_10020",
    sprintName: getSprint(issue, JIRA_SPRINT_FIELD)?.name || null,
    linkedIssueKeys: getLinkedIssueKeys(issue),
    issueLinks: getIssueLinkPreview(issue),
    parentKey: issue.fields.parent?.key || null,
    subtaskKeys: (issue.fields.subtasks || []).map((subtask) => subtask.key).filter(Boolean),
    hasAssignee: Boolean(issue.fields.assignee),
    assigneeHasEmail: Boolean(issue.fields.assignee?.emailAddress),
    customFields: getCustomFieldPreview(issue),
    properties: diagnostics,
  });
}

function isJiraIssue(value: unknown): value is JiraIssue {
  return (
    value !== null &&
    typeof value === "object" &&
    "key" in value &&
    typeof (value as { key?: unknown }).key === "string" &&
    "fields" in value &&
    Boolean((value as { fields?: unknown }).fields) &&
    typeof (value as { fields?: unknown }).fields === "object"
  );
}

function getIssuesFromBody(body: unknown) {
  const payload = body as JiraWebhookPayload | JiraIssue;
  const candidates: unknown[] = [];

  if (!payload || typeof payload !== "object") return [];

  if ("issue" in payload) candidates.push(payload.issue);
  if ("sourceIssue" in payload) candidates.push(payload.sourceIssue);
  if ("destinationIssue" in payload) candidates.push(payload.destinationIssue);
  if (isJiraIssue(payload)) candidates.push(payload);

  const issuesByKey = new Map<string, JiraIssue>();

  for (const candidate of candidates) {
    if (isJiraIssue(candidate) && !issuesByKey.has(candidate.key)) {
      issuesByKey.set(candidate.key, candidate);
    }
  }

  return [...issuesByKey.values()];
}

function getWebhookPayload(body: unknown) {
  return body as JiraWebhookPayload | JiraIssue;
}

function getWebhookEvent(payload: JiraWebhookPayload | JiraIssue) {
  return "webhookEvent" in payload ? payload.webhookEvent : undefined;
}

function getIssueEventType(payload: JiraWebhookPayload | JiraIssue) {
  return "issue_event_type_name" in payload ? payload.issue_event_type_name : undefined;
}

function isIssueDeletedEvent(payload: JiraWebhookPayload | JiraIssue) {
  const webhookEvent = getWebhookEvent(payload);
  const issueEventType = getIssueEventType(payload);

  return (
    webhookEvent === "jira:issue_deleted" ||
    webhookEvent === "issue_deleted" ||
    issueEventType === "issue_deleted"
  );
}

function hasWebhookEvent(payload: JiraWebhookPayload | JiraIssue) {
  return Boolean(getWebhookEvent(payload) || getIssueEventType(payload));
}

function isIssueCreatedEvent(payload: JiraWebhookPayload | JiraIssue) {
  const webhookEvent = getWebhookEvent(payload);
  const issueEventType = getIssueEventType(payload);

  return (
    !hasWebhookEvent(payload) ||
    webhookEvent === "jira:issue_created" ||
    webhookEvent === "issue_created" ||
    issueEventType === "issue_created"
  );
}

async function buildIssueProperties(issue: JiraIssue, propertySchema: NotionPropertySchema) {
  const assigneeNotionUserId = await getAssigneeNotionUserId(issue, propertySchema);
  const relatedSprintPageIds = await getRelatedSprintPageIds(issue, propertySchema);
  const parentIssuePageId = await getParentIssuePageId(issue, propertySchema);

  const properties = buildProperties(issue, {
    jiraBaseUrl: JIRA_BASE_URL,
    sprintField: JIRA_SPRINT_FIELD,
    storyPointsField: JIRA_STORY_POINTS_FIELD,
    propertySchema,
    assigneeNotionUserId,
    relatedSprintPageIds,
    hasLinkedIssues: getLinkedIssueKeys(issue).length > 0,
    parentIssuePageId,
    hasParentIssue: Boolean(parentIssuePageId),
  });

  logSyncDiagnostics(issue, propertySchema, properties);

  return properties;
}

async function updateExistingPage(
  issue: JiraIssue,
  page: NotionPageResult,
  propertySchema: NotionPropertySchema,
  action: string
): Promise<SyncResult> {
  const properties = await buildIssueProperties(issue, propertySchema);

  await notion.pages.update({
    page_id: page.id,
    properties,
  });
  await syncHierarchyRelations(issue, page.id, propertySchema, page);

  const duplicateCleanup = await archiveDuplicatePages(issue.key, page.id, propertySchema);

  console.log("Updated Jira issue in Notion:", issue.key);
  return {
    action,
    key: issue.key,
    pageId: duplicateCleanup.canonicalPageId || page.id,
    archivedDuplicatePageIds: duplicateCleanup.archivedPageIds,
  };
}

async function syncDeletedIssue(
  issue: JiraIssue,
  propertySchema: NotionPropertySchema
): Promise<SyncResult> {
  const existingPages = await findPagesByJiraKey(issue.key, propertySchema);

  if (existingPages.length === 0) {
    console.warn("Jira issue deleted, but no matching Notion page was found.", {
      key: issue.key,
    });
    return { action: "delete_ignored", key: issue.key };
  }

  await cleanupHierarchyRelationsOnDelete(
    issue,
    existingPages.map((page) => page.id),
    propertySchema
  );

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

  return {
    action: "archived",
    key: issue.key,
    count: existingPages.length,
  };
}

async function syncIssue(
  payload: JiraWebhookPayload | JiraIssue,
  issue: JiraIssue,
  propertySchema: NotionPropertySchema
): Promise<SyncResult> {
  if (isIssueDeletedEvent(payload)) {
    return syncDeletedIssue(issue, propertySchema);
  }

  const existingPages = await findPagesByJiraKey(issue.key, propertySchema);
  const existingPage = selectCanonicalPage(existingPages);

  if (existingPage) {
    return updateExistingPage(issue, existingPage, propertySchema, "updated");
  }

  if (!isIssueCreatedEvent(payload)) {
    console.warn("Skipped Notion create for non-created Jira event without existing page.", {
      key: issue.key,
      webhookEvent: getWebhookEvent(payload),
      issueEventTypeName: getIssueEventType(payload),
    });
    return {
      action: "create_skipped_for_non_created_event",
      key: issue.key,
    };
  }

  const properties = await buildIssueProperties(issue, propertySchema);
  const pagesBeforeCreate = await findPagesByJiraKey(issue.key, propertySchema);
  const pageBeforeCreate = selectCanonicalPage(pagesBeforeCreate);

  if (pageBeforeCreate) {
    console.warn("Skipped duplicate Notion create after rechecking Jira Key; updating existing page.", {
      key: issue.key,
      pageId: pageBeforeCreate.id,
    });
    return updateExistingPage(issue, pageBeforeCreate, propertySchema, "updated_after_recheck");
  }

  const createdPage = await notion.pages.create({
    parent: { data_source_id: NOTION_DATA_SOURCE_ID },
    properties,
  });
  await syncHierarchyRelations(issue, createdPage.id, propertySchema, createdPage as NotionPageResult);

  const duplicateCleanup = await archiveDuplicatePages(issue.key, createdPage.id, propertySchema);

  console.log("Created Jira issue in Notion:", issue.key);
  return {
    action: "created",
    key: issue.key,
    pageId: duplicateCleanup.canonicalPageId || createdPage.id,
    archivedDuplicatePageIds: duplicateCleanup.archivedPageIds,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }

    const payload = getWebhookPayload(req.body);
    const issues = getIssuesFromBody(payload);

    if (issues.length === 0) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const propertySchema = await getPropertySchema();
    const results = [];

    for (const issue of issues) {
      results.push(await syncIssue(payload, issue, propertySchema));
    }

    if (results.length === 1) {
      return res.status(200).json({ ok: true, ...results[0] });
    }

    return res.status(200).json({ ok: true, results });
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
