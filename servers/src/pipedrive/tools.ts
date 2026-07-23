/**
 * Pipedrive MCP Server Tool Definitions
 */

import type { ToolDefinition } from '../common/base-server.js';
import {
  handleListDeals, handleGetDeal, handleSearchDeals, handleCreateDeal, handleUpdateDeal, handleDeleteDeal,
  handleListPersons, handleGetPerson, handleSearchPersons, handleCreatePerson, handleUpdatePerson, handleDeletePerson,
  handleListOrganizations, handleGetOrganization, handleSearchOrganizations, handleCreateOrganization, handleUpdateOrganization, handleDeleteOrganization,
  handleListLeads, handleGetLead, handleCreateLead, handleUpdateLead, handleDeleteLead, handleConvertLead, handleGetLeadConversionStatus,
  handleListActivities, handleGetActivity, handleCreateActivity, handleUpdateActivity, handleDeleteActivity,
  handleListNotes, handleGetNote, handleCreateNote, handleUpdateNote, handleDeleteNote,
  handleListPipelines, handleGetPipeline, handleCreatePipeline, handleUpdatePipeline, handleDeletePipeline,
  handleListStages, handleGetStage, handleCreateStage, handleUpdateStage, handleDeleteStage,
  handleListProducts, handleGetProduct, handleCreateProduct, handleUpdateProduct, handleDeleteProduct,
  handleSearch,
  handleListUsers, handleGetCurrentUser,
  handleListDealParticipants, handleAddDealParticipant, handleDeleteDealParticipant,
  handleListDealProducts, handleAddDealProduct, handleUpdateDealProduct, handleDeleteDealProduct,
  handleListActivityTypes,
  handleListDealFields, handleListPersonFields, handleListOrganizationFields, handleListProductFields,
  handleListCurrencies,
  handleListFilters, handleGetFilter, handleDeleteFilter,
  handleListGoals, handleAddGoal, handleUpdateGoal, handleDeleteGoal,
  handleListProjects, handleGetProject, handleCreateProject, handleUpdateProject, handleDeleteProject,
  handleListTasks, handleGetTask, handleCreateTask, handleUpdateTask, handleDeleteTask,
  handleListWebhooks, handleCreateWebhook, handleDeleteWebhook,
  handleListOrgRelationships, handleCreateOrgRelationship, handleDeleteOrgRelationship,
  handleListFiles, handleGetFile, handleDeleteFile,
  handleListPersonDeals, handleListOrganizationDeals, handleListOrganizationPersons,
  handleListDealActivities, handleListDealNotes,
} from './handlers.js';

// ─── Deals ───────────────────────────────────────────────────────────────────

export const listDealsTool: ToolDefinition = {
  name: 'pipedrive_list_deals',
  description: 'List deals from Pipedrive CRM. Filter by owner, person, organization, pipeline, stage, or status.',
  inputSchema: {
    type: 'object',
    properties: {
      owner_id: { type: 'number', description: 'Filter by owner user ID' },
      person_id: { type: 'number', description: 'Filter by linked person ID' },
      org_id: { type: 'number', description: 'Filter by linked organization ID' },
      pipeline_id: { type: 'number', description: 'Filter by pipeline ID' },
      stage_id: { type: 'number', description: 'Filter by stage ID' },
      status: {
        type: 'string',
        enum: ['open', 'won', 'lost', 'deleted'],
        description: 'Filter by deal status (default: all non-deleted)',
      },
      limit: { type: 'number', description: 'Max results (default: 100, max: 500)' },
      cursor: { type: 'string', description: 'Pagination cursor from previous response' },
      sort_by: { type: 'string', enum: ['id', 'update_time', 'add_time'], description: 'Sort field' },
      sort_direction: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction' },
      updated_since: { type: 'string', description: 'Only deals updated at or after this time (RFC3339, e.g. 2025-01-01T10:00:00Z)' },
    },
  },
  handler: handleListDeals,
};

export const getDealTool: ToolDefinition = {
  name: 'pipedrive_get_deal',
  description: 'Get full details for a single Pipedrive deal by ID.',
  inputSchema: {
    type: 'object',
    properties: {
      deal_id: { type: 'number', description: 'The deal ID' },
    },
    required: ['deal_id'],
  },
  handler: handleGetDeal,
};

export const searchDealsTool: ToolDefinition = {
  name: 'pipedrive_search_deals',
  description: 'Search deals by title, notes, or custom fields.',
  inputSchema: {
    type: 'object',
    properties: {
      term: { type: 'string', description: 'Search term (min 2 chars, or 1 with exact_match)' },
      person_id: { type: 'number', description: 'Filter results by person ID' },
      org_id: { type: 'number', description: 'Filter results by organization ID' },
      status: { type: 'string', enum: ['open', 'won', 'lost'], description: 'Filter by deal status' },
      exact_match: { type: 'boolean', description: 'Only return exact full matches (case-insensitive)' },
      limit: { type: 'number', description: 'Max results (default: 100)' },
      cursor: { type: 'string', description: 'Pagination cursor' },
    },
    required: ['term'],
  },
  handler: handleSearchDeals,
};

export const createDealTool: ToolDefinition = {
  name: 'pipedrive_create_deal',
  description: 'Create a new deal in Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Deal title (required)' },
      value: { type: 'number', description: 'Deal value amount' },
      currency: { type: 'string', description: 'Currency code (e.g. USD, EUR)' },
      person_id: { type: 'number', description: 'ID of the linked person' },
      org_id: { type: 'number', description: 'ID of the linked organization' },
      pipeline_id: { type: 'number', description: 'ID of the pipeline' },
      stage_id: { type: 'number', description: 'ID of the pipeline stage' },
      status: { type: 'string', enum: ['open', 'won', 'lost'], description: 'Deal status (default: open)' },
      expected_close_date: { type: 'string', description: 'Expected close date (YYYY-MM-DD)' },
      owner_id: { type: 'number', description: 'ID of the owner user' },
      label: { type: 'string', description: 'Deal label' },
      custom_fields: {
        type: 'object',
        description: 'Custom field values keyed by Pipedrive field key (40-char hash), e.g. { "9058ca12...": 4640 }. Enum fields take the option ID (not the label); numeric fields a number; text a string. Merged into the request body.',
      },
    },
    required: ['title'],
  },
  handler: handleCreateDeal,
};

export const updateDealTool: ToolDefinition = {
  name: 'pipedrive_update_deal',
  description: 'Update an existing deal — change title, value, stage, status, owner, or other fields.',
  inputSchema: {
    type: 'object',
    properties: {
      deal_id: { type: 'number', description: 'The deal ID to update' },
      title: { type: 'string', description: 'New deal title' },
      value: { type: 'number', description: 'New deal value' },
      currency: { type: 'string', description: 'Currency code' },
      person_id: { type: 'number', description: 'ID of the linked person' },
      org_id: { type: 'number', description: 'ID of the linked organization' },
      pipeline_id: { type: 'number', description: 'ID of the pipeline' },
      stage_id: { type: 'number', description: 'ID of the pipeline stage' },
      status: { type: 'string', enum: ['open', 'won', 'lost'], description: 'Deal status' },
      expected_close_date: { type: 'string', description: 'Expected close date (YYYY-MM-DD)' },
      owner_id: { type: 'number', description: 'ID of the owner user' },
      lost_reason: { type: 'string', description: 'Reason for losing the deal (when status is lost)' },
      label: { type: 'string', description: 'Deal label' },
      custom_fields: {
        type: 'object',
        description: 'Custom field values keyed by Pipedrive field key (40-char hash), e.g. { "9058ca12...": 4640 }. Enum fields take the option ID (not the label); numeric fields a number; text a string. Merged into the request body.',
      },
    },
    required: ['deal_id'],
  },
  handler: handleUpdateDeal,
};

