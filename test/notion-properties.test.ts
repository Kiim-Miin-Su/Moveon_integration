import assert from "node:assert/strict";
import test from "node:test";

import {
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
  },
};

test("maps Jira statuses to Notion status options", () => {
  assert.equal(mapStatus("To Do"), "Todo");
  assert.equal(mapStatus("In Progress"), "In Progress");
  assert.equal(mapStatus("Review"), "Test/Review");
  assert.equal(mapStatus("Closed"), "Done");
  assert.equal(mapStatus("Backlog"), "Todo");
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
    Summary: {
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
    "Sprint Name": {
      rich_text: [
        {
          text: {
            content: "Example Sprint",
          },
        },
      ],
    },
    "Sprint 기간": {
      date: {
        start: "2024-01-15T01:00:00.000Z",
        end: "2024-01-29T01:00:00.000Z",
      },
    },
  });
});
