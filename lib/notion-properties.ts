import type { CreatePageParameters } from "@notionhq/client/build/src/api-endpoints";

import type { JiraIssue } from "./jira-types";

export type NotionProperties = CreatePageParameters["properties"];

type JiraSprint = {
  name?: string;
  startDate?: string;
  endDate?: string;
};

export function mapStatus(status?: string) {
  const normalized = status?.trim().toLowerCase();

  if (normalized === "to do" || normalized === "todo") return "Todo";
  if (normalized === "in progress") return "In Progress";
  if (normalized === "test/review" || normalized === "review") return "Test/Review";
  if (normalized === "done" || normalized === "closed") return "Done";

  return "Todo";
}

export function mapLabel(label: string) {
  const normalized = label.trim().toLowerCase().replace(/[\s_-]+/g, "");

  if (normalized === "ui/ux" || normalized === "uiux") return "UI/UX";
  if (normalized === "feature") return "Feature";
  if (normalized === "docs" || normalized === "documentation") return "Docs";
  if (normalized === "ci/cd" || normalized === "cicd") return "CI/CD";

  return null;
}

export function mapLabels(labels?: string[]) {
  const mapped = new Set<string>();

  for (const label of labels || []) {
    const notionLabel = mapLabel(label);
    if (notionLabel) mapped.add(notionLabel);
  }

  return [...mapped].map((name) => ({ name }));
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
  options: { jiraBaseUrl?: string; sprintField?: string } = {}
): NotionProperties {
  const summary = issue.fields.summary || issue.key;
  const assignee =
    issue.fields.assignee?.displayName ||
    issue.fields.assignee?.emailAddress ||
    "Unassigned";
  const jiraUrl = buildJiraUrl(issue, options.jiraBaseUrl);
  const sprint = getSprint(issue, options.sprintField);
  const properties: NotionProperties = {
    Summary: {
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
    담당자: {
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

  const sprintName = getTextFromUnknown(sprint?.name);
  if (sprintName) {
    properties["Sprint Name"] = {
      rich_text: [
        {
          text: {
            content: sprintName,
          },
        },
      ],
    };
  }

  if (sprint?.startDate) {
    properties["Sprint 기간"] = {
      date: {
        start: sprint.startDate,
        end: sprint.endDate,
      },
    };
  }

  return properties;
}