export const deleteDealTool: ToolDefinition = {
  name: 'pipedrive_delete_deal',
  description: 'Permanently delete a deal from Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {
      deal_id: { type: 'number', description: 'The deal ID to delete' },
    },
    required: ['deal_id'],
  },
  handler: handleDeleteDeal,
};

// ─── Persons ─────────────────────────────────────────────────────────────────

export const listPersonsTool: ToolDefinition = {
  name: 'pipedrive_list_persons',
  description: 'List people (contacts) in Pipedrive. Filter by owner or organization.',
  inputSchema: {
    type: 'object',
    properties: {
      owner_id: { type: 'number', description: 'Filter by owner user ID' },
      org_id: { type: 'number', description: 'Filter by organization ID' },
      limit: { type: 'number', description: 'Max results (default: 100)' },
      cursor: { type: 'string', description: 'Pagination cursor' },
      sort_by: { type: 'string', description: 'Sort field' },
      sort_direction: { type: 'string', enum: ['asc', 'desc'] },
      updated_since: { type: 'string', description: 'Only persons updated at or after this time (RFC3339)' },
    },
  },
  handler: handleListPersons,
};

export const getPersonTool: ToolDefinition = {
  name: 'pipedrive_get_person',
  description: 'Get full details for a single person (contact) by ID.',
  inputSchema: {
    type: 'object',
    properties: {
      person_id: { type: 'number', description: 'The person ID' },
    },
    required: ['person_id'],
  },
  handler: handleGetPerson,
};

export const searchPersonsTool: ToolDefinition = {
  name: 'pipedrive_search_persons',
  description: 'Search persons by name, email, phone, or custom fields.',
  inputSchema: {
    type: 'object',
    properties: {
      term: { type: 'string', description: 'Search term (min 2 chars)' },
      fields: { type: 'string', description: 'Comma-separated fields to search: name, email, phone, notes, custom_fields' },
      exact_match: { type: 'boolean', description: 'Only return exact full matches' },
      org_id: { type: 'number', description: 'Filter by organization ID' },
      limit: { type: 'number', description: 'Max results (default: 100)' },
      cursor: { type: 'string', description: 'Pagination cursor' },
    },
    required: ['term'],
  },
  handler: handleSearchPersons,
};

export const createPersonTool: ToolDefinition = {
  name: 'pipedrive_create_person',
  description: 'Create a new person (contact) in Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Full name (required)' },
      email: { type: 'string', description: 'Email address' },
      phone: { type: 'string', description: 'Phone number' },
      org_id: { type: 'number', description: 'Organization ID to link this person to' },
      owner_id: { type: 'number', description: 'Owner user ID' },
      visible_to: { type: 'string', enum: ['1', '3', '5', '7'], description: 'Visibility: 1=owner only, 3=owner+followers, 5=company, 7=everyone' },
    },
    required: ['name'],
  },
  handler: handleCreatePerson,
};

export const updatePersonTool: ToolDefinition = {
  name: 'pipedrive_update_person',
  description: 'Update an existing person (contact) in Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {
      person_id: { type: 'number', description: 'The person ID to update' },
      name: { type: 'string', description: 'New full name' },
      email: { type: 'string', description: 'New email address' },
      phone: { type: 'string', description: 'New phone number' },
      org_id: { type: 'number', description: 'Organization ID' },
      owner_id: { type: 'number', description: 'Owner user ID' },
      visible_to: { type: 'string', enum: ['1', '3', '5', '7'] },
    },
    required: ['person_id'],
  },
  handler: handleUpdatePerson,
};

export const deletePersonTool: ToolDefinition = {
  name: 'pipedrive_delete_person',
  description: 'Permanently delete a person from Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {
      person_id: { type: 'number', description: 'The person ID to delete' },
    },
    required: ['person_id'],
  },
  handler: handleDeletePerson,
};

// ─── Organizations ────────────────────────────────────────────────────────────

export const listOrganizationsTool: ToolDefinition = {
  name: 'pipedrive_list_organizations',
  description: 'List organizations (companies/accounts) in Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {
      owner_id: { type: 'number', description: 'Filter by owner user ID' },
      limit: { type: 'number', description: 'Max results (default: 100)' },
      cursor: { type: 'string', description: 'Pagination cursor' },
      sort_by: { type: 'string', description: 'Sort field' },
      sort_direction: { type: 'string', enum: ['asc', 'desc'] },
      updated_since: { type: 'string', description: 'Only organizations updated at or after this time (RFC3339)' },
    },
  },
  handler: handleListOrganizations,
};

export const getOrganizationTool: ToolDefinition = {
  name: 'pipedrive_get_organization',
  description: 'Get full details for a single organization by ID.',
  inputSchema: {
    type: 'object',
    properties: {
      org_id: { type: 'number', description: 'The organization ID' },
    },
    required: ['org_id'],
  },
  handler: handleGetOrganization,
};

export const searchOrganizationsTool: ToolDefinition = {
  name: 'pipedrive_search_organizations',
  description: 'Search organizations by name, address, or custom fields.',
  inputSchema: {
    type: 'object',
    properties: {
      term: { type: 'string', description: 'Search term (min 2 chars)' },
      fields: { type: 'string', description: 'Comma-separated fields to search: name, address, notes, custom_fields' },
      exact_match: { type: 'boolean', description: 'Only return exact full matches' },
      limit: { type: 'number', description: 'Max results (default: 100)' },
      cursor: { type: 'string', description: 'Pagination cursor' },
    },
    required: ['term'],
  },
  handler: handleSearchOrganizations,
};

export const createOrganizationTool: ToolDefinition = {
  name: 'pipedrive_create_organization',
  description: 'Create a new organization (company/account) in Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Organization name (required)' },
      owner_id: { type: 'number', description: 'Owner user ID' },
      address: { type: 'string', description: 'Organization address' },
      visible_to: { type: 'string', enum: ['1', '3', '5', '7'], description: 'Visibility setting' },
    },
    required: ['name'],
  },
  handler: handleCreateOrganization,
};

export const updateOrganizationTool: ToolDefinition = {
  name: 'pipedrive_update_organization',
  description: 'Update an existing organization in Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {
      org_id: { type: 'number', description: 'The organization ID to update' },
      name: { type: 'string', description: 'New name' },
      owner_id: { type: 'number', description: 'Owner user ID' },
      address: { type: 'string', description: 'New address' },
      visible_to: { type: 'string', enum: ['1', '3', '5', '7'] },
    },
    required: ['org_id'],
  },
  handler: handleUpdateOrganization,
};

export const deleteOrganizationTool: ToolDefinition = {
  name: 'pipedrive_delete_organization',
  description: 'Permanently delete an organization from Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {
      org_id: { type: 'number', description: 'The organization ID to delete' },
    },
    required: ['org_id'],
  },
  handler: handleDeleteOrganization,
};

// ─── Leads ────────────────────────────────────────────────────────────────────

export const listLeadsTool: ToolDefinition = {
  name: 'pipedrive_list_leads',
  description: 'List leads in Pipedrive. Filter by owner, person, or organization.',
  inputSchema: {
    type: 'object',
    properties: {
      owner_id: { type: 'number', description: 'Filter by owner user ID' },
      person_id: { type: 'number', description: 'Filter by linked person ID' },
      org_id: { type: 'number', description: 'Filter by linked organization ID' },
      limit: { type: 'number', description: 'Max results (default: 100)' },
      cursor: { type: 'string', description: 'Pagination cursor' },
      sort_by: { type: 'string', description: 'Sort field' },
      sort_direction: { type: 'string', enum: ['asc', 'desc'] },
    },
  },
  handler: handleListLeads,
};

