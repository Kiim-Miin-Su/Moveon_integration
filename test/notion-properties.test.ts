import assert from "node:assert/strict";
import test from "node:test";

import {
  adaptPropertiesToSchema,
  buildJiraUrl,
  buildProperties,
  getSprint,
  mapIssueType,
  mapLabels,
  mapPriority,
  mapStatus,
} from "../lib/notion-properties";
import type { JiraIssue } from "../lib/jira-types";

const issue: JiraIssue = {
  id: "10001",
  key: "MOV-123",
  self: "https://example.atlassian.net/rest/api/3/issue/MOV-123",
  fields: {
    updated: "2024-01-15T05:30:00.000+0000",
    summary: "Improve onboarding",
    description: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Sync Jira issues into Notion.",
            },
          ],
        },
      ],
    },
    status: {
      name: "In Progress",
    },
    labels: ["ui-ux", "docs", "unknown", "CI/CD"],
    issuetype: {
      name: "Story",
    },
    assignee: {
      displayName: "Min Su Kim",
    },
    priority: {
      name: "High",
    },
    customfield_10020: [
      {
        name: "Example Sprint",
        startDate: "2024-01-15T01:00:00.000Z",
        endDate: "2024-01-29T01:00:00.000Z",
      },
    ],
    customfield_10016: 3,
    parent: {
      key: "TMO-1",
    },
  },
};

test("maps Jira statuses to Notion status options", () => {
  assert.equal(mapStatus("To Do"), "Todo");
  assert.equal(mapStatus("In Progress"), "In Progress");
  assert.equal(mapStatus("Review"), "Test/Review");
  assert.equal(mapStatus("Test / Review"), "Test/Review");
  assert.equal(mapStatus("TEST_REVIEW"), "Test/Review");
  assert.equal(mapStatus("검토"), "Test/Review");
  assert.equal(mapStatus("Closed"), "Done");
  assert.equal(mapStatus("Backlog"), "Backlog");
  assert.equal(mapStatus(undefined), "Todo");
});

test("maps known Jira labels and ignores unknown labels", () => {
  assert.deepEqual(mapLabels(["ui/ux", "feature", "documentation", "cicd", "other"]), [
    { name: "UI/UX" },
    { name: "Feature" },
    { name: "Docs" },
    { name: "CI/CD" },
  ]);
});

test("maps Jira issue type to Notion issue type options", () => {
  assert.equal(mapIssueType("Bug"), "Bug");
  assert.equal(mapIssueType("User Story"), "Story");
  assert.equal(mapIssueType("Task"), "Task");
  assert.equal(mapIssueType("Epic"), "Task");
});

test("maps Jira priority to Notion priority option", () => {
  assert.equal(mapPriority("High"), "High");
  assert.equal(mapPriority(""), null);
  assert.equal(mapPriority(undefined), null);
});

test("reads latest sprint from Jira sprint custom field", () => {
  assert.deepEqual(getSprint(issue), {
    name: "Example Sprint",
    startDate: "2024-01-15T01:00:00.000Z",
    endDate: "2024-01-29T01:00:00.000Z",
  });
});

test("builds Jira browser URL from configured base URL", () => {
  assert.equal(
    buildJiraUrl(issue, "https://example.atlassian.net/"),
    "https://example.atlassian.net/browse/MOV-123"
  );
});

