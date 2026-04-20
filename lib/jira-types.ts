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
    parent?: {
      key?: string;
    };
    subtasks?: Array<{
      key?: string;
    }>;
    issuelinks?: Array<{
      inwardIssue?: {
        key?: string;
      };
      outwardIssue?: {
        key?: string;
      };
      type?: {
        name?: string;
        inward?: string;
        outward?: string;
      };
    }>;
    [field: string]: unknown;
  };
};

export type JiraWebhookPayload = {
  issue?: JiraIssue;
  sourceIssue?: JiraIssue;
  destinationIssue?: JiraIssue;
  webhookEvent?: string;
  issue_event_type_name?: string;
};