export const getLeadTool: ToolDefinition = {
  name: 'pipedrive_get_lead',
  description: 'Get full details for a single lead by its UUID.',
  inputSchema: {
    type: 'object',
    properties: {
      lead_id: { type: 'string', description: 'The lead UUID' },
    },
    required: ['lead_id'],
  },
  handler: handleGetLead,
};

export const createLeadTool: ToolDefinition = {
  name: 'pipedrive_create_lead',
  description: 'Create a new lead in Pipedrive. Must be linked to a person or organization.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Lead title (required)' },
      person_id: { type: 'number', description: 'Person ID to link to (required if no org_id)' },
      org_id: { type: 'number', description: 'Organization ID to link to (required if no person_id)' },
      owner_id: { type: 'number', description: 'Owner user ID' },
      value: { type: 'number', description: 'Lead value amount' },
      currency: { type: 'string', description: 'Currency code (e.g. USD) — required if value is set' },
      expected_close_date: { type: 'string', description: 'Expected close date (YYYY-MM-DD)' },
      label_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Label UUIDs to assign',
      },
      custom_fields: {
        type: 'object',
        description: 'Custom field values keyed by Pipedrive field key (40-char hash), e.g. { "9058ca12...": 4640 }. Enum fields take the option ID (not the label); numeric fields a number; text a string. Merged into the request body.',
      },
    },
    required: ['title'],
  },
  handler: handleCreateLead,
};

export const updateLeadTool: ToolDefinition = {
  name: 'pipedrive_update_lead',
  description: 'Update an existing lead in Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {
      lead_id: { type: 'string', description: 'The lead UUID to update' },
      title: { type: 'string', description: 'New title' },
      person_id: { type: 'number', description: 'New linked person ID' },
      org_id: { type: 'number', description: 'New linked organization ID' },
      owner_id: { type: 'number', description: 'New owner user ID' },
      value: { type: 'number', description: 'New value amount' },
      currency: { type: 'string', description: 'Currency code — required if value is set' },
      expected_close_date: { type: 'string', description: 'New expected close date (YYYY-MM-DD)' },
      label_ids: { type: 'array', items: { type: 'string' }, description: 'New label UUIDs' },
      was_seen: { type: 'boolean', description: 'Mark lead as seen/unseen' },
      custom_fields: {
        type: 'object',
        description: 'Custom field values keyed by Pipedrive field key (40-char hash), e.g. { "9058ca12...": 4640 }. Enum fields take the option ID (not the label); numeric fields a number; text a string. Merged into the request body.',
      },
    },
    required: ['lead_id'],
  },
  handler: handleUpdateLead,
};

export const deleteLeadTool: ToolDefinition = {
  name: 'pipedrive_delete_lead',
  description: 'Permanently delete a lead from Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {
      lead_id: { type: 'string', description: 'The lead UUID to delete' },
    },
    required: ['lead_id'],
  },
  handler: handleDeleteLead,
};

export const convertLeadTool: ToolDefinition = {
  name: 'pipedrive_convert_lead',
  description: 'Convert a lead into a deal using Pipedrive\'s native conversion (API v2), preserving the linked person and organization. Conversion is asynchronous — the response returns a conversion_id; poll pipedrive_get_lead_conversion_status to obtain the resulting deal ID once completed.',
  inputSchema: {
    type: 'object',
    properties: {
      lead_id: { type: 'string', description: 'The lead UUID to convert to a deal' },
      stage_id: { type: 'number', description: 'Optional stage ID to place the new deal in' },
      pipeline_id: { type: 'number', description: 'Optional pipeline ID for the new deal (ignored if stage_id is provided)' },
    },
    required: ['lead_id'],
  },
  handler: handleConvertLead,
};

export const getLeadConversionStatusTool: ToolDefinition = {
  name: 'pipedrive_get_lead_conversion_status',
  description: 'Poll the status of a lead-to-deal conversion started by pipedrive_convert_lead. Returns status (not_started/running/completed/failed/rejected); the resulting deal ID is only present once completed (retained by Pipedrive for a few days).',
  inputSchema: {
    type: 'object',
    properties: {
      lead_id: { type: 'string', description: 'The lead UUID that is being converted' },
      conversion_id: { type: 'string', description: 'The conversion job ID returned by pipedrive_convert_lead' },
    },
    required: ['lead_id', 'conversion_id'],
  },
  handler: handleGetLeadConversionStatus,
};

// ─── Activities ───────────────────────────────────────────────────────────────

export const listActivitiesTool: ToolDefinition = {
  name: 'pipedrive_list_activities',
  description: 'List activities (calls, meetings, tasks, emails, etc.) in Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {
      user_id: { type: 'number', description: 'Filter by user (assignee) ID' },
      deal_id: { type: 'number', description: 'Filter by deal ID' },
      person_id: { type: 'number', description: 'Filter by person ID' },
      org_id: { type: 'number', description: 'Filter by organization ID' },
      done: { type: 'number', enum: [0, 1], description: '0 = pending, 1 = done' },
      type: { type: 'string', description: 'Activity type key (e.g. call, meeting, task, email, lunch)' },
      start_date: { type: 'string', description: 'Filter activities from this date (YYYY-MM-DD)' },
      end_date: { type: 'string', description: 'Filter activities until this date (YYYY-MM-DD)' },
      limit: { type: 'number', description: 'Max results (default: 100)' },
      cursor: { type: 'string', description: 'Pagination cursor' },
      updated_since: { type: 'string', description: 'Only activities updated at or after this time (RFC3339)' },
    },
  },
  handler: handleListActivities,
};

export const getActivityTool: ToolDefinition = {
  name: 'pipedrive_get_activity',
  description: 'Get full details for a single activity by ID.',
  inputSchema: {
    type: 'object',
    properties: {
      activity_id: { type: 'number', description: 'The activity ID' },
    },
    required: ['activity_id'],
  },
  handler: handleGetActivity,
};

export const createActivityTool: ToolDefinition = {
  name: 'pipedrive_create_activity',
  description: 'Create a new activity (call, meeting, task, etc.) in Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'Activity subject (required)' },
      type: { type: 'string', description: 'Activity type key (required): call, meeting, task, email, lunch, deadline, etc.' },
      due_date: { type: 'string', description: 'Due date (YYYY-MM-DD)' },
      due_time: { type: 'string', description: 'Due time (HH:MM)' },
      duration: { type: 'string', description: 'Duration (HH:MM)' },
      note: { type: 'string', description: 'Note/description' },
      deal_id: { type: 'number', description: 'Link to a deal' },
      lead_id: { type: 'string', description: 'Link to a lead (UUID)' },
      person_id: { type: 'number', description: 'Link to a person' },
      org_id: { type: 'number', description: 'Link to an organization' },
      user_id: { type: 'number', description: 'Assign to user (assignee)' },
      done: { type: 'boolean', description: 'Mark as done immediately' },
    },
    required: ['subject', 'type'],
  },
  handler: handleCreateActivity,
};

export const updateActivityTool: ToolDefinition = {
  name: 'pipedrive_update_activity',
  description: 'Update an existing activity — mark as done, reschedule, change subject, etc.',
  inputSchema: {
    type: 'object',
    properties: {
      activity_id: { type: 'number', description: 'The activity ID to update' },
      subject: { type: 'string', description: 'New subject' },
      type: { type: 'string', description: 'Activity type key' },
      due_date: { type: 'string', description: 'New due date (YYYY-MM-DD)' },
      due_time: { type: 'string', description: 'New due time (HH:MM)' },
      duration: { type: 'string', description: 'New duration (HH:MM)' },
      note: { type: 'string', description: 'Note/description' },
      deal_id: { type: 'number', description: 'Link to a deal' },
      lead_id: { type: 'string', description: 'Link to a lead (UUID)' },
      person_id: { type: 'number', description: 'Link to a person' },
      org_id: { type: 'number', description: 'Link to an organization' },
      user_id: { type: 'number', description: 'Assign to user' },
      done: { type: 'boolean', description: 'Mark as done or pending' },
    },
    required: ['activity_id'],
  },
  handler: handleUpdateActivity,
};