test("builds Notion page properties from a Jira issue", () => {
  assert.deepEqual(buildProperties(issue, { jiraBaseUrl: "https://example.atlassian.net" }), {
    Title: {
      title: [
        {
          text: {
            content: "Improve onboarding",
          },
        },
      ],
    },
    ID: {
      rich_text: [
        {
          text: {
            content: "10001",
          },
        },
      ],
    },
    "Jira Key": {
      rich_text: [
        {
          text: {
            content: "MOV-123",
          },
        },
      ],
    },
    Description: {
      rich_text: [
        {
          text: {
            content: "Sync Jira issues into Notion.",
          },
        },
      ],
    },
    Status: {
      select: {
        name: "In Progress",
      },
    },
    Labels: {
      multi_select: [{ name: "UI/UX" }, { name: "Docs" }, { name: "CI/CD" }],
    },
    "Issue Type": {
      select: {
        name: "Story",
      },
    },
    담당자: {
      rich_text: [
        {
          text: {
            content: "Min Su Kim",
          },
        },
      ],
    },
    "Jira URL": {
      url: "https://example.atlassian.net/browse/MOV-123",
    },
    Priority: {
      select: {
        name: "High",
      },
    },
    "Updated at": {
      date: {
        start: "2024-01-15T05:30:00.000+0000",
      },
    },
    "Story point estimate": {
      number: 3,
    },
    "Sprint 기간": {
      date: {
        start: "2024-01-15T01:00:00.000Z",
        end: "2024-01-29T01:00:00.000Z",
      },
    },
  });
});

test("adapts page properties to the Notion data source schema", () => {
  assert.deepEqual(
    adaptPropertiesToSchema(buildProperties(issue, { jiraBaseUrl: "https://example.atlassian.net" }), {
      Labels: { type: "multi_select" },
      Title: { type: "title" },
      "Jira URL": { type: "url" },
      "Updated at": { type: "date" },
      Status: {
        type: "status",
        status: {
          options: [
            { name: "Todo" },
            { name: "In progress" },
            { name: "Test/Review" },
            { name: "Done" },
          ],
        },
      },
      "Issue Type": { type: "select" },
      ID: { type: "unique_id" },
      Priority: { type: "select" },
      "Story point estimate": { type: "number" },
      Description: { type: "rich_text" },
      "Jira Key": { type: "rich_text" },
      담당자: { type: "people" },
      "Related Sprint": { type: "relation" },
      "Sprint 기간": { type: "date" },
    }),
    {
      Title: {
        title: [
          {
            text: {
              content: "Improve onboarding",
            },
          },
        ],
      },
      "Jira Key": {
        rich_text: [
          {
            text: {
              content: "MOV-123",
            },
          },
        ],
      },
      Description: {
        rich_text: [
          {
            text: {
              content: "Sync Jira issues into Notion.",
            },
          },
        ],
      },
      Status: {
        status: {
          name: "In progress",
        },
      },
      Labels: {
        multi_select: [{ name: "UI/UX" }, { name: "Docs" }, { name: "CI/CD" }],
      },
      "Issue Type": {
        select: {
          name: "Story",
        },
      },
      "Jira URL": {
        url: "https://example.atlassian.net/browse/MOV-123",
      },
      Priority: {
        select: {
          name: "High",
        },
      },
      "Story point estimate": {
        number: 3,
      },
      "Updated at": {
        date: {
          start: "2024-01-15T05:30:00.000+0000",
        },
      },
      "Sprint 기간": {
        date: {
          start: "2024-01-15T01:00:00.000Z",
          end: "2024-01-29T01:00:00.000Z",
        },
      },
    }
  );
});

test("writes assignee as people when a matching Notion user is provided", () => {
  assert.deepEqual(
    buildProperties(issue, {
      jiraBaseUrl: "https://example.atlassian.net",
      assigneeNotionUserId: "notion-user-id",
      propertySchema: {
        담당자: { type: "people" },
      },
    }).담당자,
    {
      people: [
        {
          id: "notion-user-id",
        },
      ],
    }
  );
});

test("writes Related Sprint as relation when a related page is provided", () => {
  assert.deepEqual(
    buildProperties(issue, {
      relatedSprintPageId: "related-page-id",
      propertySchema: {
        "Related Sprint": { type: "relation" },
      },
    })["Related Sprint"],
    {
      relation: [
        {
          id: "related-page-id",
        },
      ],
    }
  );
});
