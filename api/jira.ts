import { Client } from "@notionhq/client";
import type { VercelRequest, VercelResponse } from "@vercel/node";

import type { JiraIssue, JiraWebhookPayload } from "../lib/jira-types";
import { buildProperties } from "../lib/notion-properties";

const NOTION_TOKEN = getRequiredEnv("NOTION_TOKEN");
const NOTION_DATA_SOURCE_ID = getRequiredEnv("NOTION_DATASOURCE_ID");
const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_SPRINT_FIELD = process.env.JIRA_SPRINT_FIELD;

const notion = new Client({
  auth: NOTION_TOKEN,
});

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
    const properties = buildProperties(issue, {
      jiraBaseUrl: JIRA_BASE_URL,
      sprintField: JIRA_SPRINT_FIELD,
    });

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