export const deleteActivityTool: ToolDefinition = {
  name: 'pipedrive_delete_activity',
  description: 'Permanently delete an activity from Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {
      activity_id: { type: 'number', description: 'The activity ID to delete' },
    },
    required: ['activity_id'],
  },
  handler: handleDeleteActivity,
};

// ─── Notes ────────────────────────────────────────────────────────────────────

export const listNotesTool: ToolDefinition = {
  name: 'pipedrive_list_notes',
  description: 'List notes in Pipedrive. Filter by deal, person, organization, or lead.',
  inputSchema: {
    type: 'object',
    properties: {
      deal_id: { type: 'number', description: 'Filter by deal ID' },
      person_id: { type: 'number', description: 'Filter by person ID' },
      org_id: { type: 'number', description: 'Filter by organization ID' },
      lead_id: { type: 'string', description: 'Filter by lead UUID' },
      user_id: { type: 'number', description: 'Filter by author user ID' },
      start_date: { type: 'string', description: 'Notes created from date (YYYY-MM-DD)' },
      end_date: { type: 'string', description: 'Notes created until date (YYYY-MM-DD)' },
      limit: { type: 'number', description: 'Max results per page' },
      start: { type: 'number', description: 'Pagination offset (default: 0)' },
      updated_since: { type: 'string', description: 'Only notes updated at or after this time (RFC3339)' },
    },
  },
  handler: handleListNotes,
};

export const getNoteTool: ToolDefinition = {
  name: 'pipedrive_get_note',
  description: 'Get a single note by ID.',
  inputSchema: {
    type: 'object',
    properties: {
      note_id: { type: 'number', description: 'The note ID' },
    },
    required: ['note_id'],
  },
  handler: handleGetNote,
};

export const createNoteTool: ToolDefinition = {
  name: 'pipedrive_create_note',
  description: 'Create a note in Pipedrive, linked to a deal, person, organization, or lead.',
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Note content in HTML format (required)' },
      deal_id: { type: 'number', description: 'Link to a deal' },
      person_id: { type: 'number', description: 'Link to a person' },
      org_id: { type: 'number', description: 'Link to an organization' },
      lead_id: { type: 'string', description: 'Link to a lead (UUID)' },
      pinned_to_deal_flag: { type: 'boolean', description: 'Pin note to linked deal' },
      pinned_to_person_flag: { type: 'boolean', description: 'Pin note to linked person' },
      pinned_to_org_flag: { type: 'boolean', description: 'Pin note to linked organization' },
    },
    required: ['content'],
  },
  handler: handleCreateNote,
};

export const updateNoteTool: ToolDefinition = {
  name: 'pipedrive_update_note',
  description: 'Update the content or links of an existing note.',
  inputSchema: {
    type: 'object',
    properties: {
      note_id: { type: 'number', description: 'The note ID to update' },
      content: { type: 'string', description: 'New note content in HTML format' },
      deal_id: { type: 'number', description: 'Link to a deal' },
      person_id: { type: 'number', description: 'Link to a person' },
      org_id: { type: 'number', description: 'Link to an organization' },
      lead_id: { type: 'string', description: 'Link to a lead (UUID)' },
      pinned_to_deal_flag: { type: 'boolean', description: 'Pin/unpin note from deal' },
      pinned_to_person_flag: { type: 'boolean', description: 'Pin/unpin note from person' },
      pinned_to_org_flag: { type: 'boolean', description: 'Pin/unpin note from organization' },
    },
    required: ['note_id'],
  },
  handler: handleUpdateNote,
};

export const deleteNoteTool: ToolDefinition = {
  name: 'pipedrive_delete_note',
  description: 'Permanently delete a note from Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {
      note_id: { type: 'number', description: 'The note ID to delete' },
    },
    required: ['note_id'],
  },
  handler: handleDeleteNote,
};

// ─── Pipelines ────────────────────────────────────────────────────────────────

export const listPipelinesTool: ToolDefinition = {
  name: 'pipedrive_list_pipelines',
  description: 'List all pipelines in Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: handleListPipelines,
};

export const getPipelineTool: ToolDefinition = {
  name: 'pipedrive_get_pipeline',
  description: 'Get details for a single pipeline by ID.',
  inputSchema: {
    type: 'object',
    properties: {
      pipeline_id: { type: 'number', description: 'The pipeline ID' },
    },
    required: ['pipeline_id'],
  },
  handler: handleGetPipeline,
};

// ─── Stages ───────────────────────────────────────────────────────────────────

export const createPipelineTool: ToolDefinition = {
  name: 'pipedrive_create_pipeline',
  description: 'Create a new pipeline in Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Pipeline name (required)' },
      order_nr: { type: 'number', description: 'Position order number' },
      active: { type: 'boolean', description: 'Whether the pipeline is active (default: true)' },
    },
    required: ['name'],
  },
  handler: handleCreatePipeline,
};

export const updatePipelineTool: ToolDefinition = {
  name: 'pipedrive_update_pipeline',
  description: 'Update an existing pipeline — rename or reorder.',
  inputSchema: {
    type: 'object',
    properties: {
      pipeline_id: { type: 'number', description: 'The pipeline ID to update' },
      name: { type: 'string', description: 'New pipeline name' },
      order_nr: { type: 'number', description: 'Position order number' },
      active: { type: 'boolean', description: 'Active/inactive' },
    },
    required: ['pipeline_id'],
  },
  handler: handleUpdatePipeline,
};

export const deletePipelineTool: ToolDefinition = {
  name: 'pipedrive_delete_pipeline',
  description: 'Delete a pipeline and all its stages from Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {
      pipeline_id: { type: 'number', description: 'The pipeline ID to delete' },
    },
    required: ['pipeline_id'],
  },
  handler: handleDeletePipeline,
};

export const listStagesTool: ToolDefinition = {
  name: 'pipedrive_list_stages',
  description: 'List pipeline stages. Filter by pipeline to get stages for a specific pipeline.',
  inputSchema: {
    type: 'object',
    properties: {
      pipeline_id: { type: 'number', description: 'Filter stages by pipeline ID' },
    },
  },
  handler: handleListStages,
};

export const getStageTool: ToolDefinition = {
  name: 'pipedrive_get_stage',
  description: 'Get details for a single pipeline stage by ID.',
  inputSchema: {
    type: 'object',
    properties: {
      stage_id: { type: 'number', description: 'The stage ID' },
    },
    required: ['stage_id'],
  },
  handler: handleGetStage,
};

export const createStageTool: ToolDefinition = {
  name: 'pipedrive_create_stage',
  description: 'Create a new stage inside a pipeline.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Stage name (required)' },
      pipeline_id: { type: 'number', description: 'Pipeline ID to add this stage to (required)' },
      order_nr: { type: 'number', description: 'Position order within the pipeline' },
      deal_probability: { type: 'number', description: 'Deal win probability percentage (0-100)' },
      rotten_flag: { type: 'boolean', description: 'Whether deals in this stage can rot' },
      rotten_days: { type: 'number', description: 'Days until a deal becomes rotten' },
    },
    required: ['name', 'pipeline_id'],
  },
  handler: handleCreateStage,
};

