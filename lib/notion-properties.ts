import type { CreatePageParameters } from "@notionhq/client/build/src/api-endpoints";

import type { JiraIssue } from "./jira-types";

export type NotionProperties = NonNullable<CreatePageParameters["properties"]>;
type NotionPropertyValue = NotionProperties[string];
export type NotionPropertySchema = Record<
  string,
  {
    type?: string;
    relation?: {
      data_source_id?: string;
      database_id?: string;
    };
    status?: {
      options?: Array<{ name: string }>;
    };
  }
>;
type NotionPropertySchemaEntry = NonNullable<NotionPropertySchema[string]>;

type JiraSprint = {
  name?: string;
  startDate?: string;
  endDate?: string;
};

export function normalizePropertyName(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function getSchemaEntry(schema: NotionPropertySchema | undefined, name: string) {
  if (!schema) return undefined;

  const normalizedName = normalizePropertyName(name);
  const [actualName, property] =
    Object.entries(schema).find(
      ([schemaName]) => normalizePropertyName(schemaName) === normalizedName
    ) || [];

  return actualName && property ? { name: actualName, property } : undefined;
}

function getSchemaProperty(schema: NotionPropertySchema | undefined, name: string) {
  return getSchemaEntry(schema, name)?.property;
}

export function mapStatus(status?: string) {
  const trimmed = status?.trim();
  const normalized = trimmed?.toLowerCase();
  const compact = normalized?.replace(/[\s/_-]+/g, "");

  if (compact === "todo") return "Todo";
  if (compact === "inprogress") return "In Progress";
  if (
    compact === "testreview" ||
    compact === "review" ||
    compact === "qa" ||
    compact === "testing" ||
    normalized?.includes("review") ||
    normalized?.includes("test") ||
    normalized?.includes("검토") ||
    normalized?.includes("테스트")
  ) {
    return "Test/Review";
  }
  if (compact === "done" || compact === "closed") return "Done";

  return trimmed || "Todo";
}

export function mapLabel(label: string) {
  return label.trim();
}

export function mapLabels(labels?: string[]) {
  return [
    ...new Set((labels || []).map(mapLabel).filter((label): label is string => Boolean(label))),
  ].map((name) => ({ name }));
}

export function mapIssueType(issueType?: string) {
  const normalized = issueType?.trim().toLowerCase();

  if (normalized === "bug") return "Bug";
  if (normalized === "story" || normalized === "user story") return "Story";
  if (normalized === "task") return "Task";

  return "Task";
}

export function mapPriority(priority?: string) {
  const trimmed = priority?.trim();
  return trimmed || null;
}

function toDateProperty(date?: string | null) {
  if (!date) return undefined;

  return {
    date: {
      start: date,
    },
  };
}

function getTextFromUnknown(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getNumberFromUnknown(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function collectText(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];

  const node = value as {
    text?: unknown;
    content?: unknown;
  };
  const text = typeof node.text === "string" ? [node.text] : [];
  const children = Array.isArray(node.content) ? node.content.flatMap(collectText) : [];

  return [...text, ...children];
}

function getDescriptionText(value: unknown) {
  if (typeof value === "string") return value.trim() || null;

  const text = collectText(value)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return text || null;
}

function getTitlePropertyName(schema?: NotionPropertySchema) {
  return Object.entries(schema || {}).find(([, property]) => property.type === "title")?.[0];
}

function isReadOnlyProperty(type?: string) {
  return (
    type === "button" ||
    type === "created_by" ||
    type === "created_time" ||
    type === "formula" ||
    type === "last_edited_by" ||
    type === "last_edited_time" ||
    type === "rollup" ||
    type === "unique_id"
  );
}

function getPlainText(property: NotionPropertyValue) {
  const value = property as {
    title?: Array<{ text?: { content?: string } }>;
    rich_text?: Array<{ text?: { content?: string } }>;
  };

  return value.title?.[0]?.text?.content || value.rich_text?.[0]?.text?.content || "";
}

function getPreferredTitleText(properties: NotionProperties) {
  if (properties.Title) return getPlainText(properties.Title);

  const explicitTitle = Object.values(properties).find(
    (property) => property && typeof property === "object" && "title" in property
  );
  if (explicitTitle) return getPlainText(explicitTitle);

  return properties.Description ? getPlainText(properties.Description) : "";
}

function textProperty(type: "title" | "rich_text", content: string): NotionPropertyValue {
  const richText = [
    {
      text: {
        content,
      },
    },
  ];

  if (type === "title") {
    return {
      title: richText,
    };
  }

  return {
    rich_text: richText,
  };
}

function matchStatusOption(status: string, schema?: NotionPropertySchemaEntry) {
  const options = schema?.status?.options || [];
  const matched = options.find((option) => option.name.toLowerCase() === status.toLowerCase());
  if (matched) return matched.name;

  const aliases: Record<string, string[]> = {
    todo: ["not started", "to do"],
    "in progress": ["in progress"],
  };
  const aliasMatched = options.find((option) =>
    aliases[status.toLowerCase()]?.includes(option.name.toLowerCase())
  );

  return aliasMatched?.name || status;
}

export function adaptPropertiesToSchema(
  properties: NotionProperties,
  schema?: NotionPropertySchema
): NotionProperties {
  if (!schema) return properties;

  const adapted: NotionProperties = {};
  const titleText = getPreferredTitleText(properties);
  const titleName = getTitlePropertyName(schema);

  if (titleName && !properties[titleName]) {
    adapted[titleName] = textProperty("title", titleText);
  }

  for (const [name, property] of Object.entries(properties)) {
    const schemaEntry = getSchemaEntry(schema, name);
    const propertyName = schemaEntry?.name || name;
    const propertySchema = schemaEntry?.property;

    if (!propertySchema || isReadOnlyProperty(propertySchema.type)) continue;

    if (propertySchema.type === "title") {
      adapted[propertyName] = textProperty("title", getPlainText(property));
      continue;
    }

    if (propertySchema.type === "rich_text" && ("title" in property || "rich_text" in property)) {
      adapted[propertyName] = textProperty("rich_text", getPlainText(property));
      continue;
    }

    if (propertySchema.type === "status" && "select" in property) {
      adapted[propertyName] = {
        status: {
          name: matchStatusOption(property.select?.name || "", propertySchema),
        },
      };
      continue;
    }

    if (propertySchema.type === "people" && "rich_text" in property) {
      continue;
    }

    adapted[propertyName] = property;
  }

  return adapted;
}

function parseSprintString(value: string): JiraSprint {
  const sprint: JiraSprint = {};

  for (const part of value.split(",")) {
    const [rawKey, ...rawValue] = part.split("=");
    const key = rawKey?.trim();
    const parsedValue = rawValue.join("=").trim();

    if (key === "name") sprint.name = parsedValue;
    if (key === "startDate") sprint.startDate = parsedValue;
    if (key === "endDate") sprint.endDate = parsedValue;
  }

  return sprint;
}

export function getSprint(issue: JiraIssue, sprintField = "customfield_10020") {
  const value = issue.fields[sprintField];
  const sprint = Array.isArray(value) ? value[value.length - 1] : value;

  if (!sprint) return null;

  if (typeof sprint === "string") {
    return parseSprintString(sprint);
  }

  if (typeof sprint === "object") {
    return sprint as JiraSprint;
  }

  return null;
}

export function getStoryPoints(issue: JiraIssue, storyPointsField = "customfield_10016") {
  return getNumberFromUnknown(issue.fields[storyPointsField]);
}

export function buildJiraUrl(issue: JiraIssue, jiraBaseUrl?: string) {
  const baseUrl = jiraBaseUrl?.replace(/\/$/, "");

  if (baseUrl) return `${baseUrl}/browse/${issue.key}`;

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

export function buildProperties(
  issue: JiraIssue,
  options: {
    jiraBaseUrl?: string;
    sprintField?: string;
    propertySchema?: NotionPropertySchema;
    assigneeNotionUserId?: string | null;
    relatedSprintPageIds?: string[];
    hasLinkedIssues?: boolean;
    parentIssuePageId?: string;
    hasParentIssue?: boolean;
    storyPointsField?: string;
  } = {}
): NotionProperties {
  const summary = issue.fields.summary || issue.key;
  const jiraUrl = buildJiraUrl(issue, options.jiraBaseUrl);
  const sprint = getSprint(issue, options.sprintField);
  const description = getDescriptionText(issue.fields.description);
  const storyPoints = getStoryPoints(issue, options.storyPointsField);
  const properties: NotionProperties = {
    Title: {
      title: [
        {
          text: {
            content: summary,
          },
        },
      ],
    },
    ID: {
      rich_text: [
        {
          text: {
            content: issue.id || issue.key,
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
    Labels: {
      multi_select: mapLabels(issue.fields.labels),
    },
    "Issue Type": {
      select: {
        name: mapIssueType(issue.fields.issuetype?.name),
      },
    },
    "Jira URL": {
      url: jiraUrl,
    },
  };

  const assigneePropertyType = getSchemaProperty(options.propertySchema, "담당자")?.type;
  if (assigneePropertyType === "people") {
    if (options.assigneeNotionUserId) {
      properties.담당자 = {
        people: [
          {
            id: options.assigneeNotionUserId,
          },
        ],
      };
    } else if (options.assigneeNotionUserId === null) {
      properties.담당자 = {
        people: [],
      };
    }
  } else {
    const assignee =
      issue.fields.assignee?.displayName ||
      issue.fields.assignee?.emailAddress ||
      "Unassigned";

    properties.담당자 = {
      rich_text: [
        {
          text: {
            content: assignee,
          },
        },
      ],
    };
  }

  if (description) {
    properties.Description = {
      rich_text: [
        {
          text: {
            content: description,
          },
        },
      ],
    };
  }

  if (storyPoints !== null) {
    properties["Story point estimate"] = {
      number: storyPoints,
    };
  }

  if (getSchemaProperty(options.propertySchema, "Related Sprint")?.type === "relation") {
    const relation = options.relatedSprintPageIds?.length
      ? options.relatedSprintPageIds.map((id) => ({ id }))
      : options.hasLinkedIssues === false
        ? []
        : undefined;

    if (relation) {
      properties["Related Sprint"] = {
        relation,
      };
    }
  }

  if (getSchemaProperty(options.propertySchema, "Parent Issue")?.type === "relation") {
    const relation = options.parentIssuePageId
      ? [
          {
            id: options.parentIssuePageId,
          },
        ]
      : options.hasParentIssue === false
        ? []
        : undefined;

    if (relation) {
      properties["Parent Issue"] = {
        relation,
      };
    }
  }

  const priority = mapPriority(issue.fields.priority?.name);
  if (priority) {
    properties.Priority = {
      select: {
        name: priority,
      },
    };
  }

  const updatedAt = toDateProperty(issue.fields.updated);
  if (updatedAt) {
    properties["Updated at"] = updatedAt;
  }

  if (sprint?.startDate) {
    properties["Sprint 기간"] = {
      date: {
        start: sprint.startDate,
        end: sprint.endDate,
      },
    };
  }

  return adaptPropertiesToSchema(properties, options.propertySchema);
}
