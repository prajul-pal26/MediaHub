interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: any };
  allowedRoles: string[];
}

const ALL_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "list_media",
      description: "Search and browse the media library.",
      parameters: {
        type: "object",
        properties: {
          search: { type: "string", description: "Search by title or tags" },
          type: { type: "string", enum: ["image", "video", "all"] },
          status: { type: "string", enum: ["available", "scheduled", "published"] },
        },
      },
    },
    allowedRoles: ["super_admin", "agency_admin", "agency_editor", "brand_owner", "brand_editor", "brand_viewer"],
  },
  {
    type: "function",
    function: {
      name: "get_media_details",
      description: "Get full details of a specific media group.",
      parameters: {
        type: "object",
        properties: { groupId: { type: "string" } },
        required: ["groupId"],
      },
    },
    allowedRoles: ["super_admin", "agency_admin", "agency_editor", "brand_owner", "brand_editor", "brand_viewer"],
  },
  {
    type: "function",
    function: {
      name: "schedule_content",
      description: "Schedule or publish content to social media.",
      parameters: {
        type: "object",
        properties: {
          groupId: { type: "string" },
          actions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                assetId: { type: "string" },
                action: { type: "string", enum: ["ig_post", "ig_reel", "ig_story", "yt_video", "yt_short", "li_post", "li_article"] },
                accountIds: { type: "array", items: { type: "string" } },
              },
              required: ["assetId", "action", "accountIds"],
            },
          },
          scheduledAt: { type: "string", description: "ISO datetime. Omit for publish now." },
          caption: { type: "string", description: "Caption/commentary text for the post. Use the media group's caption if available." },
          title: { type: "string", description: "Title for YouTube or LinkedIn article posts." },
          description: { type: "string", description: "Description for YouTube or LinkedIn." },
        },
        required: ["groupId", "actions"],
      },
    },
    allowedRoles: ["super_admin", "agency_admin", "agency_editor", "brand_owner", "brand_editor"],
  },
  {
    type: "function",
    function: {
      name: "get_analytics",
      description: "Get analytics/performance data — views, likes, engagement.",
      parameters: {
        type: "object",
        properties: {
          period: { type: "string", enum: ["7d", "30d", "90d"] },
        },
      },
    },
    allowedRoles: ["super_admin", "agency_admin", "agency_editor", "brand_owner", "brand_editor", "brand_viewer"],
  },
  {
    type: "function",
    function: {
      name: "list_accounts",
      description: "List connected social media accounts.",
      parameters: { type: "object", properties: {} },
    },
    allowedRoles: ["super_admin", "agency_admin", "agency_editor", "brand_owner", "brand_editor", "brand_viewer"],
  },
  {
    type: "function",
    function: {
      name: "get_queue_status",
      description: "Check publishing queue — queued, processing, completed, failed jobs.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["queued", "processing", "completed", "failed", "all"] },
        },
      },
    },
    allowedRoles: ["super_admin", "agency_admin", "agency_editor", "brand_owner", "brand_editor", "brand_viewer"],
  },
  {
    type: "function",
    function: {
      name: "retry_failed",
      description: "Retry a failed publish job.",
      parameters: {
        type: "object",
        properties: { jobId: { type: "string" } },
        required: ["jobId"],
      },
    },
    allowedRoles: ["super_admin", "agency_admin", "agency_editor", "brand_owner", "brand_editor"],
  },
  {
    type: "function",
    function: {
      name: "cancel_scheduled",
      description: "Cancel a queued publish job.",
      parameters: {
        type: "object",
        properties: { jobId: { type: "string" } },
        required: ["jobId"],
      },
    },
    allowedRoles: ["super_admin", "agency_admin", "agency_editor", "brand_owner", "brand_editor"],
  },
  {
    type: "function",
    function: {
      name: "list_brands",
      description: "List all brands the user has access to.",
      parameters: { type: "object", properties: {} },
    },
    allowedRoles: ["super_admin", "agency_admin", "agency_editor"],
  },
];

export function getToolsForRole(role: string) {
  return ALL_TOOLS
    .filter((t) => t.allowedRoles.includes(role))
    .map(({ allowedRoles, ...tool }) => tool);
}

export function isToolAllowed(toolName: string, role: string): boolean {
  const tool = ALL_TOOLS.find((t) => t.function.name === toolName);
  return !!tool && tool.allowedRoles.includes(role);
}