export const updateStageTool: ToolDefinition = {
  name: 'pipedrive_update_stage',
  description: 'Update an existing pipeline stage.',
  inputSchema: {
    type: 'object',
    properties: {
      stage_id: { type: 'number', description: 'The stage ID to update' },
      name: { type: 'string', description: 'New stage name' },
      pipeline_id: { type: 'number', description: 'Move stage to a different pipeline' },
      order_nr: { type: 'number', description: 'New position order' },
      deal_probability: { type: 'number', description: 'Deal win probability percentage (0-100)' },
      rotten_flag: { type: 'boolean', description: 'Enable/disable deal rotting' },
      rotten_days: { type: 'number', description: 'Days until a deal becomes rotten' },
    },
    required: ['stage_id'],
  },
  handler: handleUpdateStage,
};

export const deleteStageTool: ToolDefinition = {
  name: 'pipedrive_delete_stage',
  description: 'Delete a stage from a pipeline.',
  inputSchema: {
    type: 'object',
    properties: {
      stage_id: { type: 'number', description: 'The stage ID to delete' },
    },
    required: ['stage_id'],
  },
  handler: handleDeleteStage,
};

// ─── Products ─────────────────────────────────────────────────────────────────

export const listProductsTool: ToolDefinition = {
  name: 'pipedrive_list_products',
  description: 'List all products in Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Max results (default: 100)' },
      cursor: { type: 'string', description: 'Pagination cursor' },
      updated_since: { type: 'string', description: 'Only products updated at or after this time (RFC3339)' },
    },
  },
  handler: handleListProducts,
};

export const getProductTool: ToolDefinition = {
  name: 'pipedrive_get_product',
  description: 'Get full details for a single product by ID.',
  inputSchema: {
    type: 'object',
    properties: {
      product_id: { type: 'number', description: 'The product ID' },
    },
    required: ['product_id'],
  },
  handler: handleGetProduct,
};

export const createProductTool: ToolDefinition = {
  name: 'pipedrive_create_product',
  description: 'Create a new product in Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Product name (required)' },
      code: { type: 'string', description: 'Product code / SKU' },
      description: { type: 'string', description: 'Product description' },
      unit: { type: 'string', description: 'Unit of measurement' },
      tax: { type: 'number', description: 'Tax percentage (e.g. 20 for 20%)' },
      active_flag: { type: 'boolean', description: 'Whether the product is active (default: true)' },
      owner_id: { type: 'number', description: 'Owner user ID' },
      prices: {
        type: 'array',
        description: 'Price list — array of { price, currency, cost?, overhead_cost? }',
        items: {
          type: 'object',
          properties: {
            price: { type: 'number' },
            currency: { type: 'string' },
          },
        },
      },
    },
    required: ['name'],
  },
  handler: handleCreateProduct,
};

export const updateProductTool: ToolDefinition = {
  name: 'pipedrive_update_product',
  description: 'Update an existing product in Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {
      product_id: { type: 'number', description: 'The product ID to update' },
      name: { type: 'string', description: 'New product name' },
      code: { type: 'string', description: 'New product code / SKU' },
      description: { type: 'string', description: 'New description' },
      unit: { type: 'string', description: 'Unit of measurement' },
      tax: { type: 'number', description: 'Tax percentage' },
      active_flag: { type: 'boolean', description: 'Active/inactive' },
      owner_id: { type: 'number', description: 'Owner user ID' },
      prices: {
        type: 'array',
        items: { type: 'object', properties: { price: { type: 'number' }, currency: { type: 'string' } } },
      },
    },
    required: ['product_id'],
  },
  handler: handleUpdateProduct,
};

export const deleteProductTool: ToolDefinition = {
  name: 'pipedrive_delete_product',
  description: 'Permanently delete a product from Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {
      product_id: { type: 'number', description: 'The product ID to delete' },
    },
    required: ['product_id'],
  },
  handler: handleDeleteProduct,
};

// ─── Global Search ────────────────────────────────────────────────────────────

export const searchTool: ToolDefinition = {
  name: 'pipedrive_search',
  description: 'Search across all Pipedrive item types (deals, persons, organizations, leads, products, files) in one query.',
  inputSchema: {
    type: 'object',
    properties: {
      term: { type: 'string', description: 'Search term (min 2 chars, or 1 with exact_match)' },
      item_types: {
        type: 'string',
        description: 'Comma-separated item types to search: deal, person, organization, product, lead, file, mail_attachment, project',
      },
      fields: {
        type: 'string',
        description: 'Comma-separated fields to search within (default: all)',
      },
      exact_match: { type: 'boolean', description: 'Only return exact full matches (case-insensitive)' },
      limit: { type: 'number', description: 'Max results (default: 100, max: 100)' },
      cursor: { type: 'string', description: 'Pagination cursor' },
    },
    required: ['term'],
  },
  handler: handleSearch,
};

// ─── Users ────────────────────────────────────────────────────────────────────

export const listUsersTool: ToolDefinition = {
  name: 'pipedrive_list_users',
  description: 'List all users in the Pipedrive account.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: handleListUsers,
};

export const getCurrentUserTool: ToolDefinition = {
  name: 'pipedrive_get_current_user',
  description: 'Get details of the currently authenticated Pipedrive user.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: handleGetCurrentUser,
};

// ─── Deal Participants ────────────────────────────────────────────────────────

export const listDealParticipantsTool: ToolDefinition = {
  name: 'pipedrive_list_deal_participants',
  description: 'List all persons who are participants (not the main contact) in a deal.',
  inputSchema: {
    type: 'object',
    properties: {
      deal_id: { type: 'number', description: 'The deal ID' },
      limit: { type: 'number', description: 'Max results' },
      start: { type: 'number', description: 'Pagination offset' },
    },
    required: ['deal_id'],
  },
  handler: handleListDealParticipants,
};

export const addDealParticipantTool: ToolDefinition = {
  name: 'pipedrive_add_deal_participant',
  description: 'Add a person as a participant to a deal.',
  inputSchema: {
    type: 'object',
    properties: {
      deal_id: { type: 'number', description: 'The deal ID' },
      person_id: { type: 'number', description: 'The person ID to add as participant' },
    },
    required: ['deal_id', 'person_id'],
  },
  handler: handleAddDealParticipant,
};

export const deleteDealParticipantTool: ToolDefinition = {
  name: 'pipedrive_delete_deal_participant',
  description: 'Remove a participant from a deal.',
  inputSchema: {
    type: 'object',
    properties: {
      deal_id: { type: 'number', description: 'The deal ID' },
      participant_id: { type: 'number', description: 'The participant ID (from list_deal_participants)' },
    },
    required: ['deal_id', 'participant_id'],
  },
  handler: handleDeleteDealParticipant,
};

// ─── Deal Products ────────────────────────────────────────────────────────────

export const listDealProductsTool: ToolDefinition = {
  name: 'pipedrive_list_deal_products',
  description: 'List all products attached to a deal.',
  inputSchema: {
    type: 'object',
    properties: {
      deal_id: { type: 'number', description: 'The deal ID' },
      limit: { type: 'number', description: 'Max results' },
      start: { type: 'number', description: 'Pagination offset' },
    },
    required: ['deal_id'],
  },
  handler: handleListDealProducts,
};

export const addDealProductTool: ToolDefinition = {
  name: 'pipedrive_add_deal_product',
  description: 'Attach a product to a deal with price and quantity.',
  inputSchema: {
    type: 'object',
    properties: {
      deal_id: { type: 'number', description: 'The deal ID' },
      product_id: { type: 'number', description: 'The product ID' },
      item_price: { type: 'number', description: 'Unit price for this line item (required)' },
      quantity: { type: 'number', description: 'Quantity (default: 1)' },
      discount: { type: 'number', description: 'Discount amount or percentage' },
      discount_type: { type: 'string', enum: ['percentage', 'amount'], description: 'Discount type' },
      tax: { type: 'number', description: 'Tax percentage' },
      comments: { type: 'string', description: 'Line item notes' },
    },
    required: ['deal_id', 'product_id', 'item_price'],
  },
  handler: handleAddDealProduct,
};

