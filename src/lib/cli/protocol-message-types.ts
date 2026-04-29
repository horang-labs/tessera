export interface CliControlRequestPayload {
  subtype: string;
  tool_name?: string;
  input?: Record<string, any>;
  tool_use_id?: string;
  permission_suggestions?: any[];
  decision_reason?: string;
  agent_id?: string;
}

export interface CliControlResponsePayload {
  subtype?: string;
  request_id?: string;
  response?: Record<string, any>;
  error?: string;
}

export interface CliStreamEventContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: any;
}

export interface CliStreamEventDelta {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  partial_json?: string;
  stop_reason?: string;
}

export interface CliStreamEventPayload {
  type:
    | 'message_start'
    | 'content_block_start'
    | 'content_block_delta'
    | 'content_block_stop'
    | 'message_delta'
    | 'message_stop';
  index?: number;
  content_block?: CliStreamEventContentBlock;
  delta?: CliStreamEventDelta;
  message?: any;
}

export type CliMessage = {
  type:
    | 'system'
    | 'assistant'
    | 'progress'
    | 'result'
    | 'user'
    | 'tool_result'
    | 'control_request'
    | 'control_response'
    | 'stream_event';
  session_id: string;
  uuid: string;
  timestamp?: string;
  subtype?: string;
  message?: any;
  data?: any;
  tool_use_id?: string;
  request_id?: string;
  request?: CliControlRequestPayload;
  response?: CliControlResponsePayload;
  event?: CliStreamEventPayload;
  parent_tool_use_id?: string | null;
};
