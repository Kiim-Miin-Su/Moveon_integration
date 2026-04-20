export type JiraIssue = {
  id?: string;
  key: string;
  self?: string;
  fields: {
    created?: string;
    updated?: string;
    summary?: string;
    description?: unknown;
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
    priority?: {
      name?: string;
    } | null;
    [field: string]: unknown;
  };
};

export type JiraWebhookPayload = {
  issue?: JiraIssue;
  webhookEvent?: string;
  issue_event_type_name?: string;
};