export const updateDealProductTool: ToolDefinition = {
  name: 'pipedrive_update_deal_product',
  description: 'Update a product line item on a deal (price, quantity, discount).',
  inputSchema: {
    type: 'object',
    properties: {
      deal_id: { type: 'number', description: 'The deal ID' },
      product_attachment_id: { type: 'number', description: 'The product attachment ID (from list_deal_products)' },
      item_price: { type: 'number', description: 'New unit price' },
      quantity: { type: 'number', description: 'New quantity' },
      discount: { type: 'number', description: 'Discount amount or percentage' },
      discount_type: { type: 'string', enum: ['percentage', 'amount'] },
      tax: { type: 'number', description: 'Tax percentage' },
      comments: { type: 'string', description: 'Line item notes' },
      enabled_flag: { type: 'boolean', description: 'Whether this line item is enabled' },
    },
    required: ['deal_id', 'product_attachment_id'],
  },
  handler: handleUpdateDealProduct,
};

export const deleteDealProductTool: ToolDefinition = {
  name: 'pipedrive_delete_deal_product',
  description: 'Remove a product from a deal.',
  inputSchema: {
    type: 'object',
    properties: {
      deal_id: { type: 'number', description: 'The deal ID' },
      product_attachment_id: { type: 'number', description: 'The product attachment ID (from list_deal_products)' },
    },
    required: ['deal_id', 'product_attachment_id'],
  },
  handler: handleDeleteDealProduct,
};

// ─── Activity Types ───────────────────────────────────────────────────────────

export const listActivityTypesTool: ToolDefinition = {
  name: 'pipedrive_list_activity_types',
  description: 'List all activity types configured in Pipedrive (call, meeting, task, email, etc.).',
  inputSchema: { type: 'object', properties: {} },
  handler: handleListActivityTypes,
};

// ─── Custom Fields ────────────────────────────────────────────────────────────

export const listDealFieldsTool: ToolDefinition = {
  name: 'pipedrive_list_deal_fields',
  description: 'List all deal fields (both built-in and custom) in Pipedrive.',
  inputSchema: { type: 'object', properties: {} },
  handler: handleListDealFields,
};

export const listPersonFieldsTool: ToolDefinition = {
  name: 'pipedrive_list_person_fields',
  description: 'List all person fields (both built-in and custom) in Pipedrive.',
  inputSchema: { type: 'object', properties: {} },
  handler: handleListPersonFields,
};

export const listOrganizationFieldsTool: ToolDefinition = {
  name: 'pipedrive_list_organization_fields',
  description: 'List all organization fields (both built-in and custom) in Pipedrive.',
  inputSchema: { type: 'object', properties: {} },
  handler: handleListOrganizationFields,
};

export const listProductFieldsTool: ToolDefinition = {
  name: 'pipedrive_list_product_fields',
  description: 'List all product fields (both built-in and custom) in Pipedrive.',
  inputSchema: { type: 'object', properties: {} },
  handler: handleListProductFields,
};

// ─── Currencies ───────────────────────────────────────────────────────────────

export const listCurrenciesTool: ToolDefinition = {
  name: 'pipedrive_list_currencies',
  description: 'List all supported currencies in Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {
      term: { type: 'string', description: 'Filter currencies by name or code (e.g. "USD", "Euro")' },
    },
  },
  handler: handleListCurrencies,
};

// ─── Filters ─────────────────────────────────────────────────────────────────

export const listFiltersTool: ToolDefinition = {
  name: 'pipedrive_list_filters',
  description: 'List saved filters in Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['deals', 'leads', 'org', 'people', 'products', 'activity'],
        description: 'Filter by object type',
      },
    },
  },
  handler: handleListFilters,
};

export const getFilterTool: ToolDefinition = {
  name: 'pipedrive_get_filter',
  description: 'Get details for a single saved filter by ID.',
  inputSchema: {
    type: 'object',
    properties: {
      filter_id: { type: 'number', description: 'The filter ID' },
    },
    required: ['filter_id'],
  },
  handler: handleGetFilter,
};

export const deleteFilterTool: ToolDefinition = {
  name: 'pipedrive_delete_filter',
  description: 'Delete a saved filter.',
  inputSchema: {
    type: 'object',
    properties: {
      filter_id: { type: 'number', description: 'The filter ID to delete' },
    },
    required: ['filter_id'],
  },
  handler: handleDeleteFilter,
};

// ─── Goals ────────────────────────────────────────────────────────────────────

export const listGoalsTool: ToolDefinition = {
  name: 'pipedrive_list_goals',
  description: 'Search/list goals in Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {
      type_name: { type: 'string', description: 'Goal type: deals_won, deals_progressed, activities_completed, activities_added, revenue_forecast' },
      assignee_id: { type: 'number', description: 'Filter by assignee user ID' },
      assignee_type: { type: 'string', enum: ['person', 'company', 'team'], description: 'Assignee type' },
      is_active: { type: 'boolean', description: 'Filter by active status' },
    },
  },
  handler: handleListGoals,
};

export const addGoalTool: ToolDefinition = {
  name: 'pipedrive_create_goal',
  description: 'Create a new goal in Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Goal title (required)' },
      assignee: {
        type: 'object',
        description: '{ id: number, type: "person"|"company"|"team" }',
        properties: { id: { type: 'number' }, type: { type: 'string' } },
      },
      type: {
        type: 'object',
        description: '{ name: "deals_won"|"deals_progressed"|"activities_completed"|"activities_added"|"revenue_forecast", params: object }',
        properties: { name: { type: 'string' }, params: { type: 'object' } },
      },
      expected_outcome: {
        type: 'object',
        description: '{ target: number, tracking_metric: "quantity"|"sum", currency_id: number }',
        properties: { target: { type: 'number' }, tracking_metric: { type: 'string' }, currency_id: { type: 'number' } },
      },
      duration: {
        type: 'object',
        description: '{ start: "YYYY-MM-DD", end: "YYYY-MM-DD" }',
        properties: { start: { type: 'string' }, end: { type: 'string' } },
      },
      interval: { type: 'string', enum: ['weekly', 'monthly', 'quarterly', 'yearly'], description: 'Reporting interval' },
    },
    required: ['title'],
  },
  handler: handleAddGoal,
};

export const updateGoalTool: ToolDefinition = {
  name: 'pipedrive_update_goal',
  description: 'Update an existing goal.',
  inputSchema: {
    type: 'object',
    properties: {
      goal_id: { type: 'string', description: 'The goal ID (UUID)' },
      title: { type: 'string', description: 'New title' },
      expected_outcome: { type: 'object', description: '{ target: number, tracking_metric: string, currency_id: number }' },
      duration: { type: 'object', description: '{ start: "YYYY-MM-DD", end: "YYYY-MM-DD" }' },
    },
    required: ['goal_id'],
  },
  handler: handleUpdateGoal,
};

export const deleteGoalTool: ToolDefinition = {
  name: 'pipedrive_delete_goal',
  description: 'Delete a goal.',
  inputSchema: {
    type: 'object',
    properties: {
      goal_id: { type: 'string', description: 'The goal UUID to delete' },
    },
    required: ['goal_id'],
  },
  handler: handleDeleteGoal,
};

// ─── Projects ─────────────────────────────────────────────────────────────────

export const listProjectsTool: ToolDefinition = {
  name: 'pipedrive_list_projects',
  description: 'List projects in Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['open', 'completed', 'canceled', 'deleted'], description: 'Filter by status' },
      phase_id: { type: 'number', description: 'Filter by phase ID' },
      deal_id: { type: 'number', description: 'Filter by linked deal' },
      person_id: { type: 'number', description: 'Filter by linked person' },
      org_id: { type: 'number', description: 'Filter by linked organization' },
      limit: { type: 'number', description: 'Max results (default: 100)' },
      cursor: { type: 'string', description: 'Pagination cursor' },
    },
  },
  handler: handleListProjects,
};

export const getProjectTool: ToolDefinition = {
  name: 'pipedrive_get_project',
  description: 'Get details for a single project by ID.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'number', description: 'The project ID' },
    },
    required: ['project_id'],
  },
  handler: handleGetProject,
};

export const createProjectTool: ToolDefinition = {
  name: 'pipedrive_create_project',
  description: 'Create a new project in Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Project title (required)' },
      board_id: { type: 'number', description: 'Board ID' },
      phase_id: { type: 'number', description: 'Phase ID' },
      description: { type: 'string', description: 'Project description' },
      status: { type: 'string', enum: ['open', 'completed', 'canceled'], description: 'Project status' },
      owner_id: { type: 'number', description: 'Owner user ID' },
      start_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
      end_date: { type: 'string', description: 'End date (YYYY-MM-DD)' },
      deal_ids: { type: 'array', items: { type: 'number' }, description: 'Deal IDs to link' },
      person_ids: { type: 'array', items: { type: 'number' }, description: 'Person IDs to link' },
      org_ids: { type: 'array', items: { type: 'number' }, description: 'Organization IDs to link' },
    },
    required: ['title'],
  },
  handler: handleCreateProject,
};

export const updateProjectTool: ToolDefinition = {
  name: 'pipedrive_update_project',
  description: 'Update an existing project.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'number', description: 'The project ID to update' },
      title: { type: 'string', description: 'New title' },
      phase_id: { type: 'number', description: 'New phase ID' },
      description: { type: 'string', description: 'New description' },
      status: { type: 'string', enum: ['open', 'completed', 'canceled'] },
      owner_id: { type: 'number', description: 'New owner user ID' },
      start_date: { type: 'string', description: 'New start date (YYYY-MM-DD)' },
      end_date: { type: 'string', description: 'New end date (YYYY-MM-DD)' },
    },
    required: ['project_id'],
  },
  handler: handleUpdateProject,
};

export const deleteProjectTool: ToolDefinition = {
  name: 'pipedrive_delete_project',
  description: 'Delete a project.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'number', description: 'The project ID to delete' },
    },
    required: ['project_id'],
  },
  handler: handleDeleteProject,
};

// ─── Tasks ────────────────────────────────────────────────────────────────────

export const listTasksTool: ToolDefinition = {
  name: 'pipedrive_list_tasks',
  description: 'List tasks in Pipedrive (project tasks). Filter by project, assignee, or completion status.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'number', description: 'Filter by project ID' },
      assignee_id: { type: 'number', description: 'Filter by assignee user ID' },
      is_done: { type: 'boolean', description: 'true = completed, false = pending' },
      is_milestone: { type: 'boolean', description: 'Filter milestone tasks' },
      parent_task_id: { type: 'string', description: 'Filter subtasks by parent ID (use "null" for root tasks)' },
      limit: { type: 'number', description: 'Max results (default: 100)' },
      cursor: { type: 'string', description: 'Pagination cursor' },
    },
  },
  handler: handleListTasks,
};

export const getTaskTool: ToolDefinition = {
  name: 'pipedrive_get_task',
  description: 'Get details for a single task by ID.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'number', description: 'The task ID' },
    },
    required: ['task_id'],
  },
  handler: handleGetTask,
};

export const createTaskTool: ToolDefinition = {
  name: 'pipedrive_create_task',
  description: 'Create a new task inside a project.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Task title (required)' },
      project_id: { type: 'number', description: 'Project ID (required)' },
      description: { type: 'string', description: 'Task description' },
      assignee_id: { type: 'number', description: 'Assigned user ID' },
      due_date: { type: 'string', description: 'Due date (YYYY-MM-DD)' },
      is_milestone: { type: 'boolean', description: 'Mark as a milestone' },
      parent_task_id: { type: 'number', description: 'Parent task ID for subtasks' },
    },
    required: ['title', 'project_id'],
  },
  handler: handleCreateTask,
};

export const updateTaskTool: ToolDefinition = {
  name: 'pipedrive_update_task',
  description: 'Update a task — mark done, change assignee, reschedule, etc.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'number', description: 'The task ID to update' },
      title: { type: 'string', description: 'New title' },
      description: { type: 'string', description: 'New description' },
      assignee_id: { type: 'number', description: 'New assignee user ID' },
      due_date: { type: 'string', description: 'New due date (YYYY-MM-DD)' },
      is_done: { type: 'boolean', description: 'Mark as done or undone' },
      is_milestone: { type: 'boolean', description: 'Toggle milestone status' },
    },
    required: ['task_id'],
  },
  handler: handleUpdateTask,
};

export const deleteTaskTool: ToolDefinition = {
  name: 'pipedrive_delete_task',
  description: 'Delete a task.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'number', description: 'The task ID to delete' },
    },
    required: ['task_id'],
  },
  handler: handleDeleteTask,
};

// ─── Webhooks ─────────────────────────────────────────────────────────────────

export const listWebhooksTool: ToolDefinition = {
  name: 'pipedrive_list_webhooks',
  description: 'List all webhooks configured for this Pipedrive account.',
  inputSchema: { type: 'object', properties: {} },
  handler: handleListWebhooks,
};

export const createWebhookTool: ToolDefinition = {
  name: 'pipedrive_create_webhook',
  description: 'Create a new webhook to receive Pipedrive event notifications at a URL.',
  inputSchema: {
    type: 'object',
    properties: {
      subscription_url: { type: 'string', description: 'The HTTPS URL to receive webhook events (required)' },
      event_action: {
        type: 'string',
        enum: ['added', 'updated', 'merged', 'deleted', 'transferred', '*'],
        description: 'The action to subscribe to (required). Use * for all.',
      },
      event_object: {
        type: 'string',
        enum: ['activity', 'activityType', 'deal', 'note', 'organization', 'person', 'pipeline', 'product', 'stage', 'user', '*'],
        description: 'The object type to subscribe to (required). Use * for all.',
      },
      user_id: { type: 'number', description: 'Filter events to a specific user ID' },
      http_auth_user: { type: 'string', description: 'HTTP Basic auth username for the webhook endpoint' },
      http_auth_password: { type: 'string', description: 'HTTP Basic auth password for the webhook endpoint' },
    },
    required: ['subscription_url', 'event_action', 'event_object'],
  },
  handler: handleCreateWebhook,
};

export const deleteWebhookTool: ToolDefinition = {
  name: 'pipedrive_delete_webhook',
  description: 'Delete a webhook subscription.',
  inputSchema: {
    type: 'object',
    properties: {
      webhook_id: { type: 'number', description: 'The webhook ID to delete' },
    },
    required: ['webhook_id'],
  },
  handler: handleDeleteWebhook,
};

// ─── Organization Relationships ───────────────────────────────────────────────

export const listOrgRelationshipsTool: ToolDefinition = {
  name: 'pipedrive_list_org_relationships',
  description: 'List relationships (parent, subsidiary, related) for an organization.',
  inputSchema: {
    type: 'object',
    properties: {
      org_id: { type: 'number', description: 'The organization ID' },
    },
    required: ['org_id'],
  },
  handler: handleListOrgRelationships,
};

export const createOrgRelationshipTool: ToolDefinition = {
  name: 'pipedrive_create_org_relationship',
  description: 'Create a relationship between two organizations (parent/subsidiary/related).',
  inputSchema: {
    type: 'object',
    properties: {
      org_id: { type: 'number', description: 'The organization this relationship belongs to' },
      type: { type: 'string', enum: ['parent', 'subsidiary', 'related'], description: 'Relationship type (required)' },
      rel_owner_org_id: { type: 'number', description: 'ID of the owning organization (required)' },
      rel_linked_org_id: { type: 'number', description: 'ID of the linked organization (required)' },
    },
    required: ['org_id', 'type', 'rel_owner_org_id', 'rel_linked_org_id'],
  },
  handler: handleCreateOrgRelationship,
};

export const deleteOrgRelationshipTool: ToolDefinition = {
  name: 'pipedrive_delete_org_relationship',
  description: 'Delete an organization relationship.',
  inputSchema: {
    type: 'object',
    properties: {
      relationship_id: { type: 'number', description: 'The relationship ID to delete' },
    },
    required: ['relationship_id'],
  },
  handler: handleDeleteOrgRelationship,
};

// ─── Files ────────────────────────────────────────────────────────────────────

export const listFilesTool: ToolDefinition = {
  name: 'pipedrive_list_files',
  description: 'List all files attached to the Pipedrive account.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Max results' },
      start: { type: 'number', description: 'Pagination offset' },
      sort: { type: 'string', description: 'Sort field and direction (e.g. "id DESC")' },
    },
  },
  handler: handleListFiles,
};

export const getFileTool: ToolDefinition = {
  name: 'pipedrive_get_file',
  description: 'Get metadata for a single file by ID.',
  inputSchema: {
    type: 'object',
    properties: {
      file_id: { type: 'number', description: 'The file ID' },
    },
    required: ['file_id'],
  },
  handler: handleGetFile,
};

export const deleteFileTool: ToolDefinition = {
  name: 'pipedrive_delete_file',
  description: 'Delete a file from Pipedrive.',
  inputSchema: {
    type: 'object',
    properties: {
      file_id: { type: 'number', description: 'The file ID to delete' },
    },
    required: ['file_id'],
  },
  handler: handleDeleteFile,
};

// ─── Sub-resource queries ─────────────────────────────────────────────────────

export const listPersonDealsTool: ToolDefinition = {
  name: 'pipedrive_list_person_deals',
  description: 'List all deals associated with a specific person.',
  inputSchema: {
    type: 'object',
    properties: {
      person_id: { type: 'number', description: 'The person ID' },
      status: { type: 'string', enum: ['open', 'won', 'lost', 'deleted'], description: 'Filter by deal status' },
      limit: { type: 'number', description: 'Max results' },
      start: { type: 'number', description: 'Pagination offset' },
    },
    required: ['person_id'],
  },
  handler: handleListPersonDeals,
};

export const listOrganizationDealsTool: ToolDefinition = {
  name: 'pipedrive_list_organization_deals',
  description: 'List all deals associated with a specific organization.',
  inputSchema: {
    type: 'object',
    properties: {
      org_id: { type: 'number', description: 'The organization ID' },
      status: { type: 'string', enum: ['open', 'won', 'lost', 'deleted'], description: 'Filter by deal status' },
      limit: { type: 'number', description: 'Max results' },
      start: { type: 'number', description: 'Pagination offset' },
    },
    required: ['org_id'],
  },
  handler: handleListOrganizationDeals,
};

export const listOrganizationPersonsTool: ToolDefinition = {
  name: 'pipedrive_list_organization_persons',
  description: 'List all persons (contacts) belonging to an organization.',
  inputSchema: {
    type: 'object',
    properties: {
      org_id: { type: 'number', description: 'The organization ID' },
      limit: { type: 'number', description: 'Max results' },
      start: { type: 'number', description: 'Pagination offset' },
    },
    required: ['org_id'],
  },
  handler: handleListOrganizationPersons,
};

export const listDealActivitiesTool: ToolDefinition = {
  name: 'pipedrive_list_deal_activities',
  description: 'List all activities linked to a specific deal.',
  inputSchema: {
    type: 'object',
    properties: {
      deal_id: { type: 'number', description: 'The deal ID' },
      done: { type: 'number', enum: [0, 1], description: '0 = pending, 1 = done' },
      limit: { type: 'number', description: 'Max results' },
      start: { type: 'number', description: 'Pagination offset' },
    },
    required: ['deal_id'],
  },
  handler: handleListDealActivities,
};

export const listDealNotesTool: ToolDefinition = {
  name: 'pipedrive_list_deal_notes',
  description: 'List all notes linked to a specific deal.',
  inputSchema: {
    type: 'object',
    properties: {
      deal_id: { type: 'number', description: 'The deal ID' },
    },
    required: ['deal_id'],
  },
  handler: handleListDealNotes,
};

// ─── Collected array ──────────────────────────────────────────────────────────

export const pipedriveTools: ToolDefinition[] = [
  // Deals
  listDealsTool,
  getDealTool,
  searchDealsTool,
  createDealTool,
  updateDealTool,
  deleteDealTool,
  // Persons
  listPersonsTool,
  getPersonTool,
  searchPersonsTool,
  createPersonTool,
  updatePersonTool,
  deletePersonTool,
  // Organizations
  listOrganizationsTool,
  getOrganizationTool,
  searchOrganizationsTool,
  createOrganizationTool,
  updateOrganizationTool,
  deleteOrganizationTool,
  // Leads
  listLeadsTool,
  getLeadTool,
  createLeadTool,
  updateLeadTool,
  deleteLeadTool,
  convertLeadTool,
  getLeadConversionStatusTool,
  // Activities
  listActivitiesTool,
  getActivityTool,
  createActivityTool,
  updateActivityTool,
  deleteActivityTool,
  // Notes
  listNotesTool,
  getNoteTool,
  createNoteTool,
  updateNoteTool,
  deleteNoteTool,
  // Pipelines
  listPipelinesTool,
  getPipelineTool,
  createPipelineTool,
  updatePipelineTool,
  deletePipelineTool,
  // Stages
  listStagesTool,
  getStageTool,
  createStageTool,
  updateStageTool,
  deleteStageTool,
  // Products
  listProductsTool,
  getProductTool,
  createProductTool,
  updateProductTool,
  deleteProductTool,
  // Search
  searchTool,
  // Users
  listUsersTool,
  getCurrentUserTool,
  // Deal Participants
  listDealParticipantsTool,
  addDealParticipantTool,
  deleteDealParticipantTool,
  // Deal Products
  listDealProductsTool,
  addDealProductTool,
  updateDealProductTool,
  deleteDealProductTool,
  // Activity Types
  listActivityTypesTool,
  // Custom Fields
  listDealFieldsTool,
  listPersonFieldsTool,
  listOrganizationFieldsTool,
  listProductFieldsTool,
  // Currencies
  listCurrenciesTool,
  // Filters
  listFiltersTool,
  getFilterTool,
  deleteFilterTool,
  // Goals
  listGoalsTool,
  addGoalTool,
  updateGoalTool,
  deleteGoalTool,
  // Projects
  listProjectsTool,
  getProjectTool,
  createProjectTool,
  updateProjectTool,
  deleteProjectTool,
  // Tasks
  listTasksTool,
  getTaskTool,
  createTaskTool,
  updateTaskTool,
  deleteTaskTool,
  // Webhooks
  listWebhooksTool,
  createWebhookTool,
  deleteWebhookTool,
  // Org Relationships
  listOrgRelationshipsTool,
  createOrgRelationshipTool,
  deleteOrgRelationshipTool,
  // Files
  listFilesTool,
  getFileTool,
  deleteFileTool,
  // Sub-resource queries
  listPersonDealsTool,
  listOrganizationDealsTool,
  listOrganizationPersonsTool,
  listDealActivitiesTool,
  listDealNotesTool,
];
